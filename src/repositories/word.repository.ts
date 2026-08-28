/**
 * WordRepository — core word CRUD + public listing + search.
 *
 * Extracted from v1's lib/words/repository.ts (670 lines, which mixed
 * caching, transform, and DB concerns). v2 isolates pure DB access here;
 * caching/transform layers live in the calling service.
 *
 * SQL approach: uses raw parameterized queries (not the PostgREST builder)
 * so all PG features (tsvector, ANY(), ILIKE) are first-class.
 */

import { createHash } from "node:crypto";
import { computePinyinFromCjk } from "../domain/ingest/pinyin";
import type {
  GetPublicWordsOptions,
  PaginatedResult,
  WordRow,
  WordSummary,
} from "../domain";
import type { IWordRepository, UpsertFullWordInput } from "./interfaces";
import { BaseRepository } from "./base";

const SUMMARY_COLUMNS = `w.id, w.slug, w.title, w.lemma, w.pos, w.cefr, w.ipa, w.short_definition, w.metadata`;

export class WordRepository extends BaseRepository implements IWordRepository {
  async findById(id: string): Promise<WordRow | null> {
    return this.queryOne<WordRow>(
      `SELECT * FROM words WHERE id = $1::uuid AND is_deleted = false`,
      [id],
    );
  }

  async findBySlug(slug: string): Promise<WordRow | null> {
    return this.queryOne<WordRow>(
      `SELECT * FROM words WHERE slug = $1 AND is_deleted = false`,
      [slug],
    );
  }

  async findPublic(
    options: GetPublicWordsOptions,
  ): Promise<PaginatedResult<WordSummary>> {
    const { pagination, filters = {}, userId, wordbookId } = options;
    const { limit, offset } = pagination;
    const where: string[] = [
      "w.is_published = true",
      "w.is_deleted = false",
      // L1-4：默认过滤 stub 词条（仅 lemma、无内容，批量导入/阅读采集产生）。
      // 判定依据是核心内容列 definition_md 是否为空（NOT NULL，stub 写入空串）——
      // 不能看 short_definition（真实词条可能无短释义但有完整释义）。
      "(w.definition_md <> '')",
    ];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters.q) {
      // P1：中文释义子串搜索——to_tsvector('english') 对中文不分词，仅整段 token 能命中，
      // 因此叠加 short_definition / definition_md 的 ILIKE 子串匹配，支持按中文释义检索。
      // P2：拼音搜索（pinyin / pinyin_initial，去空格对齐无空格存储）+ 拼写容错
      // （word_similarity，纠正 "courge→courage" 类输入；函数式查询，7k 词条成本可忽略）。
      const q = filters.q;
      const qNoSpace = q.replace(/\s+/g, "");
      // L1-1：多词查询按空格拆 token（≥2 个时），要求 lemma 同时包含全部 token，
      // 使 "space exploration" 能命中组合词条与跨词非连续 lemma，而非只整串子串。
      const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
      const multiWord = tokens.length >= 2;
      const wrappedTokens = tokens.map((t) => `%${t}%`);

      let predicate = `(w.search_vector @@ websearch_to_tsquery('english', $${paramIdx})
          OR w.lemma ILIKE $${paramIdx + 1}
          OR w.short_definition ILIKE $${paramIdx + 2}
          OR w.definition_md ILIKE $${paramIdx + 3}
          OR w.pinyin ILIKE $${paramIdx + 4}
          OR w.pinyin_initial ILIKE $${paramIdx + 5}
          OR word_similarity($${paramIdx + 6}, w.lemma) > 0.3)`;
      const qParams: unknown[] = [
        q,
        `%${q}%`,
        `%${q}%`,
        `%${q}%`,
        `%${qNoSpace}%`,
        `%${qNoSpace}%`,
        q,
      ];

      if (multiWord) {
        predicate += ` OR (${wrappedTokens
          .map((_, i) => `w.lemma ILIKE $${paramIdx + 7 + i}`)
          .join(" AND ")})`;
        qParams.push(...wrappedTokens);
      }
      where.push(predicate);
      params.push(...qParams);
      paramIdx += qParams.length;
    }

    if (filters.freq) {
      where.push(`w.metadata->>'word_freq' = $${paramIdx}`);
      params.push(filters.freq);
      paramIdx++;
    }

    if (filters.semantic) {
      where.push(`w.metadata->>'semantic_field' = $${paramIdx}`);
      params.push(filters.semantic);
      paramIdx++;
    }

    if (filters.cefr) {
      // P0-1：cefr 区间归一——区间值（B2–C1 等）按下限参与过滤。
      // left(cefr,2) 取首级，精确值 "B2" 与区间 "B2–C1" 均匹配 B2，避免精确匹配排除区间词条。
      where.push(`left(w.cefr, 2) = $${paramIdx}`);
      params.push(filters.cefr);
      paramIdx++;
    }

    if (wordbookId) {
      where.push(`EXISTS (
        SELECT 1 FROM wordbook_items wbi
        JOIN wordbooks wb ON wb.id = wbi.wordbook_id
        WHERE wbi.word_id = w.id AND wbi.wordbook_id = $${paramIdx}::uuid AND wb.user_id = $${paramIdx + 1}
      )`);
      params.push(wordbookId, userId);
      paramIdx += 2;
    }

    if (filters.review && filters.review !== "all") {
      const progressExists = `EXISTS (
        SELECT 1 FROM user_word_progress uwp
        WHERE uwp.word_id = w.id AND uwp.user_id = $${paramIdx}
        ${wordbookId ? `AND uwp.wordbook_id = $${paramIdx + 1}::uuid` : ""}
        ${filters.review === "due" ? "AND uwp.state <> 'suspended' AND uwp.due_at IS NOT NULL AND uwp.due_at <= now()" : ""}
      )`;
      params.push(userId);
      if (wordbookId) {
        params.push(wordbookId);
        paramIdx += 2;
      } else {
        paramIdx++;
      }
      if (filters.review === "tracked" || filters.review === "due") where.push(progressExists);
      if (filters.review === "untracked") where.push(`NOT ${progressExists}`);
    }

    const whereClause = where.join(" AND ");
    const countSql = `SELECT count(*)::int AS total FROM words w WHERE ${whereClause}`;
    const countRow = await this.queryOne<{ total: number }>(countSql, params);
    const total = countRow?.total ?? 0;

    // P1：相关性排序——精确 lemma > lemma 前缀 > 全文命中 > 其余子串，命中内按 ts_rank 降序。
    // P2：追加拼音命中层（在子串之上），并用 GREATEST(ts_rank, word_similarity) 让拼写容错命中也能靠前。
    // L1-1：多词查询时在"完整前缀"之下插入"lemma 同时包含全部 token"层。
    // L1-3：同文本相关度内按 CEFR 加权（A1 最高），常用词优先。
    // 无搜索词时保持按字母序浏览。
    let orderClause = "w.lemma ASC";
    const orderParams: unknown[] = [];
    if (filters.q) {
      const q = filters.q;
      const qNoSpace = q.replace(/\s+/g, "");
      const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
      const multiWord = tokens.length >= 2;
      const wrappedTokens = tokens.map((t) => `%${t}%`);

      const whens = [
        `WHEN w.lemma ILIKE $${paramIdx} THEN 0`,
        `WHEN w.lemma ILIKE $${paramIdx + 1} THEN 1`,
      ];
      orderParams.push(q, `${q}%`);

      if (multiWord) {
        whens.push(
          `WHEN w.lemma ILIKE ALL (ARRAY[${wrappedTokens
            .map((_, i) => `$${paramIdx + 2 + i}`)
            .join(", ")}]) THEN 2`,
        );
        orderParams.push(...wrappedTokens);
      }

      // o = 下一个可用参数索引（始终以 orderParams 实际长度为准，
      // 避免单 token 时 wrappedTokens.length=1 造成的索引偏移）
      const o = paramIdx + orderParams.length;
      // multiWord 会让 CASE 层数整体 +1（fts 3 / pinyin 4 / else 5，否则 2/3/4）
      const shift = multiWord ? 1 : 0;
      whens.push(
        `WHEN w.search_vector @@ websearch_to_tsquery('english', $${o}) THEN ${2 + shift}`,
        `WHEN w.pinyin ILIKE $${o + 1} OR w.pinyin_initial ILIKE $${o + 2} THEN ${3 + shift}`,
        `ELSE ${4 + shift}`,
      );
      orderParams.push(q, `%${qNoSpace}%`, `%${qNoSpace}%`);

      orderClause = `CASE
          ${whens.join("\n          ")}
        END ASC,
        GREATEST(
          ts_rank(w.search_vector, websearch_to_tsquery('english', $${o + 3})),
          word_similarity($${o + 4}, w.lemma)
        ) DESC NULLS LAST,
        -- P0-1：cefr 区间归一——排序权重取区间下限（left 首级），B2–C1 按 B2 参与加权
        CASE left(w.cefr, 2)
          WHEN 'A1' THEN 6 WHEN 'A2' THEN 5 WHEN 'B1' THEN 4
          WHEN 'B2' THEN 3 WHEN 'C1' THEN 2 WHEN 'C2' THEN 1
          ELSE 0
        END DESC,
        w.lemma ASC`;
      orderParams.push(q, q);
    }

    const dataSql = `SELECT ${SUMMARY_COLUMNS} FROM words w WHERE ${whereClause}
                     ORDER BY ${orderClause} LIMIT $${paramIdx + orderParams.length} OFFSET $${paramIdx + orderParams.length + 1}`;
    const items = await this.query<WordSummary>(dataSql, [
      ...params,
      ...orderParams,
      limit,
      offset,
    ]);

    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  /**
   * 输入联想（L1-2）：按 lemma / 拼音前缀即时返回 top-N 建议。
   * lemma 前缀命中优先于拼音命中，再按 lemma 字母序；同样过滤 stub 词条。
   */
  async suggest(q: string, limit = 8): Promise<WordSummary[]> {
    const query = q.trim();
    if (!query) return [];
    const qNoSpace = query.replace(/\s+/g, "");
    return this.query<WordSummary>(
      `SELECT ${SUMMARY_COLUMNS}
       FROM words w
       WHERE w.is_published = true AND w.is_deleted = false
         AND w.definition_md <> ''
         AND (w.lemma ILIKE $1 OR w.pinyin ILIKE $2 OR w.pinyin_initial ILIKE $3)
       ORDER BY CASE
         WHEN w.lemma ILIKE $4 THEN 0
         WHEN w.pinyin ILIKE $5 OR w.pinyin_initial ILIKE $6 THEN 1
         ELSE 2
       END ASC, w.lemma ASC
       LIMIT $7`,
      [
        `%${query}%`,
        `%${qNoSpace}%`,
        `%${qNoSpace}%`,
        `${query}%`,
        `%${qNoSpace}%`,
        `%${qNoSpace}%`,
        limit,
      ],
    );
  }

  async count(): Promise<number> {
    const row = await this.queryOne<{ count: string }>(
      `SELECT count(*) FROM words WHERE is_deleted = false`,
    );
    return row ? parseInt(row.count, 10) : 0;
  }

  async findSlugs(limit = 5000): Promise<string[]> {
    const rows = await this.query<{ slug: string }>(
      `SELECT slug FROM words WHERE is_deleted = false ORDER BY slug LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.slug);
  }

  async insertMany(words: Array<{
    slug: string; title: string; lemma: string; pos: string | null;
    cefr: string | null; ipa: string | null; short_definition: string | null;
  }>): Promise<number> {
    if (words.length === 0) return 0;
    // `words` requires `content_hash` (64-hex, unique), `source_path`,
    // `definition_md`, and `body_md` as NOT NULL with no defaults. The batch
    // import payload only carries a minimal field set, so we derive stable
    // values here: a content hash from the provided fields (satisfies the
    // `^[0-9a-f]{64}$` CHECK and the unique constraint), a deterministic
    // source path, and markdown bodies from the short definition.
    const perRow = 13;
    const values: string[] = [];
    const params: unknown[] = [];
    words.forEach((w, i) => {
      const base = i * perRow;
      const short = w.short_definition ?? "";
      const contentHash = createHash("sha256")
        .update([w.slug, w.title, w.lemma, w.pos ?? "", w.cefr ?? "", w.ipa ?? "", short].join("\u0000"))
        .digest("hex");
      // P2：拼音列随导入生成（从中文释义取全拼/首字母）。
      const { pinyin, pinyinInitial } = computePinyinFromCjk(short);
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13})`,
      );
      params.push(
        w.slug, w.title, w.lemma, w.pos, w.cefr, w.ipa, short,
        contentHash, `batch-import/${w.slug}.md`, short, short,
        pinyin, pinyinInitial,
      );
    });
    const result = await this.queryViaBatchPool<{ id: string }>(
      `INSERT INTO words
         (slug, title, lemma, pos, cefr, ipa, short_definition, content_hash, source_path, definition_md, body_md, pinyin, pinyin_initial)
       VALUES ${values.join(", ")}
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title, lemma = EXCLUDED.lemma, pos = EXCLUDED.pos,
         cefr = EXCLUDED.cefr, ipa = EXCLUDED.ipa, short_definition = EXCLUDED.short_definition,
         content_hash = EXCLUDED.content_hash, source_path = EXCLUDED.source_path,
         definition_md = EXCLUDED.definition_md, body_md = EXCLUDED.body_md,
         pinyin = EXCLUDED.pinyin, pinyin_initial = EXCLUDED.pinyin_initial,
         updated_at = now()
       RETURNING id`,
      params,
    );
    return result.length;
  }

  /**
   * Full-note upsert through the batch-import pool. Hash-guarded: when the
   * stored content_hash equals the incoming one, the DO UPDATE ... WHERE
   * clause turns the statement into a no-op and "unchanged" is returned.
   */
  async upsertFullWord(input: UpsertFullWordInput): Promise<"imported" | "unchanged"> {
    // P2：拼音列从中文释义生成（全拼/首字母）。
    const { pinyin, pinyinInitial } = computePinyinFromCjk(input.shortDefinition, input.definitionMd);
    const rows = await this.queryViaBatchPool<{ id: string }>(
      `INSERT INTO words (
         slug, title, lemma, pos, cefr, ipa, aliases,
         short_definition, definition_md, body_md, examples, metadata,
         core_definitions, prototype_text, pinyin, pinyin_initial,
         content_hash, source_path, source_updated_at, synced_at,
         is_published, quality_status, quality_issues
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7::text[],
         $8, $9, $10, $11::jsonb, $12::jsonb,
         $13::jsonb, $14, $15, $16,
         $17, $18, $19::timestamptz, now(),
         $20, $21, $22::jsonb
       )
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title,
         lemma = EXCLUDED.lemma,
         pos = EXCLUDED.pos,
         cefr = EXCLUDED.cefr,
         ipa = EXCLUDED.ipa,
         aliases = EXCLUDED.aliases,
         short_definition = EXCLUDED.short_definition,
         definition_md = EXCLUDED.definition_md,
         body_md = EXCLUDED.body_md,
         examples = EXCLUDED.examples,
         metadata = EXCLUDED.metadata,
         core_definitions = EXCLUDED.core_definitions,
         prototype_text = EXCLUDED.prototype_text,
         pinyin = EXCLUDED.pinyin,
         pinyin_initial = EXCLUDED.pinyin_initial,
         content_hash = EXCLUDED.content_hash,
         source_path = EXCLUDED.source_path,
         source_updated_at = EXCLUDED.source_updated_at,
         synced_at = now(),
         is_published = EXCLUDED.is_published,
         quality_status = EXCLUDED.quality_status,
         quality_issues = EXCLUDED.quality_issues,
         updated_at = now()
       WHERE words.content_hash IS DISTINCT FROM EXCLUDED.content_hash
       RETURNING id`,
      [
        input.slug,
        input.title,
        input.lemma,
        input.pos,
        input.cefr,
        input.ipa,
        input.aliases,
        input.shortDefinition,
        input.definitionMd,
        input.bodyMd,
        JSON.stringify(input.examplesJson ?? []),
        JSON.stringify(input.metadataJson ?? {}),
        JSON.stringify(input.coreDefinitionsJson ?? []),
        input.prototypeText,
        pinyin,
        pinyinInitial,
        input.contentHash,
        input.sourcePath,
        input.sourceUpdatedAt,
        input.isPublished,
        input.qualityStatus,
        JSON.stringify(input.qualityIssuesJson ?? []),
      ],
    );
    return rows.length > 0 ? "imported" : "unchanged";
  }
}
