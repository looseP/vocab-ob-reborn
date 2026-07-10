/**
 * WordbookRepository — extracted from v1's lib/wordbook.ts.
 *
 * Handles wordbook CRUD + item assignment. v1's wordbook.ts mixed DB access
 * with caching/context; v2 keeps this repo purely about SQL.
 */

import type { WordbookRow } from "../domain";
import type { IWordbookRepository } from "./interfaces";
import { BaseRepository } from "./base";

export class WordbookRepository extends BaseRepository implements IWordbookRepository {
  async findById(id: string): Promise<WordbookRow | null> {
    return this.queryOne<WordbookRow>(
      `SELECT id, user_id, name, description, is_default, settings, created_at, updated_at
       FROM wordbooks WHERE id = $1::uuid`,
      [id],
    );
  }

  async findDefaultByUser(userId: string): Promise<WordbookRow | null> {
    return this.queryOne<WordbookRow>(
      `SELECT id, user_id, name, description, is_default, settings, created_at, updated_at
       FROM wordbooks WHERE user_id = $1 AND is_default = true LIMIT 1`,
      [userId],
    );
  }

  async findAllByUser(userId: string): Promise<WordbookRow[]> {
    return this.query<WordbookRow>(
      `SELECT id, user_id, name, description, is_default, settings, created_at, updated_at
       FROM wordbooks WHERE user_id = $1 ORDER BY name`,
      [userId],
    );
  }

  async create(
    userId: string,
    name: string,
    isDefault = false,
    description: string | null = null,
  ): Promise<WordbookRow> {
    const row = await this.queryOne<WordbookRow>(
      `INSERT INTO wordbooks (user_id, name, is_default, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, name, description, is_default, settings, created_at, updated_at`,
      [userId, name, isDefault, description],
    );
    if (!row) throw new Error("wordbook create returned no row");
    return row;
  }

  async getOrCreateDefault(userId: string): Promise<WordbookRow> {
    const existing = await this.findDefaultByUser(userId);
    if (existing) return existing;
    return this.create(userId, "Global", true);
  }

  async countWords(wordbookId: string): Promise<number> {
    const row = await this.queryOne<{ count: string }>(
      `SELECT count(*) FROM wordbook_items WHERE wordbook_id = $1::uuid`,
      [wordbookId],
    );
    return row ? parseInt(row.count, 10) : 0;
  }

  async getWordIds(wordbookId: string): Promise<string[]> {
    const rows = await this.query<{ word_id: string }>(
      `SELECT word_id FROM wordbook_items WHERE wordbook_id = $1::uuid`,
      [wordbookId],
    );
    return rows.map((r) => r.word_id);
  }

  async addWords(wordbookId: string, wordIds: string[]): Promise<void> {
    if (wordIds.length === 0) return;
    // Batch insert with parameterized values
    const valuesPart = wordIds
      .map((_, idx) => `($1::uuid, $${idx + 2}::uuid)`)
      .join(", ");
    await this.query(
      `INSERT INTO wordbook_items (wordbook_id, word_id) VALUES ${valuesPart}
       ON CONFLICT DO NOTHING`,
      [wordbookId, ...wordIds],
    );
  }
}
