/**
 * 评卷执行面路由（批次三①，ADR-0035）——独立薄路由直挂 server.ts
 * （sheets.ts 受复杂度棘轮约束不许增长，同 sheets-export/assessments 先例）。
 *
 * GET  /sheets/:id/grading-context  评卷上下文（agent 面；🔴 含答案——前端永不消费）
 * POST /sheets/:id/grading          评卷提交（agent 写面；graded_by 服务端认定）
 * GET  /sheets/:id/grading          解析模式读面（owner；verdict/analysis，前端消费）
 * POST /annotations/:id/confirm     owner 处置（submitted→confirmed，D18）
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3GradingSubmitSchema } from "@/schemas/http";
import { validationError } from "../../error-response";

export function gradingRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/sheets/:id/grading-context", async (c) => {
    return c.json(await services.l3Grading.getGradingContext(c.get("userId"), c.req.param("id")));
  });

  app.post("/sheets/:id/grading", async (c) => {
    const parsed = l3GradingSubmitSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    // graded_by 从服务端认定的 Principal 注入（agentId 仅 agent bearer 路径有值；
    // owner/session 路径无 → 'owner'）——请求体不携带该字段（strict 拒越权键）。
    const gradedBy = c.get("principal").agentId ?? "owner";
    return c.json(await services.l3Grading.submitGrading({
      userId: c.get("userId"),
      sheetId: c.req.param("id"),
      gradedBy,
      ...parsed.data,
    }));
  });

  app.get("/sheets/:id/grading", async (c) => {
    return c.json(await services.l3Grading.getGradingResults(c.get("userId"), c.req.param("id")));
  });

  app.post("/annotations/:id/confirm", async (c) => {
    return c.json(await services.l3Grading.confirmAnnotation(c.get("userId"), c.req.param("id")));
  });

  return app;
}
