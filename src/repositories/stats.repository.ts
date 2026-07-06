/**
 * StatsRepository — dashboard aggregation queries.
 *
 * M5 fix: streak calculation uses display timezone (Asia/Shanghai),
 * matching v1's toLocalDayKey / formatDayKey behavior.
 */

import type { ReviewRating } from "../domain";
import type { IStatsRepository, DashboardSummary, RatingDistribution } from "./interfaces";
import { BaseRepository } from "./base";
import { startOfTodayIsoInDisplayTz, dayKeyInDisplayTz } from "../db/timezone";

export class StatsRepository extends BaseRepository implements IStatsRepository {
  async getDashboardSummary(
    userId: string,
    wordbookId: string,
  ): Promise<DashboardSummary> {
    // M5 fix: use display timezone for "today" boundary
    const todayIso = startOfTodayIsoInDisplayTz();

    const [totalRow, trackedRow, dueRow, todayRow, weekRow, monthRow, notesRow] =
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
    const rows = await this.query<{ reviewed_at: string }>(
      `SELECT DISTINCT reviewed_at
       FROM review_logs
       WHERE user_id = $1 AND wordbook_id = $2::uuid
       ORDER BY reviewed_at DESC
       LIMIT 365`,
      [userId, wordbookId],
    );

    if (rows.length === 0) return 0;

    // Convert to display-timezone day keys
    const reviewDays = new Set(rows.map((r) => dayKeyInDisplayTz(r.reviewed_at)));

    let streak = 0;
    const today = new Date();

    for (let i = 0; i < 365; i++) {
      const checkDate = new Date(today);
      checkDate.setDate(checkDate.getDate() - i);
      const dayKey = dayKeyInDisplayTz(checkDate);
      if (reviewDays.has(dayKey)) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }
}
