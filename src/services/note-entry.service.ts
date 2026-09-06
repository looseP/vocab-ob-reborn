/**
 * NoteEntryService — 条目制笔记(2026-09-06)。
 *
 * 与遗留文档模型(NoteService/notes 表)的区别:追加式写入,无乐观锁、无 409、
 * 无版本快照链。非破坏管理 = hide/restore;破坏性删除仅详情页入口(确认保护)。
 *
 * 所有读写都包在 actorId 事务里以满足 note_entries 表 RLS(auth.uid() = user_id)。
 */

import type { PoolClient } from "pg";
import type { INoteEntryRepository, IRepositories, IWordbookRepository } from "../repositories/interfaces";
import type { NoteEntryRow } from "../domain";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import { NotFoundError } from "../errors";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

export class NoteEntryService {
  constructor(
    private readonly noteEntries: INoteEntryRepository,
    private readonly wordbooks: IWordbookRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  private withActorEntries<T>(
    userId: string,
    callback: (noteEntries: INoteEntryRepository) => Promise<T>,
  ): Promise<T> {
    return this.txRunner(
      async (tx) => callback(this.repositoryFactory(tx).noteEntries),
      { actorId: userId },
    );
  }

  /** 词的全部条目(含已隐藏),创建时间正序;详情页条目管理用。 */
  async getEntries(
    userId: string,
    wordId: string,
    wordbookId: string,
  ): Promise<NoteEntryRow[]> {
    return this.withActorEntries(userId, (entries) =>
      entries.listByWord(userId, wordbookId, wordId),
    );
  }

  async addEntry(
    userId: string,
    wordId: string,
    contentMd: string,
    wordbookId?: string,
  ): Promise<NoteEntryRow> {
    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      // getOrCreateDefault 在事务内:新建词书与插入条目原子
      const resolvedWordbookId = wordbookId
        ?? (await repos.wordbooks.getOrCreateDefault(userId)).id;
      return repos.noteEntries.insert(userId, resolvedWordbookId, wordId, contentMd);
    }, { actorId: userId });
  }

  async editEntry(userId: string, entryId: string, contentMd: string): Promise<NoteEntryRow> {
    return this.withActorEntries(userId, async (entries) => {
      const entry = await entries.updateContent(userId, entryId, contentMd);
      if (!entry) throw new NotFoundError("NoteEntry", entryId);
      return entry;
    });
  }

  async hideEntry(userId: string, entryId: string): Promise<NoteEntryRow> {
    return this.withActorEntries(userId, async (entries) => {
      const entry = await entries.hide(userId, entryId);
      if (!entry) throw new NotFoundError("NoteEntry", entryId);
      return entry;
    });
  }

  async restoreEntry(userId: string, entryId: string): Promise<NoteEntryRow> {
    return this.withActorEntries(userId, async (entries) => {
      const entry = await entries.restore(userId, entryId);
      if (!entry) throw new NotFoundError("NoteEntry", entryId);
      return entry;
    });
  }

  /** 硬删除(破坏性,详情页专属);不存在时同样 404。 */
  async deleteEntry(userId: string, entryId: string): Promise<{ ok: true }> {
    return this.withActorEntries(userId, async (entries) => {
      const deleted = await entries.remove(userId, entryId);
      if (!deleted) throw new NotFoundError("NoteEntry", entryId);
      return { ok: true as const };
    });
  }

  /**
   * 复习队列附带:批量取多个词的可见条目(word_id → 条目数组,创建时间正序)。
   * 在 actorId 事务内执行以满足 note_entries 表 RLS。
   */
  async getVisibleByWordIds(
    userId: string,
    wordbookId: string,
    wordIds: string[],
  ): Promise<Map<string, NoteEntryRow[]>> {
    return this.withActorEntries(userId, async (entries) => {
      const rows = await entries.listVisibleByWordIds(userId, wordbookId, wordIds);
      const map = new Map<string, NoteEntryRow[]>();
      for (const row of rows) {
        const list = map.get(row.word_id);
        if (list) list.push(row);
        else map.set(row.word_id, [row]);
      }
      return map;
    });
  }

  /** 笔记列表页:可见条目 + 词信息,创建时间倒序。 */
  async listEntries(
    userId: string,
    limit = 50,
    offset = 0,
  ): Promise<Array<{
    id: string;
    wordSlug: string;
    wordLemma: string;
    wordTitle: string;
    contentMd: string;
    createdAt: string;
    updatedAt: string;
  }>> {
    return this.withActorEntries(userId, async (entries) => {
      const rows = await entries.listByUser(userId, limit, offset);
      return rows.map((r) => ({
        id: r.id,
        wordSlug: r.word_slug,
        wordLemma: r.word_lemma,
        wordTitle: r.word_title,
        contentMd: r.content_md,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
    });
  }
}
