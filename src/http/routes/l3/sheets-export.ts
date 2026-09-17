/**
 * 题纸冻结导出路由（批次二收官，ADR-0034 §6 / ADR-0025）——独立薄路由：
 * sheets.ts 受复杂度棘轮约束（新增端点会超幅，棘轮不许已登记文件增长），
 * 沿 capabilities/summary 的「新端点独立薄路由 + server.ts 直挂」先例拆分。
 * GET /sheets/:id/export：Markdown 附件（Content-Disposition + 版本/sha256 响应头）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";

export function sheetsExportRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/sheets/:id/export", async (c) => {
    const result = await services.l3SheetExport.exportSheet(c.get("userId"), c.req.param("id"));
    return c.body(result.markdown, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "X-Export-Schema-Version": String(result.schemaVersion),
      "X-Export-Sha256": result.sha256,
    });
  });

  return app;
}
