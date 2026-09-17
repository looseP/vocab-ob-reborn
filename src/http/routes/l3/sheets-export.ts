/**
 * 题纸导出路由（批次二，ADR-0034 §6 / ADR-0025）——独立薄路由（sheets.ts 受棘轮约束）。
 * GET /sheets/:id/export?withAnswers=0|1（缺省按状态：draft=0 / sealed=1；discarded→409）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { parseSheetExportWithAnswers } from "@/schemas/http";

export function sheetsExportRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/sheets/:id/export", async (c) => {
    const withAnswers = parseSheetExportWithAnswers(c.req.query("withAnswers"));
    const result = await services.l3SheetExport.exportSheet(c.get("userId"), c.req.param("id"), { withAnswers });
    return c.body(result.markdown, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "X-Export-Schema-Version": String(result.schemaVersion),
      "X-Export-Sha256": result.sha256,
    });
  });

  return app;
}
