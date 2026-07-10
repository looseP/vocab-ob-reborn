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

import type {
  GetPublicWordsOptions,
  PaginatedResult,
  WordRow,
  WordSummary,
} from "../domain";
import type { IWordRepository } from "./interfaces";
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
    const where: string[] = ["w.is_published = true", "w.is_deleted = false"];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters.q) {
      where.push(
        `(w.search_vector @@ websearch_to_tsquery('english', $${paramIdx}) OR w.lemma ILIKE $${paramIdx + 1})`,
      );
      params.push(filters.q, `%${filters.q}%`);
      paramIdx += 2;
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

    const dataSql = `SELECT ${SUMMARY_COLUMNS} FROM words w WHERE ${whereClause}
                     ORDER BY w.lemma ASC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    const items = await this.query<WordSummary>(dataSql, [
      ...params,
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
}
