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
  PlazaKind,
  PlazaOverview,
  PlazaReviewStats,
  PlazaWordCard,
  PlazaWordRow,
  RootCollectionDetail,
  RootFamilyGroupRow,
  RootsOverview,
  RootWordCard,
  SemanticFieldGroupRow,
} from "../domain";
import { PLAZA_ROOT_SLUG_PREFIX, PLAZA_SEMANTIC_SLUG_PREFIX } from "../domain";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import { NotFoundError } from "../errors";
import { plazaCache, type PlazaCache } from "./plaza-cache";

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

/**
 * 词根 token 提取（P4 深度逻辑优化）：
 * 1) 按 `+` 拆分复合词根（air + condition → [air, condition]）
 * 2) 每部分取括号（半/全角）前的首个连续字母串，小写化（"chart (from …)" → chart；
 *    "german（Germania…）" → german；"al-Khwarizmi (…)" → al-khwarizmi）
 * 3) 过滤噪声：非 [a-z]{2,}（空、单字符、纯中文/符号）剔除
 * 与 SQL 提取（findRootFamilyGroups）保持一致，避免聚合与详情不一致。
 */
export function extractRootTokens(morphologyRoot: string | null | undefined): string[] {
  if (!morphologyRoot || morphologyRoot === "EMPTY") return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of morphologyRoot.split("+")) {
    // `+` 拆分后各部分可能带前导空格，先 trim 再提取首个连续字母串
    const match = /^[A-Za-z][A-Za-z'-]*/.exec(part.trim());
    if (!match) continue;
    const token = match[0].toLowerCase();
    if (token.length < 2 || !/^[a-z]{2,}$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

/** 词根 token → 集合 slug（`root-<token>`，token 已是小写拉丁）。 */
export function toRootSlug(token: string): string {
  return `${PLAZA_ROOT_SLUG_PREFIX}-${token}`;
}

/** 集合 slug → 词根 token（找不到前缀返回 null）。 */
export function tokenFromRootSlug(slug: string): string | null {
  if (!slug.startsWith(`${PLAZA_ROOT_SLUG_PREFIX}-`)) return null;
  const token = slug.slice(PLAZA_ROOT_SLUG_PREFIX.length + 1).trim().toLowerCase();
  return /^[a-z]{2,}$/.test(token) ? token : null;
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

function toRootCollectionSummary(row: RootFamilyGroupRow): PlazaCollectionSummary {
  return {
    slug: toRootSlug(row.root),
    title: row.root,
    kind: "root_affix",
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

/** 词根结构字段：`EMPTY` 哨兵视为空（导入占位），避免详情页展示无意义值。 */
function cleanMorphField(value: string | null): string | null {
  return value && value !== "EMPTY" ? value : null;
}

function toRootWordCard(word: PlazaWordRow): RootWordCard {
  return {
    ...toWordCard(word),
    root: cleanMorphField(metadataString(word.metadata, "morphology_root")),
    prefix: cleanMorphField(metadataString(word.metadata, "morphology_prefix")),
    suffix: cleanMorphField(metadataString(word.metadata, "morphology_suffix")),
  };
}

/** 词根集合类型：全复合 / 全简单 / 混合（按家族词的 morphology_root 是否含 `+`）。 */
function classifyRootFamily(words: PlazaWordRow[]): RootCollectionDetail["type"] {
  const flags = new Set(words.map((word) => {
    const raw = metadataString(word.metadata, "morphology_root") ?? "";
    return raw.includes("+") ? "compound" : "simple";
  }));
  if (flags.size <= 1) return flags.has("compound") ? "compound" : "simple";
  return "mixed";
}

export class PlazaService {
  constructor(
    private readonly words: IWordRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
    private readonly cache: PlazaCache = plazaCache,
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
    const cacheKey = `overview:semantic:${params.q ?? ""}`;
    const cached = this.cache.get<PlazaOverview>(cacheKey);
    if (cached) return cached;
    const { q } = params;
    const overview = await this.withActorWords(params.userId, async (words) => {
      // total = 全量语义场数（无 q）；showing = q 过滤后的命中数。
      // 前端据此区分「无任何数据」与「无匹配结果」两种空态。
      const [allGroups, filteredGroups] = await Promise.all([
        words.findSemanticFieldGroups(undefined),
        words.findSemanticFieldGroups(q),
      ]);
      const collections = filteredGroups.map(toCollectionSummary);
      return this.toOverview(collections, allGroups.length, "semantic_field");
    });
    this.cache.set(cacheKey, overview);
    return overview;
  }

  async getRootsOverview(params: {
    userId: string;
    minCount?: number;
    q?: string;
    letter?: string;
  }): Promise<RootsOverview> {
    const min = Math.max(1, params.minCount ?? 3);
    const cacheKey = `overview:roots:${min}:${params.q ?? ""}:${params.letter ?? ""}`;
    const cached = this.cache.get<RootsOverview>(cacheKey);
    if (cached) return cached;
    const { q, letter } = params;
    const overview = await this.withActorWords(params.userId, async (words) => {
      const [allGroups, filteredGroups] = await Promise.all([
        words.findRootFamilyGroups({ minCount: min }),
        words.findRootFamilyGroups({ minCount: min, q, letter }),
      ]);
      const collections = filteredGroups.map(toRootCollectionSummary);
      return {
        available: true,
        counts: { showing: collections.length, total: allGroups.length },
        collections,
        total: allGroups.length,
      };
    });
    this.cache.set(cacheKey, overview);
    return overview;
  }

  async getCollection(params: { userId: string; slug: string }): Promise<PlazaCollectionDetail> {
    const cacheKey = `collection:${params.slug}`;
    const cached = this.cache.get<PlazaCollectionDetail>(cacheKey);
    if (cached) return cached;
    const { slug } = params;
    const field = fieldFromPlazaSlug(slug);
    if (!field) {
      throw new NotFoundError("PlazaCollection", slug);
    }
    const prefix = sourcePathPrefixForField(field);
    const detail: PlazaCollectionDetail = await this.withActorWords(params.userId, async (words) => {
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
    this.cache.set(cacheKey, detail);
    return detail;
  }

  async getRootCollection(params: { userId: string; slug: string }): Promise<RootCollectionDetail> {
    const cacheKey = `collection:${params.slug}`;
    const cached = this.cache.get<RootCollectionDetail>(cacheKey);
    if (cached) return cached;
    const { slug } = params;
    const token = tokenFromRootSlug(slug);
    if (!token) {
      throw new NotFoundError("PlazaCollection", slug);
    }
    const detail: RootCollectionDetail = await this.withActorWords(params.userId, async (words) => {
      const rows = await words.findByRootToken(token);
      if (rows.length === 0) {
        throw new NotFoundError("PlazaCollection", slug);
      }
      const firstUpdated = rows.reduce((acc, row) => (row.updated_at > acc ? row.updated_at : acc), rows[0].updated_at);
      return {
        slug,
        title: token,
        kind: "root_affix",
        count: rows.length,
        updatedAt: firstUpdated,
        type: classifyRootFamily(rows),
        words: rows.map(toRootWordCard),
      };
    });
    this.cache.set(cacheKey, detail);
    return detail;
  }

  /**
   * 集合内复习统计（E1）：取集合词 id 列表，聚合 user_word_progress 的
   * 已追踪 / 待复习计数。集合词 id 复用详情查询（语义场/词根），保证与
   * 详情页展示一致。
   */
  async getReviewStats(params: { userId: string; slug: string }): Promise<PlazaReviewStats> {
    const { userId, slug } = params;
    return this.withActorWords(userId, async (words) => {
      const token = tokenFromRootSlug(slug);
      let wordIds: string[];
      if (token) {
        const rows = await words.findByRootToken(token);
        wordIds = rows.map((r) => r.id);
      } else {
        const field = fieldFromPlazaSlug(slug);
        if (!field) throw new NotFoundError("PlazaCollection", slug);
        const rows = await words.findBySourcePathPrefix(sourcePathPrefixForField(field));
        wordIds = rows.map((r) => r.id);
      }
      if (wordIds.length === 0) throw new NotFoundError("PlazaCollection", slug);
      return words.countReviewStatsByWordIds(userId, wordIds);
    });
  }

  private toOverview(
    collections: PlazaCollectionSummary[],
    total: number,
    kind: PlazaKind,
  ): PlazaOverview {
    const group: PlazaGroup = {
      kind,
      label: kind === "root_affix" ? "词根词缀" : "语义场",
      count: collections.length,
      collections,
    };
    return {
      available: true,
      counts: { showing: collections.length, total },
      groups: collections.length > 0 ? [group] : [],
      total,
    };
  }
}
