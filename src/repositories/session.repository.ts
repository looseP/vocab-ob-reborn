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
    // M5 fix: use display timezone for "today" boundary (matches v1)
    const todayIso = startOfTodayIsoInDisplayTz();
    const existing = await this.findActiveByUser(userId, wordbookId, mode);

    if (existing && existing.started_at >= todayIso) {
      return existing;
    }

    // Create new session first (so failure leaves old one active)
    const created = await this.create(userId, wordbookId, mode);

    // Best-effort: end the previous session
    if (existing) {
      await this.query(
        `UPDATE sessions SET ended_at = now() WHERE id = $1`,
        [existing.id],
      );
    }

    return created;
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

  async incrementCardsSeen(sessionId: string): Promise<void> {
    // FIX-001: Use atomic RPC to prevent lost increments under concurrency.
    await this.query(
      `SELECT increment_session_cards_seen($1::uuid)`,
      [sessionId],
    );
  }

  async endSession(sessionId: string): Promise<void> {
    await this.query(
      `UPDATE sessions SET ended_at = now() WHERE id = $1::uuid`,
      [sessionId],
    );
  }
}
