/**
 * 作文子空间 · 按题批量进度读面（A2/I2，ADR《writing-workspace》§6 扩展）——独立薄路由
 * （writing-tasks.ts 受复杂度棘轮约束不许增长；同 capabilities/summary 先例）。
 *
 * GET /tasks/question-summaries?questionId=<uuid>&questionId=…&kind=&direction=
 *  - owner-only 只读；**零写、零创建**；原始重复参数 ≤100 先校验、去重后再查（单条集合查询）。
 *  - 静态路径须先于 `/tasks/:taskId` 注册（server.ts 挂载顺序），并有 HTTP 测试兜底防误匹配。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3WritingQuestionSummariesQuerySchema } from "@/schemas/http";
import { validationError } from "../../error-response";

export function writingSummariesRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/tasks/question-summaries", async (c) => {
    const parsed = l3WritingQuestionSummariesQuerySchema.safeParse({
      questionId: c.req.queries("questionId") ?? [],
      kind: c.req.query("kind"),
      direction: c.req.query("direction"),
    });
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const unique = [...new Set(parsed.data.questionId)];
    const items = await services.l3WritingTasks.questionSummaries(c.get("userId"), {
      questionIds: unique,
      kind: parsed.data.kind,
      direction: parsed.data.direction,
    });
    return c.json({ items });
  });

  return app;
}
