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

const SUMMARY_COLUMNS = `id, slug, title, lemma, pos, cefr, ipa, short_definition, metadata`;

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
    const { pagination, filters = {} } = options;
    const { limit, offset } = pagination;
    const where: string[] = ["is_published = true", "is_deleted = false"];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filters.q) {
      where.push(
        `(search_vector @@ websearch_to_tsquery('english', $${paramIdx}) OR lemma ILIKE $${paramIdx + 1})`,
      );
      params.push(filters.q, `%${filters.q}%`);
      paramIdx += 2;
    }

    if (filters.freq) {
      where.push(`metadata->>'word_freq' = $${paramIdx}`);
      params.push(filters.freq);
      paramIdx++;
    }

    if (filters.semantic) {
      where.push(`metadata->>'semantic_field' = $${paramIdx}`);
      params.push(filters.semantic);
      paramIdx++;
    }

    const whereClause = where.join(" AND ");
    const countSql = `SELECT count(*)::int AS total FROM words WHERE ${whereClause}`;
    const countRow = await this.queryOne<{ total: number }>(countSql, params);
    const total = countRow?.total ?? 0;

    const dataSql = `SELECT ${SUMMARY_COLUMNS} FROM words WHERE ${whereClause}
                     ORDER BY lemma ASC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
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
