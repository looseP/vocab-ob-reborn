/**
 * L2 drill-mode HTTP routes (双轨 spec).
 *
 * Architecture constraint (dependency-cruiser enforced):
 * - http layer must NOT import @/db or @/repositories directly.
 * - All data access goes through the injected `services.l2Drill` service.
 *
 * Drill flow (spec §一分支矩阵):
 *   GET  /queue        → 取到期 L2 卡（含 step0 任务，答案已剥离）
 *   POST /task/answer  → 辨析步应答（答案即 FSRS 调度；达阈建产出步/错即止）
 *   POST /self-assess  → 产出步自评（零 FSRS，只回填能力阶段）
 *   POST /undo         → 撤销本会话最近一步（仅产出自评可撤）
 *
 * 注意：完整 L2 应答路径已被辨析步吸收（辨析答案即 FSRS review），
 * 故不单独暴露 /answer。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import { l2SelfAssessSchema, l2TaskAnswerSchema, l2UndoSchema } from "@/schemas/http";
import { validationError } from "../error-response";

export function l2DrillRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // GET /queue — 到期 L2 卡队列（eager 建步 + 任务答案剥离）
  app.get("/queue", async (c) => {
    const userId = c.get("userId");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const queue = await services.l2Drill.getQueue(userId, wordbook.id, limit);
    return c.json(queue);
  });

  // POST /task/answer — 辨析步应答 → FSRS 调度
  app.post("/task/answer", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l2TaskAnswerSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const result = await services.l2Drill.submitTaskAnswer(parsed.data, userId);
    return c.json(result);
  });

  // POST /self-assess — 产出步自评（零 FSRS）
  app.post("/self-assess", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l2SelfAssessSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const result = await services.l2Drill.submitSelfAssessment(parsed.data, userId);
    return c.json(result);
  });

  // POST /undo — 撤销本会话最近一步（辨析步或产出步）
  app.post("/undo", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l2UndoSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    // M7 修复：透传 idempotencyKey，让服务层做撤销幂等检测
    const result = await services.l2Drill.undo(
      parsed.data.sessionId,
      userId,
      parsed.data.idempotencyKey,
    );
    return c.json(result);
  });

  return app;
}
