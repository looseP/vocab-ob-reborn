/**
 * NoteEntryRepository — 条目制笔记(2026-09-06)。
 *
 * 与遗留 notes(单文档+版本链)的区别:1 行/条,追加式写入,无乐观锁/无快照链。
 * 非破坏管理走 hide/restore(hidden_at 置值/清空);硬删除仅详情页入口。
 *
 * Parameter order convention: (userId, wordbookId, wordId, ...) — consistent
 * with the other repositories and interfaces.ts.
 */

import type { NoteEntryRow } from "../domain";
import type { INoteEntryRepository } from "./interfaces";
import { BaseRepository } from "./base";

export class NoteEntryRepository extends BaseRepository implements INoteEntryRepository {
  async listByWord(
    userId: string,
    wordbookId: string,
    wordId: string,
  ): Promise<NoteEntryRow[]> {
    return this.query<NoteEntryRow>(
      `SELECT id, user_id, word_id, wordbook_id, content_md, hidden_at, created_at, updated_at
       FROM note_entries
       WHERE user_id = $1 AND wordbook_id = $2 AND word_id = $3::uuid
       ORDER BY created_at ASC, id ASC`,
      [userId, wordbookId, wordId],
    );
  }

  /** 复习队列附带:批量取某词本内多个词的可见条目(hidden_at IS NULL)。 */
  async listVisibleByWordIds(
    userId: string,
    wordbookId: string,
    wordIds: string[],
  ): Promise<NoteEntryRow[]> {
    if (wordIds.length === 0) return [];
    return this.query<NoteEntryRow>(
      `SELECT id, user_id, word_id, wordbook_id, content_md, hidden_at, created_at, updated_at
       FROM note_entries
       WHERE user_id = $1 AND wordbook_id = $2 AND word_id = ANY($3::uuid[])
         AND hidden_at IS NULL
       ORDER BY created_at ASC, id ASC`,
      [userId, wordbookId, wordIds],
    );
  }

  async insert(
    userId: string,
    wordbookId: string,
    wordId: string,
    contentMd: string,
  ): Promise<NoteEntryRow> {
    return this.queryOne<NoteEntryRow>(
      `INSERT INTO note_entries (user_id, word_id, wordbook_id, content_md)
       VALUES ($1, $2::uuid, $3::uuid, $4)
       RETURNING id, user_id, word_id, wordbook_id, content_md, hidden_at, created_at, updated_at`,
      [userId, wordId, wordbookId, contentMd],
    ) as Promise<NoteEntryRow>;
  }

  async updateContent(
    userId: string,
    entryId: string,
    contentMd: string,
  ): Promise<NoteEntryRow | null> {
    return this.queryOne<NoteEntryRow>(
      `UPDATE note_entries
       SET content_md = $3, updated_at = now()
       WHERE id = $2::uuid AND user_id = $1
       RETURNING id, user_id, word_id, wordbook_id, content_md, hidden_at, created_at, updated_at`,
      [userId, entryId, contentMd],
    );
  }

  async hide(userId: string, entryId: string): Promise<NoteEntryRow | null> {
    return this.queryOne<NoteEntryRow>(
      `UPDATE note_entries
       SET hidden_at = now(), updated_at = now()
       WHERE id = $2::uuid AND user_id = $1
       RETURNING id, user_id, word_id, wordbook_id, content_md, hidden_at, created_at, updated_at`,
      [userId, entryId],
    );
  }

  async restore(userId: string, entryId: string): Promise<NoteEntryRow | null> {
    return this.queryOne<NoteEntryRow>(
      `UPDATE note_entries
       SET hidden_at = NULL, updated_at = now()
       WHERE id = $2::uuid AND user_id = $1
       RETURNING id, user_id, word_id, wordbook_id, content_md, hidden_at, created_at, updated_at`,
      [userId, entryId],
    );
  }

  async remove(userId: string, entryId: string): Promise<boolean> {
    const row = await this.queryOne<{ id: string }>(
      `DELETE FROM note_entries
       WHERE id = $2::uuid AND user_id = $1
       RETURNING id`,
      [userId, entryId],
    );
    return row !== null;
  }

  async listByUser(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<Array<NoteEntryRow & { word_slug: string; word_lemma: string; word_title: string }>> {
    return this.query<NoteEntryRow & { word_slug: string; word_lemma: string; word_title: string }>(
      `SELECT n.id, n.user_id, n.word_id, n.wordbook_id, n.content_md, n.hidden_at, n.created_at, n.updated_at,
              w.slug AS word_slug, w.lemma AS word_lemma, w.title AS word_title
       FROM note_entries n
       JOIN words w ON w.id = n.word_id
       WHERE n.user_id = $1 AND n.hidden_at IS NULL
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );
  }
}
