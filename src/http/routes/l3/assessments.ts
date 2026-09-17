/**
 * 评析区路由（批次二增补，ADR-0034 v2 条 10/11）——独立薄路由直挂 server.ts。
 *
 * agent 首个可写持久区（Amends ADR-0029）：GET/PUT minRole=agent；PUT 的
 * last_editor 按服务端认定 role 留痕；csrf 仅 session 路径生效（agent bearer 不受影响）。
 * 挂题不挂题纸：归属校验借道 l3Paper（404 语义同批次一）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3AssessmentUpsertSchema } from "@/schemas/http";
import { validationError } from "../../error-response";

export function assessmentsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/questions/:id/assessment", async (c) => {
    return c.json(await services.l3Assessments.getAssessment(c.get("userId"), c.req.param("id")));
  });

  app.put("/questions/:id/assessment", async (c) => {
    const parsed = l3AssessmentUpsertSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const editor = c.get("role") === "agent" ? "agent" : "owner";
    return c.json(await services.l3Assessments.putAssessment({
      userId: c.get("userId"),
      questionId: c.req.param("id"),
      editor,
      ...parsed.data,
    }));
  });

  return app;
}
