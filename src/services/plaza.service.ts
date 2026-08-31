/**
 * PlazaService — 词汇广场（P4）。
 *
 * 自生长集合：不依赖另一套 Obsidian wiki 笔记（原版通过 collection_notes 表
 * 导入 Wiki/词根词缀、Wiki/语义场），而是从 words 表的 source_path /
 * metadata 实时聚合推导——语义场集合 = 各 L1 批次的词。词库精修、导入后广场
 * 自动反映最新分组，无需任何额外同步。
 *
 * Phase 1 仅实现语义场集合（semantic_field）；词根词缀集合（root_affix，
 * 基于 morphology_root 归一化聚合）留待 Phase 2。
 */

import type { PoolClient } from "pg";
import type { IRepositories, IWordRepository } from "../repositories/interfaces";
import type {
  PlazaCollectionDetail,
  PlazaCollectionSummary,
  PlazaGroup,
  PlazaOverview,
  PlazaWordCard,
  PlazaWordRow,
  SemanticFieldGroupRow,
} from "../domain";
import { PLAZA_SEMANTIC_SLUG_PREFIX } from "../domain";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import { NotFoundError } from "../errors";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

/** L1 语义场 source_path 前缀模板：`L1_雅思词汇/L1_雅思词汇_<场名>.md` */
function sourcePathPrefixForField(field: string): string {
  return `L1_雅思词汇/L1_雅思词汇_${field}.md`;
}

/** 从 source_path 前缀反解语义场名（去掉 .md 与固定前缀）。 */
function fieldFromSourcePathPrefix(prefix: string): string | null {
  const match = /^L1_雅思词汇\/L1_雅思词汇_(.+)\.md$/.exec(prefix);
  return match ? match[1] : null;
}

/** 语义场名 → 集合 slug（`semantic-<场名>`，中文原样保留、空格转连字符）。 */
export function toPlazaSlug(field: string): string {
  return `${PLAZA_SEMANTIC_SLUG_PREFIX}-${field.trim().replace(/\s+/g, "-")}`;
}

/** 集合 slug → 语义场名（找不到前缀返回 null）。 */
export function fieldFromPlazaSlug(slug: string): string | null {
  if (!slug.startsWith(`${PLAZA_SEMANTIC_SLUG_PREFIX}-`)) return null;
  const field = slug.slice(PLAZA_SEMANTIC_SLUG_PREFIX.length + 1).trim();
  return field.length > 0 ? field : null;
}

function metadataString(metadata: unknown, key: string): string | null {
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  return null;
}

function toCollectionSummary(row: SemanticFieldGroupRow): PlazaCollectionSummary {
  return {
    slug: toPlazaSlug(row.field),
    title: row.field,
    kind: "semantic_field",
    count: row.count,
    updatedAt: row.updatedAt,
  };
}

function toWordCard(word: PlazaWordRow): PlazaWordCard {
  return {
    id: word.id,
    slug: word.slug,
    lemma: word.lemma,
    cefr: word.cefr,
    short_definition: word.short_definition,
    semantic_chain: metadataString(word.metadata, "semantic_chain"),
  };
}

export class PlazaService {
  constructor(
    private readonly words: IWordRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  private withActorWords<T>(
    userId: string,
    callback: (words: IWordRepository) => Promise<T>,
  ): Promise<T> {
    return this.txRunner(
      async (tx) => callback(this.repositoryFactory(tx).words),
      { actorId: userId },
    );
  }

  async getOverview(params: { userId: string; q?: string }): Promise<PlazaOverview> {
    const { q } = params;
    return this.withActorWords(params.userId, async (words) => {
      const groups = await words.findSemanticFieldGroups(q);
      const total = groups.length;
      const collections = groups.map(toCollectionSummary);
      const group: PlazaGroup = {
        kind: "semantic_field",
        label: "语义场",
        count: collections.length,
        collections,
      };
      return {
        available: true,
        counts: { showing: collections.length, total },
        groups: collections.length > 0 ? [group] : [],
        total,
      };
    });
  }

  async getCollection(slug: string): Promise<PlazaCollectionDetail> {
    const field = fieldFromPlazaSlug(slug);
    if (!field) {
      throw new NotFoundError("PlazaCollection", slug);
    }
    const prefix = sourcePathPrefixForField(field);
    return this.withActorWords("plaza-reader", async (words) => {
      const rows = await words.findBySourcePathPrefix(prefix);
      if (rows.length === 0) {
        throw new NotFoundError("PlazaCollection", slug);
      }
      const firstUpdated = rows.reduce((acc, row) => (row.updated_at > acc ? row.updated_at : acc), rows[0].updated_at);
      return {
        slug,
        title: field,
        kind: "semantic_field",
        count: rows.length,
        updatedAt: firstUpdated,
        words: rows.map(toWordCard),
      };
    });
  }
}
