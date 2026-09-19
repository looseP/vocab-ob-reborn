/**
 * 题纸导出路由（ADR-0034 §6；sheets.ts 棘轮外拆分）。V：draft 核对 expectedVersion（缺失/旧拒）；sealed 忽略。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { parseSheetExportExpectedVersion, parseSheetExportWithAnswers } from "@/schemas/http";

export function sheetsExportRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/sheets/:id/export", async (c) => {
    const withAnswers = parseSheetExportWithAnswers(c.req.query("withAnswers"));
    const expectedVersion = parseSheetExportExpectedVersion(c.req.query("expectedVersion"));
    const result = await services.l3SheetExport.exportSheet(c.get("userId"), c.req.param("id"), { withAnswers, expectedVersion });
    return c.body(result.markdown, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "X-Export-Schema-Version": String(result.schemaVersion),
      "X-Export-Sha256": result.sha256,
    });
  });

  return app;
}
