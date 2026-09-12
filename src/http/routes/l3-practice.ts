/**
 * L3 practice attempt / error book HTTP routes (ADR-0019 §1/§3).
 *
 * 独立前缀 /api/l3-practice，避开已挂载的 l3Routes（/api/l3）与触顶的
 * routes/l3/**。HTTP 薄层：解析 body/query、附加 auth userId、只调 service。
 *
 * attempt 记录零 FSRS：body 只接受练习事实 + payload 快照，payload.taskId 是
 * 幂等身份（必填，缺失即 400）；service 内 422 守卫保留做纵深防御。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import {
  l3PracticeAttemptCreateSchema,
  l3PracticeAttemptListQuerySchema,
  l3PracticeErrorBookQuerySchema,
} from "@/schemas/http";
import { validationError } from "../error-response";
import { asJson } from "./l3/shared";

export function l3PracticeRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // POST /attempts — 记录一次练习作答（幂等：同 user+taskId 返回既有行）。
  app.post("/attempts", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3PracticeAttemptCreateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Practice.recordAttempt({
      userId: c.get("userId"),
      contextId: parsed.data.contextId,
      occurrenceId: parsed.data.occurrenceId ?? null,
      sessionId: parsed.data.sessionId ?? null,
      practiceType: parsed.data.practiceType,
      outcome: parsed.data.outcome,
      payload: asJson(parsed.data.payload),
    });
    return c.json(result, 201);
  });

  // GET /attempts — 练习记录列表（practiceType/outcome/space/direction 过滤）。
  app.get("/attempts", async (c) => {
    const parsed = l3PracticeAttemptListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const page = await services.l3Practice.listAttempts({
      userId: c.get("userId"),
      practiceType: parsed.data.practiceType ?? null,
      outcome: parsed.data.outcome ?? null,
      space: parsed.data.space ?? null,
      direction: parsed.data.direction ?? null,
      limit: parsed.data.limit ?? null,
      offset: parsed.data.offset ?? null,
    });
    return c.json(page);
  });

  // GET /error-book — 错题库（attempts(outcome='wrong') 派生查询，条目附服务端
  // 聚合）。分页：cursor 纯新增，offset 保留；两者同时给出时以 cursor 为准。
  app.get("/error-book", async (c) => {
    const parsed = l3PracticeErrorBookQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const page = await services.l3Practice.errorBook({
      userId: c.get("userId"),
      space: parsed.data.space ?? null,
      direction: parsed.data.direction ?? null,
      limit: parsed.data.limit ?? null,
      offset: parsed.data.offset ?? null,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(page);
  });

  return app;
}
