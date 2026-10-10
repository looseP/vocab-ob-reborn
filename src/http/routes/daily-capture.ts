/**
 * 每日捕获（Daily Capture，2026-10-10 M1 捕获侧）—— 独立薄路由，server.ts
 * 直挂 `/api/daily-capture`（新前缀，同 forgetting/hulu 先例）。
 *
 * M1 范围 = 「先记录」三件事 + 投影读面：
 *   POST /entries        追加一条（缺省今天；类型未知 422；秒回）
 *   GET  /types          类型注册表（**零写**——懒 seed 只发生在 POST /entries）
 *   GET  /days           日期流聚合（近 N 天，按日倒序）
 *   GET  /days/:date     当日条目 + 类型（M2 复盘面数据源）
 *   GET  /days/:date/file 日文件投影（text/markdown，确定性渲染）
 * M2 增补（§14 定稿）= 回顾面 + 类型管理：
 *   PATCH /entries/:id   回顾✓/置要/归档（状态前向流转 + meta.important）
 *   POST /types          新建自定义类型（key 冲突 409；可见上限 422）
 *   PATCH /types/:key    改名/提示/排序/隐藏（内置 key 可改名不可删）
 *
 * 权限口径（设计定稿 §12-拍板③）：**全部 owner**——日捕获是私人流水，
 * agent 读面只有 M3 的 export 证据包（届时单独登记）。GET /days 与 /days/:date
 * 的 limit/日期在路由内钳制（review-calendar 先例，不进 ops query schema）。
 */
import { Hono } from "hono";
import type { Services } from "../../services";
import type { AppEnv } from "./words";
import { jsonError, validationError } from "../error-response";
import {
  dailyCaptureAbsorbSchema,
  dailyCaptureEntryCreateSchema,
  dailyCaptureEntryPatchSchema,
  dailyCaptureTypeCreateSchema,
  dailyCaptureTypePatchSchema,
} from "@/schemas/http";
import {
  dailyCaptureAbsorbResponseSchema,
  dailyCaptureDayResponseSchema,
  dailyCaptureDaysResponseSchema,
  dailyCaptureEntryResponseSchema,
  dailyCaptureEvidencePackResponseSchema,
  dailyCaptureTypeResponseSchema,
  dailyCaptureTypesResponseSchema,
} from "../daily-capture-response-contract";

/** `limit` 的允许区间（前端默认 30；上限防一次拉太宽）。 */
export const DAYS_LIST_DEFAULT_LIMIT = 30;
export const DAYS_LIST_MAX_LIMIT = 180;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 形状正则只查 `\d{4}-\d{2}-\d{2}` —— `2026-13-99` 也能过，直通 SQL 的 `::date`
 * 会把它炸成 500（review-calendar 2026-10-08 被端点测试抓到过）。所以还要确认
 * 它是**真实存在**的日历日：解析一次再原样序列化，等不回来就拒绝。
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

export function dailyCaptureRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // POST /entries —— 追加一条（owner 写面；seq 服务端分配，秒回）。
  app.post("/entries", async (c) => {
    const parsed = dailyCaptureEntryCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    if (parsed.data.entryDate != null && !isCalendarDate(parsed.data.entryDate)) {
      return jsonError(c, 400, "INVALID_REQUEST", "entryDate must be a real YYYY-MM-DD date");
    }
    const userId = c.get("userId");
    const entry = await services.dailyCapture.appendEntry({
      userId,
      entryType: parsed.data.entryType,
      content: parsed.data.content,
      meta: parsed.data.meta ?? null,
      entryDate: parsed.data.entryDate,
    });
    // 契约先于序列化校验（capture-route 先例：契约漂移必须响亮地炸）。
    return c.json(dailyCaptureEntryResponseSchema.parse(entry), 201);
  });

  // GET /types —— 类型注册表（只读；懒 seed 只发生在 POST /entries）。
  app.get("/types", async (c) => {
    const types = await services.dailyCapture.listTypes(c.get("userId"));
    return c.json(dailyCaptureTypesResponseSchema.parse({ types }));
  });

  // GET /days —— 日期流聚合（limit 路由内钳制，不产生 openapi 参数变更）。
  app.get("/days", async (c) => {
    const limit = clampInt(c.req.query("limit"), DAYS_LIST_DEFAULT_LIMIT, 1, DAYS_LIST_MAX_LIMIT);
    const days = await services.dailyCapture.listDays(c.get("userId"), limit);
    return c.json(dailyCaptureDaysResponseSchema.parse({ days }));
  });

  // GET /days/:date —— 当日条目 + 类型（M2 复盘面数据源；M1 先按合同交付）。
  app.get("/days/:date", async (c) => {
    const date = c.req.param("date");
    if (!isCalendarDate(date)) {
      return jsonError(c, 400, "INVALID_REQUEST", "date must be a real YYYY-MM-DD date");
    }
    const day = await services.dailyCapture.getDay(c.get("userId"), date);
    return c.json(dailyCaptureDayResponseSchema.parse(day));
  });

  // GET /days/:date/file —— 日文件投影（text/markdown；捕获窗「复制当日文件」数据源）。
  app.get("/days/:date/file", async (c) => {
    const date = c.req.param("date");
    if (!isCalendarDate(date)) {
      return jsonError(c, 400, "INVALID_REQUEST", "date must be a real YYYY-MM-DD date");
    }
    const { markdown } = await services.dailyCapture.getDayFile(c.get("userId"), date);
    return c.body(markdown, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });

  // ── M2 回顾面（2026-10-10 §14 定稿）───────────────────────────────────────

  // PATCH /entries/:id —— 回顾✓/置要/归档（状态前向流转 + meta.important 合并；
  // 同状态幂等 no-op；archived/absorbed 终态 → 422；未命中/已隐藏 → 404）。
  app.patch("/entries/:id", async (c) => {
    const parsed = dailyCaptureEntryPatchSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const entry = await services.dailyCapture.patchEntry(userId, c.req.param("id"), parsed.data);
    return c.json(dailyCaptureEntryResponseSchema.parse(entry));
  });

  // POST /types —— 新建自定义类型（key 冲突 409；可见上限 422；seed 先行再计上限）。
  app.post("/types", async (c) => {
    const parsed = dailyCaptureTypeCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const type = await services.dailyCapture.createType(userId, parsed.data);
    return c.json(dailyCaptureTypeResponseSchema.parse(type), 201);
  });

  // PATCH /types/:key —— 改名/提示/排序/隐藏（内置 key 可改名不可删；unhide 超上限 422）。
  app.patch("/types/:key", async (c) => {
    const parsed = dailyCaptureTypePatchSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const type = await services.dailyCapture.patchType(userId, c.req.param("key"), parsed.data);
    return c.json(dailyCaptureTypeResponseSchema.parse(type));
  });

  // ── M3 吸收侧（§9，proposal-only 的「执行」半边）───────────────────────────

  // GET /days/:date/export —— 证据包导出。**agent 唯一读面**（§14 拍板③落地）：
  // markdown（人读）+ 结构化条目（稳定 ID / absorption_hint / 关联词语境计数）。
  app.get("/days/:date/export", async (c) => {
    const date = c.req.param("date");
    if (!isCalendarDate(date)) {
      return jsonError(c, 400, "INVALID_REQUEST", "date must be a real YYYY-MM-DD date");
    }
    const pack = await services.dailyCapture.getEvidencePack(c.get("userId"), date);
    return c.json(dailyCaptureEvidencePackResponseSchema.parse(pack));
  });

  // POST /entries/:id/absorb —— 采纳提案并执行（owner 采纳，agent 永不直写）：
  // bind_l3 复用三件套管道（同句同词判重幂等）；add_word 入默认词书；
  // enqueue_review 走 insertNewCard（原子幂等）；file_method/rewrite 留档；none 归档。
  app.post("/entries/:id/absorb", async (c) => {
    const parsed = dailyCaptureAbsorbSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    let wordbookId = parsed.data.wordbookId;
    if ((parsed.data.action === "add_word" || parsed.data.action === "enqueue_review") && !wordbookId) {
      wordbookId = (await services.wordbooks.getOrCreateDefault(userId)).id;
    }
    const result = await services.dailyCapture.absorbEntry({
      userId,
      id: c.req.param("id"),
      action: parsed.data.action,
      wordSlug: parsed.data.wordSlug,
      payload: parsed.data.payload,
      reason: parsed.data.reason,
      wordbookId,
    });
    return c.json(dailyCaptureAbsorbResponseSchema.parse(result));
  });

  return app;
}
