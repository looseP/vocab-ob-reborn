/**
 * WordService — word listing, search, and detail retrieval.
 *
 * M1 fix: getWordBySlug uses NotFoundError (AppError subclass) instead
 * of an anonymous Error class, so errorToResponse correctly maps to 404.
 */

import type { PoolClient } from "pg";
import type { IRepositories, IWordRepository } from "../repositories/interfaces";
import type { PaginatedResult, WordSummary } from "../domain";
import { Word } from "../domain/word.entity";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { plazaCache } from "./plaza-cache";
import type { L3DeleteResult } from "../schemas/service";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

export interface GetWordsParams {
  userId: string;
  q?: string;
  review?: string;
  cefr?: string;
  wordbookId?: string;
  limit: number;
  offset: number;
}

export class WordService {
  constructor(
    private readonly words: IWordRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  async getPublicWords(params: GetWordsParams): Promise<PaginatedResult<WordSummary>> {
    return this.txRunner(async (tx) => {
      const words = this.repositoryFactory(tx).words;
      return words.findPublic({
        filters: {
          q: params.q,
          review: params.review,
          cefr: params.cefr,
        },
        pagination: { limit: params.limit, offset: params.offset },
        userId: params.userId,
        wordbookId: params.wordbookId,
      });
    }, { actorId: params.userId });
  }

  async getWordBySlug(slug: string, userId?: string): Promise<{ word: Word; l2Promoted: boolean }> {
    const row = await this.words.findBySlug(slug);
    if (!row) {
      // M1 fix: use NotFoundError (AppError subclass) → errorToResponse maps to 404
      throw new NotFoundError("Word", slug);
    }
    if (!userId) return { word: new Word(row), l2Promoted: false };
    // Phase C 业务联动：详情页"待扩展"提示需要知道该词是否已进入 L2 训练轨道。
    // user_word_l2_progress 是 owner-RLS 表——EXISTS 必须在携带
    // request.jwt.claim.sub 的事务里执行（裸池连接会被 RLS 过滤成 false，
    // 同词汇广场 getCollection 教训①）。
    const l2Promoted = await this.txRunner(
      async (tx) => this.repositoryFactory(tx).l2Progress.existsByUserAndWord(userId, row.id),
      { actorId: userId },
    );
    return { word: new Word(row), l2Promoted };
  }

  /** 输入联想（L1-2）：读侧接口，直接走注入仓库，无需事务。 */
  async suggestWords(q: string, limit = 8): Promise<WordSummary[]> {
    return this.words.suggest(q, limit);
  }

  async getWordCount(): Promise<number> {
    return this.words.count();
  }

  async getAllSlugs(limit?: number): Promise<string[]> {
    return this.words.findSlugs(limit);
  }

  async batchCreate(words: Array<{
    slug: string; title: string; lemma: string; pos: string | null;
    cefr: string | null; ipa: string | null; short_definition: string | null;
  }>): Promise<{ inserted: number }> {
    if (!this.words.insertMany) throw new Error("insertMany not configured");
    const count = await this.words.insertMany(words);
    // P4 性能：批量写词后清空广场聚合缓存。
    plazaCache.invalidateAll();
    return { inserted: count };
  }

  /**
   * 详情页硬删 stub 词条（0023，stub 生命周期）。
   * 阻塞（409 + blockers）：绑定 L3 语境 / 用户笔记 / 入站语境链接；
   * 随删（FK 级联）：复习进度（无移除出口且本就是待清理的污染）、词单成员、高亮批注。
   * stub 谓词 definition_md='' 由锁行查询、守卫 DELETE 与 DB 触发器三层兜底。
   */
  async deleteStubWord(input: { slug: string; userId: string }): Promise<L3DeleteResult> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.slug, "slug");

    const row = await this.words.findBySlug(input.slug);
    if (!row) {
      throw new NotFoundError("Word", input.slug);
    }
    if (row.definition_md !== "") {
      throw new ConflictError("仅生词 stub（无释义内容）可删除");
    }

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const word = await repos.words.lockStubWordById(row.id);
      if (!word) {
        // 预检后行被并发补全内容或下架 → 与 404 同语义
        throw new NotFoundError("Word", input.slug);
      }

      // 与建链（createContextLink word 目标）共用 l3:active-target 锁，防建链-删词竞态
      await repos.l3Context.lockActiveL3TargetReference(input.userId, "word", word.id);
      const blockers = await repos.words.getWordDeleteBlockers(input.userId, word.id);
      if (
        blockers.l3OccurrenceCount > 0 ||
        blockers.noteEntryCount > 0 ||
        blockers.inboundWordLinkCount > 0
      ) {
        throw new ConflictError("Cannot delete word with active dependencies", undefined, {
          entityType: "word",
          id: word.id,
          blockers,
        });
      }

      const deleted = await repos.words.deleteWordById(input.userId, word.id);
      if (!deleted) {
        const current = await repos.words.findById(word.id);
        if (!current) {
          throw new NotFoundError("Word", input.slug);
        }
        const latestBlockers = await repos.words.getWordDeleteBlockers(input.userId, word.id);
        throw new ConflictError("Cannot delete word with active dependencies", undefined, {
          entityType: "word",
          id: word.id,
          blockers: latestBlockers,
        });
      }

      return {
        deleted: { entityType: "word", id: deleted.id },
        activeReadInvalidation: true,
      };
    }, { actorId: input.userId });
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (!value || value.trim().length === 0) {
    throw new ValidationError(`${field} is required`, field);
  }
}
