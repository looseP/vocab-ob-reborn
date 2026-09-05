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
         (word_id, field, content, source, source_ref, approved_by, is_active)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.word_id,
        data.field,
        JSON.stringify(data.content),
        data.source,
        data.source_ref ?? null,
        data.approved_by ?? "user",
        data.is_active ?? true,
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

  /**
   * Phase G 候选池：待选提案（is_active=false 的行）。
   * 这些行不进 words JSONB 缓存（refresh_l2_cache 只聚合 active 行），
   * 因此不出题、不展示，直到用户采纳。
   */
  async findCandidatesByWord(wordId: string): Promise<L2ContentRow[]> {
    return this.query<L2ContentRow>(
      `SELECT * FROM word_l2_content
       WHERE word_id = $1::uuid AND is_active = false
       ORDER BY created_at`,
      [wordId],
    );
  }

  async findById(id: string): Promise<L2ContentRow | null> {
    return this.queryOne<L2ContentRow>(
      `SELECT * FROM word_l2_content WHERE id = $1::uuid`,
      [id],
    );
  }

  async setActive(id: string, isActive: boolean): Promise<void> {
    await this.query(
      `UPDATE word_l2_content SET is_active = $2 WHERE id = $1::uuid`,
      [id, isActive],
    );
  }

  async setActiveAndContent(id: string, isActive: boolean, content: unknown): Promise<void> {
    await this.query(
      `UPDATE word_l2_content SET is_active = $2, content = $3::jsonb WHERE id = $1::uuid`,
      [id, isActive, JSON.stringify(content)],
    );
  }

  /** Phase G：拒绝候选 = 硬删（agent 可重新 propose，无需保留墓碑）。 */
  async deleteById(id: string): Promise<void> {
    await this.query(
      `DELETE FROM word_l2_content WHERE id = $1::uuid`,
      [id],
    );
  }

  async softDelete(id: string): Promise<void> {
    await this.setActive(id, false);
  }

  /** Refresh the four words L2 JSONB caches through the migration-owned RPC. */
  async refreshL2Cache(wordId: string): Promise<void> {
    await this.query(
      `SELECT public.refresh_l2_cache($1::uuid)`,
      [wordId],
    );
  }
}

// Re-export for callers that want the cache-field list.
export { CACHE_FIELDS };
