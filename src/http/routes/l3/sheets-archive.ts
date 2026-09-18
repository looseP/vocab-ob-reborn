/**
 * 题纸档案列表路由（F-1 回看闭环，2026-09-18）——独立薄路由（sheets.ts 受棘轮约束，
 * 沿 sheets-export/assessments/grading 先例拆分）。
 * GET /sheets?limit=1..100：owner-only 题纸档案（draft/sealed 新→旧，含已评计数与
 * 展示标题）——「历史题纸入口 + sheetId 深链」的数据源。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3SheetListQuerySchema } from "@/schemas/http";
import { validationError } from "../../error-response";

export function sheetsArchiveRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/sheets", async (c) => {
    const parsed = l3SheetListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Sheets.listArchive(c.get("userId"), parsed.data));
  });

  return app;
}
