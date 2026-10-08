import { z } from "zod";

/**
 * M2 复习日历（2026-10-08）—— 两个**只读**端点。
 *
 * `GET /api/review/stats/calendar?days=N`：过去侧（已复习量）+ 今天（双值）+ 未来侧（到期量）。
 * `GET /api/review/day?date=YYYY-MM-DD&scope=due|reviewed&limit=N`：单日列词（只读展示，不进复习流）。
 *
 * 口径钉死（三条都与既有端一致，不同则日历与卡片会互相矛盾）：
 * ① 日历日 = Asia/Shanghai（`AT TIME ZONE` 切日）；
 * ② 未来侧排除 `state = 'suspended'`（挂起词不会被队列取出）；
 * ③ 过去侧与热力图同过滤（`rating IS NOT NULL`，按词去重）。
 */

/** 一天一桶。`date` 是 `YYYY-MM-DD`（显示时区日历日）。 */
export const dailyCountSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  count: z.number().int().nonnegative(),
}).strict();

export const reviewCalendarResponseSchema = z.object({
  /** 过去：该日**复习过多少张卡**（与热力图同口径）。只含有活动的日子。 */
  past: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reviewed: z.number().int().nonnegative(),
  }).strict()),
  /**
   * 今天：两个值都给 —— 已复习 x / 待做 y（`dueNow` 含积压，与仪表盘卡片同数）。
   * `date` 是**服务端**算的显示时区今天（`YYYY-MM-DD`）：前端据此构造日序列，
   * 不必依赖浏览器本地时区（客户端自己算会在跨时区/跨零点时与桶对不齐）。
   */
  today: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dueNow: z.number().int().nonnegative(),
    reviewedToday: z.number().int().nonnegative(),
  }).strict(),
  /** 未来：该日**到期多少张**（积压并入今天；不含挂起词）。只含有到期词的日子。 */
  future: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    due: z.number().int().nonnegative(),
  }).strict()),
}).strict();

export const reviewDayResponseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  scope: z.enum(["due", "reviewed"]),
  /** 该日的总数（与返回列表的截断无关）。 */
  total: z.number().int().nonnegative(),
  items: z.array(z.object({
    id: z.string(),
    slug: z.string(),
    title: z.string(),
    lemma: z.string(),
    shortDefinition: z.string().nullable(),
  }).strict()),
}).strict();
