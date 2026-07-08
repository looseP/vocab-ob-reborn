/**
 * L2ContentRepository — multi-source L2 enrichment content per word.
 *
 * Each row stores one piece of L2 content (a collocation set, a corpus
 * example, a synonym/antonym cluster, ...) tagged by `field`. Multiple
 * sources can contribute rows for the same (word, field); the approved
 * ones are aggregated by {@link refreshL2Cache} back into the `words`
 * JSONB cache columns (collocations / corpus_items / synonym_items /
 * antonym_items).
 */

import type { L2ContentRow } from "../domain";
import type { IL2ContentRepository, NewL2Content } from "./interfaces";
import { BaseRepository } from "./base";

/** Field names that map onto the words JSONB cache columns. */
const CACHE_FIELDS = ["collocation", "corpus", "synonym", "antonym"] as const;

/**
 * Normalize a stored L2 content blob into a flat list of cache items.
 *
 * Supports three legacy shapes that may live in `word_l2_content.content`:
 *  - a bare array (legacy)            → returned as-is
 *  - a `{schemaVersion:"l2-content-v1", items:[...]}` wrapper (v1) → unwrapped
 *  - any other object (single item)   → wrapped into a one-element array
 * Non-array / non-object content resolves to an empty array so an absent or
 * malformed row never poisons the cache.
 */
export function extractL2Items(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (content && typeof content === "object") {
    const maybe = content as { schemaVersion?: unknown; items?: unknown };
    if (maybe.schemaVersion === "l2-content-v1" && Array.isArray(maybe.items)) {
      return maybe.items;
    }
    return [content];
  }
  return [];
}

export class L2ContentRepository extends BaseRepository implements IL2ContentRepository {
  async insert(data: NewL2Content): Promise<L2ContentRow> {
    const row = await this.queryOne<L2ContentRow>(
      `INSERT INTO word_l2_content
         (word_id, field, content, source, source_ref, approved_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.word_id,
        data.field,
        JSON.stringify(data.content),
        data.source,
        data.source_ref ?? null,
        data.approved_by ?? "user",
      ],
    );
    if (!row) throw new Error("L2 content insert returned no row");
    return row;
  }

  async findByWord(wordId: string, field?: string): Promise<L2ContentRow[]> {
    if (field) {
      return this.query<L2ContentRow>(
        `SELECT * FROM word_l2_content
         WHERE word_id = $1::uuid AND field = $2 AND is_active = true
         ORDER BY created_at`,
        [wordId, field],
      );
    }
    return this.query<L2ContentRow>(
      `SELECT * FROM word_l2_content
       WHERE word_id = $1::uuid AND is_active = true
       ORDER BY created_at`,
      [wordId],
    );
  }

  async softDelete(id: string): Promise<void> {
    await this.query(
      `UPDATE word_l2_content SET is_active = false WHERE id = $1::uuid`,
      [id],
    );
  }

  /**
   * Aggregate all active L2 content rows for a word, grouped by field,
   * and write the arrays back into the words JSONB cache columns:
   *   collocation → collocations
   *   corpus      → corpus_items
   *   synonym     → synonym_items
   *   antonym     → antonym_items
   *
   * Fields without rows resolve to an empty array, clearing stale cache.
   */
  async refreshL2Cache(wordId: string): Promise<void> {
    const rows = await this.query<{ field: string; content: unknown }>(
      `SELECT field, content FROM word_l2_content
       WHERE word_id = $1::uuid AND is_active = true`,
      [wordId],
    );

    // Group active content by field, flattening each row's content blob
    // (legacy arrays / v1 wrappers / single objects) into the cache list.
    const grouped: Record<string, unknown[]> = {};
    for (const row of rows) {
      if (!grouped[row.field]) grouped[row.field] = [];
      grouped[row.field].push(...extractL2Items(row.content));
    }

    await this.query(
      `UPDATE words SET
         collocations = $2,
         corpus_items = $3,
         synonym_items = $4,
         antonym_items = $5
       WHERE id = $1::uuid`,
      [
        wordId,
        JSON.stringify(grouped.collocation ?? []),
        JSON.stringify(grouped.corpus ?? []),
        JSON.stringify(grouped.synonym ?? []),
        JSON.stringify(grouped.antonym ?? []),
      ],
    );
  }
}

// Re-export for callers that want the cache-field list.
export { CACHE_FIELDS };
