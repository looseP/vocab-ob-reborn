/**
 * 学习笔记（N1）·导出路由（薄；study-notes.ts 棘轮外拆分，同 sheets-export.ts 先例）。
 *
 * GET /api/l3/study-notes/:noteId/export
 *   只出不进的学习笔记档案（text/markdown；owner-only）。
 *   响应头四件套对齐题纸 v2 / 作文 v1 先例：Content-Type / Content-Disposition /
 *   X-Export-Schema-Version / X-Export-Sha256（与正文「内容校验」行同值）。
 *
 * **注册顺序**：本路由在 server.ts 中挂在 study-notes.ts **之前**（与
 * study-references.ts 同批），故 `/study-notes/reference-targets`、
 * `/study-notes/reference-preview`、`/study-notes/backlinks` 三个固定路径均先于
 * 动态 `/study-notes/:noteId` 注册；`export` 后缀段亦不会被详情路由吞掉
 * （详情路由只匹配 `/study-notes/:noteId` 的整段，不含子段）。
 *
 * 失败面（全部沿用既有状态码，不新造）：
 * - 非本人 / 不存在 → service 抛 NotFoundError → 404（owner-only）；
 * - `expectedVersion` 缺失或非数字 → ValidationError → 422（缺失由 service 抛）；
 * - 版本冲突 → ConflictError → 409（只回 currentVersion）；
 * - 非法 noteId（非 UUID）→ PG 22P02 全局映射 → 400（与详情/保存路径同口径）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  parseStudyNoteExportExpectedVersion,
  parseStudyNoteExportSchemaVersion,
} from "@/schemas/http";

export function studyNotesExportRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/study-notes/:noteId/export", async (c) => {
    const expectedVersion = parseStudyNoteExportExpectedVersion(c.req.query("expectedVersion"));
    const schemaVersion = parseStudyNoteExportSchemaVersion(c.req.query("schemaVersion"));
    const result = await services.l3StudyNoteExport.export(
      c.get("userId"),
      c.req.param("noteId"),
      { expectedVersion, schemaVersion },
    );
    return c.body(result.markdown, 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "X-Export-Schema-Version": String(result.schemaVersion),
      "X-Export-Sha256": result.sha256,
    });
  });

  return app;
}
