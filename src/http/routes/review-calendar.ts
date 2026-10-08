/**
 * M2 复习日历（2026-10-08）—— 独立薄路由文件，`server.ts` 直挂 `/api/review`。
 *
 * 为什么不塞进 `review.ts`：该文件受**路由棘轮**按基线冻结（行数也不许净增），
 * 仓库既有惯例是「新端点另立薄文件」（同 `l3/capabilities.ts`、`l3/summary.ts`、
 * `review-l3-contexts.ts` 先例）。
 *
 * 两个端点都是**纯只读**：不写入、不改调度、不动 FSRS（计划 §三 红线）。
 * query 参数在这里解析并钳制（与既有 `/heatmap` 同款，不进 ops query schema，
 * 因此不产生 openapi 参数变更）。
 */
import { Hono } from "hono";
import type { Services } from "../../services";
import type { AppEnv } from "./words";
import { jsonError } from "../error-response";
import { todayKeyInDisplayTz } from "../../db/timezone";

/** `days` 的允许区间（前端默认 30；上限防一次拉太宽）。 */
export const CALENDAR_DAYS_MIN = 1;
export const CALENDAR_DAYS_MAX = 180;
/** 单日列词的默认/上限条数。 */
export const DAY_WORDS_DEFAULT_LIMIT = 50;
export const DAY_WORDS_MAX_LIMIT = 200;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 形状正则只查 `\d{4}-\d{2}-\d{2}` —— `2026-13-99` 也能过，然后被 `$3::date` 在
 * Postgres 里炸成 500（2026-10-08 被端点测试抓到）。所以还要确认它是**真实存在**的
 * 日历日：解析一次再原样序列化，等不回来就拒绝。
 */
function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function reviewCalendarRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // GET /stats/calendar —— 过去（已复习量）+ 今天（双值）+ 未来（到期量）
  app.get("/stats/calendar", async (c) => {
    const userId = c.get("userId");
    const days = clampInt(c.req.query("days"), 30, CALENDAR_DAYS_MIN, CALENDAR_DAYS_MAX);
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const [pastRows, futureRows] = await Promise.all([
      services.reviews.getHeatmap(userId, wordbook.id, days),
      services.stats.getDailyDueCounts(userId, wordbook.id, days),
    ]);
    const past = pastRows.map((row) => ({ date: row.date, reviewed: Number(row.count) }));
    const future = futureRows.map((row) => ({ date: row.date, due: row.count }));
    // 「今天」两个值直接从两条序列里取 —— 不再多查一次汇总（少一次往返，
    // 也避免两处口径漂移：序列与卡片用的是同一个显示时区日历日）。
    const todayKey = todayKeyInDisplayTz();
    return c.json({
      past,
      today: {
        date: todayKey,
        dueNow: future.find((bucket) => bucket.date === todayKey)?.due ?? 0,
        reviewedToday: past.find((bucket) => bucket.date === todayKey)?.reviewed ?? 0,
      },
      future,
    });
  });

  // GET /day —— 某日历日的词表（只读展示）
  app.get("/day", async (c) => {
    const userId = c.get("userId");
    const date = c.req.query("date") ?? "";
    const scope = c.req.query("scope") ?? "due";
    if (!isCalendarDate(date) || (scope !== "due" && scope !== "reviewed")) {
      return jsonError(c, 400, "INVALID_REQUEST", "date must be a real YYYY-MM-DD date and scope must be due|reviewed");
    }
    const limit = clampInt(c.req.query("limit"), DAY_WORDS_DEFAULT_LIMIT, 1, DAY_WORDS_MAX_LIMIT);
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const result = await services.stats.getDayWords(userId, wordbook.id, date, scope, limit);
    return c.json({ date, scope, total: result.total, items: result.items });
  });

  return app;
}
