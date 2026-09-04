/**
 * HighlightRepository — migrated from v1's lib/highlights/repository.ts.
 *
 * Same changes as AnnotationRepository: class-based, tx-injectable.
 */

import type { HighlightRow } from "../domain";
import type { IHighlightRepository } from "./interfaces";
import { BaseRepository } from "./base";

export class HighlightRepository extends BaseRepository implements IHighlightRepository {
  async findByWords(
    userId: string,
    wordbookId: string,
    wordIds: string[],
  ): Promise<HighlightRow[]> {
    if (wordIds.length === 0) return [];
    return this.query<HighlightRow>(
      `SELECT id, user_id, word_id, wordbook_id, source_field, text_snippet, color, created_at
       FROM word_highlights
       WHERE user_id = $1 AND wordbook_id = $2
         AND word_id = ANY($3::uuid[])
       ORDER BY created_at ASC`,
      [userId, wordbookId, wordIds],
    );
  }

  async create(
    userId: string,
    wordId: string,
    wordbookId: string,
    sourceField: string | null,
    textSnippet: string,
    color: string,
  ): Promise<HighlightRow> {
    const row = await this.queryOne<HighlightRow>(
      `INSERT INTO word_highlights (user_id, word_id, wordbook_id, source_field, text_snippet, color)
       VALUES ($1, $2::uuid, $3, $4, $5, $6)
       ON CONFLICT (user_id, wordbook_id, word_id, source_field, text_snippet)
       DO UPDATE SET color = EXCLUDED.color
       RETURNING id, user_id, word_id, wordbook_id, source_field, text_snippet, color, created_at`,
      [userId, wordId, wordbookId, sourceField, textSnippet, color],
    );
    if (!row) throw new Error("create highlight returned no row");
    return row;
  }

  async delete(
    userId: string,
    wordbookId: string,
    highlightId: string,
  ): Promise<void> {
    await this.query(
      `DELETE FROM word_highlights
       WHERE id = $1 AND user_id = $2 AND wordbook_id = $3`,
      [highlightId, userId, wordbookId],
    );
  }
}
