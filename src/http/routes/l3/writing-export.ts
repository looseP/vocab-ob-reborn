/**
 * 作文子空间 · 导出与正文清理路由（W9，ADR《writing-workspace》§7）。
 * 挂载前缀与其余作文路由一致：/api/l3/writing（由 server.ts 统一接入）。
 *
 * GET    /tasks/:taskId/sheets/:sheetId/export   单稿导出（owner-only；text/markdown；
 *        响应头携带 schema 版本与 sha256——对齐 sheets-export.ts 先例）
 * DELETE /tasks/:taskId/sheets/:sheetId/content  正文清理（owner-only；soft-delete
 *        attempt + 同事务删反馈；sealed 限定、幂等；直接返回 sheet DTO）
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";

export function writingExportRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/tasks/:taskId/sheets/:sheetId/export", async (c) => {
    const result = await services.l3WritingExport.exportSheet(
      c.get("userId"),
      c.req.param("taskId"),
      c.req.param("sheetId"),
    );
    return c.body(result.markdown, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "X-Export-Schema-Version": String(result.schemaVersion),
      "X-Export-Sha256": result.sha256,
    });
  });

  app.delete("/tasks/:taskId/sheets/:sheetId/content", async (c) => {
    return c.json(await services.l3WritingSheets.clearRevisionContent(
      c.get("userId"),
      c.req.param("taskId"),
      c.req.param("sheetId"),
    ));
  });

  return app;
}
