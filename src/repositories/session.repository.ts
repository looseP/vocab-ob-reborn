/**
 * SessionRepository — extracted from v1's lib/review/session.ts.
 *
 * M5 fix: uses display timezone (Asia/Shanghai) for session-day cutoff,
 * matching v1's startOfTodayIso behavior.
 */

import type { SessionRow } from "../domain";
import type { ISessionRepository } from "./interfaces";
import { BaseRepository } from "./base";
import { startOfTodayIsoInDisplayTz } from "../db/timezone";
import { NotFoundError } from "../errors";

export class SessionRepository extends BaseRepository implements ISessionRepository {
  async findActiveByUser(
    userId: string,
    wordbookId: string,
    mode = "review",
  ): Promise<SessionRow | null> {
    return this.queryOne<SessionRow>(
      `SELECT id, user_id, wordbook_id, mode, cards_seen, started_at, ended_at
       FROM sessions
       WHERE user_id = $1 AND wordbook_id = $2 AND mode = $3 AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
      [userId, wordbookId, mode],
    );
  }

  async getOrCreateToday(
    userId: string,
    wordbookId: string,
    mode = "review",
  ): Promise<SessionRow> {
    const todayIso = startOfTodayIsoInDisplayTz();
    const row = await this.queryOne<SessionRow>(
      `SELECT id, user_id, wordbook_id, mode, cards_seen, started_at, ended_at
       FROM get_or_create_today_session($1::uuid, $2::uuid, $3, $4::timestamptz)`,
      [userId, wordbookId, mode, todayIso],
    );
    if (!row) throw new Error("session get-or-create returned no row");
    return row;
  }

  async create(
    userId: string,
    wordbookId: string,
    mode = "review",
  ): Promise<SessionRow> {
    const row = await this.queryOne<SessionRow>(
      `INSERT INTO sessions (user_id, wordbook_id, mode)
       VALUES ($1, $2::uuid, $3)
       RETURNING id, user_id, wordbook_id, mode, cards_seen, started_at, ended_at`,
      [userId, wordbookId, mode],
    );
    if (!row) throw new Error("session create returned no row");
    return row;
  }

  async assertActiveOwned(sessionId: string, userId: string, wordbookId: string): Promise<void> {
    this.requireTx();
    const row = await this.queryOne<{ id: string }>(
      `SELECT id
       FROM sessions
       WHERE id = $1::uuid
         AND user_id = $2::uuid
         AND wordbook_id = $3::uuid
         AND ended_at IS NULL
       FOR UPDATE`,
      [sessionId, userId, wordbookId],
    );
    if (!row) throw new NotFoundError("Session", sessionId);
  }

  async incrementCardsSeen(sessionId: string, userId: string, wordbookId: string): Promise<void> {
    const row = await this.queryOne<{ updated: boolean }>(
      `SELECT increment_session_cards_seen($1::uuid, $2::uuid, $3::uuid) AS updated`,
      [sessionId, userId, wordbookId],
    );
    if (row?.updated !== true) throw new NotFoundError("Session", sessionId);
  }

  async incrementCardsSeenFromOutbox(sessionId: string, userId: string, wordbookId: string): Promise<void> {
    this.requireTx();
    const row = await this.queryOne<{ id: string }>(
      `UPDATE sessions
       SET cards_seen = cards_seen + 1, updated_at = now()
       WHERE id = $1::uuid
         AND user_id = $2::uuid
         AND wordbook_id = $3::uuid
       RETURNING id`,
      [sessionId, userId, wordbookId],
    );
    if (!row) throw new NotFoundError("Session", sessionId);
  }

  async endSession(sessionId: string, userId: string, wordbookId: string): Promise<void> {
    const row = await this.queryOne<{ id: string }>(
      `UPDATE sessions
       SET ended_at = now(), updated_at = now()
       WHERE id = $1::uuid
         AND user_id = $2::uuid
         AND wordbook_id = $3::uuid
         AND ended_at IS NULL
       RETURNING id`,
      [sessionId, userId, wordbookId],
    );
    if (!row) throw new NotFoundError("Session", sessionId);
  }
}
