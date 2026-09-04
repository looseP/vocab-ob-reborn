/**
 * StatsRepository — dashboard aggregation queries.
 *
 * M5 fix: streak calculation uses display timezone (Asia/Shanghai),
 * matching v1's toLocalDayKey / formatDayKey behavior.
 */

import type { ReviewRating } from "../domain";
import type { IStatsRepository, DashboardSummary, RatingDistribution } from "./interfaces";
import { BaseRepository } from "./base";
import { startOfTodayIsoInDisplayTz, todayKeyInDisplayTz } from "../db/timezone";

export class StatsRepository extends BaseRepository implements IStatsRepository {
  async getDashboardSummary(
    userId: string,
    wordbookId: string,
  ): Promise<DashboardSummary> {
    // M5 fix: use display timezone for "today" boundary
    const todayIso = startOfTodayIsoInDisplayTz();

    const [totalRow, trackedRow, dueRow, todayRow, weekRow, monthRow, notesRow, l2Row] =
      await Promise.all([
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM words WHERE is_deleted = false`,
        ),
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM user_word_progress
           WHERE user_id = $1 AND wordbook_id = $2::uuid`,
          [userId, wordbookId],
        ),
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM user_word_progress
           WHERE user_id = $1 AND wordbook_id = $2::uuid
             AND due_at IS NOT NULL AND due_at <= now()`,
          [userId, wordbookId],
        ),
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM review_logs
           WHERE user_id = $1 AND wordbook_id = $2::uuid
             AND reviewed_at >= $3`,
          [userId, wordbookId, todayIso],
        ),
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM review_logs
           WHERE user_id = $1 AND wordbook_id = $2::uuid
             AND reviewed_at >= now() - interval '7 days'`,
          [userId, wordbookId],
        ),
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM review_logs
           WHERE user_id = $1 AND wordbook_id = $2::uuid
             AND reviewed_at >= now() - interval '30 days'`,
          [userId, wordbookId],
        ),
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM notes
           WHERE user_id = $1 AND wordbook_id = $2::uuid`,
          [userId, wordbookId],
        ),
        // Phase E：双轨统计。promoted/dueNow 跨词书（与 l2_promoted EXISTS 口径一致），
        // weakSignal 属 L1 轨标记 → 词书 scope。单次往返三个标量子查询。
        this.queryOne<{ promoted: string; due_now: string; weak_signal: string }>(
          `SELECT
             (SELECT count(*) FROM user_word_l2_progress
              WHERE user_id = $1) AS promoted,
             (SELECT count(*) FROM user_word_l2_progress
              WHERE user_id = $1 AND l2_paused = false
                AND l2_due_at IS NOT NULL AND l2_due_at <= now()) AS due_now,
             (SELECT count(*) FROM user_word_progress
              WHERE user_id = $1 AND wordbook_id = $2::uuid AND l1_weak_signal = true) AS weak_signal`,
          [userId, wordbookId],
        ),
      ]);

    const streak = await this.calculateStreak(userId, wordbookId);

    return {
      totalWords: totalRow ? parseInt(totalRow.count, 10) : 0,
      trackedWords: trackedRow ? parseInt(trackedRow.count, 10) : 0,
      dueToday: dueRow ? parseInt(dueRow.count, 10) : 0,
      reviewedToday: todayRow ? parseInt(todayRow.count, 10) : 0,
      reviewed7d: weekRow ? parseInt(weekRow.count, 10) : 0,
      reviewed30d: monthRow ? parseInt(monthRow.count, 10) : 0,
      streakDays: streak,
      notesCount: notesRow ? parseInt(notesRow.count, 10) : 0,
      l2: {
        promoted: l2Row ? parseInt(l2Row.promoted, 10) : 0,
        dueNow: l2Row ? parseInt(l2Row.due_now, 10) : 0,
        weakSignal: l2Row ? parseInt(l2Row.weak_signal, 10) : 0,
      },
    };
  }

  async getRatingDistribution(
    userId: string,
    wordbookId: string,
    days = 30,
  ): Promise<RatingDistribution> {
    const rows = await this.query<{ rating: ReviewRating | null; count: string }>(
      `SELECT rating, count(*)::text AS count
       FROM review_logs
       WHERE user_id = $1 AND wordbook_id = $2::uuid
         AND reviewed_at >= now() - ($3::text || ' days')::interval
         AND rating IS NOT NULL
       GROUP BY rating`,
      [userId, wordbookId, String(days)],
    );

    const dist: RatingDistribution = { again: 0, hard: 0, good: 0, easy: 0 };
    for (const row of rows) {
      if (row.rating && row.rating in dist) {
        dist[row.rating] = parseInt(row.count, 10);
      }
    }
    return dist;
  }

  /**
   * M5 fix: Calculate streak using display timezone (Asia/Shanghai).
   * Matches v1's toLocalDayKey behavior — a review at 23:30 CST counts
   * as "today", not "tomorrow" in UTC.
   */
  private async calculateStreak(
    userId: string,
    wordbookId: string,
  ): Promise<number> {
    const row = await this.queryOne<{ streak_days: number | string }>(
      `WITH review_days AS (
         SELECT DISTINCT (reviewed_at AT TIME ZONE 'Asia/Shanghai')::date AS review_day
         FROM review_logs
         WHERE user_id = $1 AND wordbook_id = $2::uuid
         ORDER BY review_day DESC
         LIMIT 365
       ), numbered_days AS (
         SELECT review_day,
                row_number() OVER (ORDER BY review_day DESC) - 1 AS day_offset
         FROM review_days
       )
       SELECT count(review_day)::int AS streak_days
       FROM numbered_days
       WHERE review_day = $3::date - day_offset::int`,
      [userId, wordbookId, todayKeyInDisplayTz()],
    );

    return row ? Number(row.streak_days) : 0;
  }
}
