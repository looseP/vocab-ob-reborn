/**
 * StatsRepository — dashboard aggregation queries.
 *
 * M5 fix: streak calculation uses display timezone (Asia/Shanghai),
 * matching v1's toLocalDayKey / formatDayKey behavior.
 */

import type { ReviewRating } from "../domain";
import type {
  IStatsRepository,
  DashboardSummary,
  RatingDistribution,
  DueForecastBucket,
  DailyCount,
  DayScope,
  DayWordBrief,
} from "./interfaces";
import { BaseRepository } from "./base";
import { startOfTodayIsoInDisplayTz, todayKeyInDisplayTz } from "../db/timezone";

export class StatsRepository extends BaseRepository implements IStatsRepository {
  async getDashboardSummary(
    userId: string,
    wordbookId: string,
  ): Promise<DashboardSummary> {
    // M5 fix: use display timezone for "today" boundary
    const todayIso = startOfTodayIsoInDisplayTz();

    const [totalRow, trackedRow, progressRow, todayRow, weekRow, monthRow, notesRow, l2Row] =
      await Promise.all([
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM words WHERE is_deleted = false`,
        ),
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM user_word_progress
           WHERE user_id = $1 AND wordbook_id = $2::uuid`,
          [userId, wordbookId],
        ),
        // 一次往返出两个指标（保持「8 并行查询 + 1 streak」的调用数不变）：
        //  - `due_count`「今天待复习」：到期且**未挂起**。挂起词不计待复习 —— 复习队列
        //    本来就排除它们，此前仪表盘不排除 ⇒ 同一件事两个数（D4）。
        //  - `mastered_count`「已掌握」：`state = 'review'` 的词数。**不是**
        //    `totalWords - dueToday`（那会把「今天没到期」当「已掌握」，见接口注释）。
        this.queryOne<{ due_count: string; mastered_count: string }>(
          `SELECT count(*) FILTER (WHERE due_at IS NOT NULL AND due_at <= now() AND state <> 'suspended') AS due_count,
                  count(*) FILTER (WHERE state = 'review') AS mastered_count
             FROM user_word_progress
            WHERE user_id = $1 AND wordbook_id = $2::uuid`,
          [userId, wordbookId],
        ),
        // 作答口径（CONTEXT.md「Event log semantics」）：reviewedToday/7d/30d 只计
        // 作答事件，rating IS NULL 的非作答事件（L2 seed 审计行）不计入。
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM review_logs
           WHERE user_id = $1 AND wordbook_id = $2::uuid
             AND reviewed_at >= $3
             AND rating IS NOT NULL`,
          [userId, wordbookId, todayIso],
        ),
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM review_logs
           WHERE user_id = $1 AND wordbook_id = $2::uuid
             AND reviewed_at >= now() - interval '7 days'
             AND rating IS NOT NULL`,
          [userId, wordbookId],
        ),
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM review_logs
           WHERE user_id = $1 AND wordbook_id = $2::uuid
             AND reviewed_at >= now() - interval '30 days'
             AND rating IS NOT NULL`,
          [userId, wordbookId],
        ),
        this.queryOne<{ count: string }>(
          `SELECT count(*) FROM note_entries
           WHERE user_id = $1 AND wordbook_id = $2::uuid`,
          [userId, wordbookId],
        ),
        // Phase E：双轨统计。scope 说明（CONTEXT.md「Counter scope」）：
        //   promoted / dueNow 跨词书（与 l2_promoted EXISTS 口径一致）；
        //   weakSignal（L1 轨标记）与 reviewedToday（L2 作答计数）均按**词书** scope。
        // 单次往返四个标量子查询 —— 保持"8 并行查询 + 1 streak"的调用数不变。
        this.queryOne<{ promoted: string; due_now: string; weak_signal: string; l2_reviewed_today: string }>(
          `SELECT
             (SELECT count(*) FROM user_word_l2_progress
              WHERE user_id = $1) AS promoted,
             (SELECT count(*) FROM user_word_l2_progress
              WHERE user_id = $1 AND l2_paused = false
                AND l2_due_at IS NOT NULL AND l2_due_at <= now()) AS due_now,
             (SELECT count(*) FROM user_word_progress
              WHERE user_id = $1 AND wordbook_id = $2::uuid AND l1_weak_signal = true) AS weak_signal,
             (SELECT count(*) FROM review_logs
              WHERE user_id = $1 AND wordbook_id = $2::uuid
                AND track = 'l2' AND rating IS NOT NULL
                AND reviewed_at >= $3) AS l2_reviewed_today`,
          [userId, wordbookId, todayIso],
        ),
      ]);

    const streak = await this.calculateStreak(userId, wordbookId);

    return {
      totalWords: totalRow ? parseInt(totalRow.count, 10) : 0,
      trackedWords: trackedRow ? parseInt(trackedRow.count, 10) : 0,
      dueToday: progressRow ? parseInt(progressRow.due_count, 10) : 0,
      masteredWords: progressRow ? parseInt(progressRow.mastered_count, 10) : 0,
      reviewedToday: todayRow ? parseInt(todayRow.count, 10) : 0,
      reviewed7d: weekRow ? parseInt(weekRow.count, 10) : 0,
      reviewed30d: monthRow ? parseInt(monthRow.count, 10) : 0,
      streakDays: streak,
      notesCount: notesRow ? parseInt(notesRow.count, 10) : 0,
      l2: {
        promoted: l2Row ? parseInt(l2Row.promoted, 10) : 0,
        dueNow: l2Row ? parseInt(l2Row.due_now, 10) : 0,
        weakSignal: l2Row ? parseInt(l2Row.weak_signal, 10) : 0,
        // L2-only 作答口径（CONTEXT.md「Counter scope」）：今日 L2 作答数，按词书；
        // 与全轨 reviewedToday 同一 Asia/Shanghai 日界（复用 todayIso）。
        reviewedToday: l2Row ? parseInt(l2Row.l2_reviewed_today, 10) : 0,
      },
    };
  }

  /**
   * M1 · 真实到期预测（2026-10-07）—— 取代 `dueToday × 1.5 / × 2` 的假推算。
   *
   * 三条口径都必须照做，缺一条就会与别处对不上：
   *
   * ① **日历日**边界：窗口上沿 = 显示时区（Asia/Shanghai）今日零点 + horizon 天，
   *    复用 `startOfTodayIsoInDisplayTz()` —— 与 dueToday / reviewedToday 同一个日界
   *    （不是从 now() 起滚动的 N×24 小时）。
   * ② **累计、不设下沿**：`due_at <= 今日零点 + horizon`。**实测结论**（2026-10-07 自用栈）：
   *    14 个待复习词的 `due_at` 全部 ≤ 今日零点（积压），若照设计稿加
   *    `due_at > 今日零点` 的下沿，due7d 会算成 **0** 而 dueNow 是 14 ——
   *    「未来 7 天预计复习」比「今天待复习」还少。累计口径同时给出
   *    dueNow ≤ due7d ≤ due14d 的单调性。
   * ③ **排除 `suspended`**：挂起词不会被复习队列取出（`review.repository` 的队列 SQL
   *    一律 `state != 'suspended'`），预测里算上它们是虚报。注意 `dueToday` 口径**没有**
   *    这条过滤（既有差异，本方法不动它；自用栈当前 0 个挂起词，未显现）。
   *
   * 单条往返：一次 `unnest` 出所有 horizon，每个 horizon 一个标量子查询。
   */
  async getDueForecast(
    userId: string,
    wordbookId: string,
    horizons: readonly number[],
  ): Promise<DueForecastBucket[]> {
    const todayIso = startOfTodayIsoInDisplayTz();
    const rows = await this.query<{ horizon_days: number; count: string }>(
      `SELECT h.horizon_days,
              (SELECT count(*) FROM user_word_progress uwp
                WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
                  AND uwp.state <> 'suspended'
                  AND uwp.due_at IS NOT NULL
                  AND uwp.due_at <= $3::timestamptz + make_interval(days => h.horizon_days))::text AS count
       FROM unnest($4::int[]) AS h(horizon_days)
       ORDER BY h.horizon_days`,
      [userId, wordbookId, todayIso, [...horizons]],
    );

    return rows.map((row) => ({
      horizonDays: Number(row.horizon_days),
      count: parseInt(row.count, 10),
    }));
  }

  /**
   * M2（2026-10-08）· 日历**未来侧**：`due_at` 按显示时区日历日分桶。
   *
   * 两条口径与 `getDueForecast` / `dueToday` 保持一致，否则日历与卡片会对不上：
   * ① 日历日边界 = Asia/Shanghai（`AT TIME ZONE` 切日，非 UTC）；
   * ② `state <> 'suspended'` 不计（挂起词不会被队列取出）。
   *
   * **积压并入「今天」**：`due_at < 今天零点` 的到期词（2026-10-07 实测自用栈 14 张全属此类）
   * 用 `greatest(日, 今天)` 归到今天那一桶 —— 它们今天就要做，日历上空着会让
   * 「今天」徽标显示 14 而柱子是 0，自相矛盾。
   */
  async getDailyDueCounts(
    userId: string,
    wordbookId: string,
    days: number,
  ): Promise<{ todayDate: string; buckets: DailyCount[] }> {
    const todayIso = startOfTodayIsoInDisplayTz();
    const rows = await this.query<{ date: string; count: string }>(
      `SELECT greatest((uwp.due_at AT TIME ZONE 'Asia/Shanghai')::date, $3::date)::text AS date,
              count(*)::text AS count
         FROM user_word_progress uwp
        WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
          AND uwp.state <> 'suspended'
          AND uwp.due_at IS NOT NULL
          AND uwp.due_at <= $3::timestamptz + make_interval(days => $4::int)
        GROUP BY 1
        ORDER BY 1`,
      [userId, wordbookId, todayIso, days],
    );
    return {
      todayDate: todayKeyInDisplayTz(),
      buckets: rows.map((row) => ({ date: row.date, count: parseInt(row.count, 10) })),
    };
  }

  /**
   * M2 · 日历**单日列词**（只读展示，不进复习流）。
   *
   * - `scope = 'due'`：该日到期的词（挂起词排除，与队列一致）；
   * - `scope = 'reviewed'`：该日**复习过**的词，**按词去重**（同日多次作答只算一张卡）。
   *   过滤口径与既有热力图一致（`rating IS NOT NULL`，不过滤 `undone`）——
   *   计划里的验收项就是「日历过去列与既有热力图对得上」。
   *
   * `total` 用窗口函数在 LIMIT 之前算全量，与返回的 `items` 截断无关。
   */
  async getDayWords(
    userId: string,
    wordbookId: string,
    date: string,
    scope: DayScope,
    limit: number,
  ): Promise<{ total: number; items: DayWordBrief[] }> {
    const select =
      `SELECT w.id, w.slug, w.title, w.lemma, w.short_definition, count(*) OVER ()::text AS total`;
    const rows =
      scope === "due"
        ? await this.query<{
            id: string;
            slug: string;
            title: string;
            lemma: string;
            short_definition: string | null;
            total: string;
          }>(
            `${select}
               FROM user_word_progress uwp
               JOIN words w ON w.id = uwp.word_id
              WHERE uwp.user_id = $1 AND uwp.wordbook_id = $2::uuid
                AND uwp.state <> 'suspended'
                AND uwp.due_at IS NOT NULL
                AND (uwp.due_at AT TIME ZONE 'Asia/Shanghai')::date = $3::date
              ORDER BY w.lemma
              LIMIT $4`,
            [userId, wordbookId, date, limit],
          )
        : await this.query<{
            id: string;
            slug: string;
            title: string;
            lemma: string;
            short_definition: string | null;
            total: string;
          }>(
            `${select}
               FROM (
                 SELECT DISTINCT rl.word_id
                   FROM review_logs rl
                  WHERE rl.user_id = $1 AND rl.wordbook_id = $2
                    AND rl.rating IS NOT NULL
                    AND (rl.reviewed_at AT TIME ZONE 'Asia/Shanghai')::date = $3::date
               ) day_words
               JOIN words w ON w.id = day_words.word_id
              ORDER BY w.lemma
              LIMIT $4`,
            [userId, wordbookId, date, limit],
          );

    return {
      total: rows.length === 0 ? 0 : parseInt(rows[0].total, 10),
      items: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        title: row.title,
        lemma: row.lemma,
        shortDefinition: row.short_definition,
      })),
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
    // streakDays = 活动口径（CONTEXT.md「Event log semantics」Activity counter）：
    // 只问"当天是否学习过"，故**故意不过滤 rating** —— 任何写入的日志事件（含
    // 非作答的 seed 行）都代表一次学习活动，升级日也是学习日。
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
