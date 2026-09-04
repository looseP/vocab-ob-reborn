/**
 * L2 LLM status HTTP route — Phase D.
 *
 * Split from routes/l2.ts to honor the route-complexity ratchet: adding
 * GET /llm-status to l2Routes would exceed its frozen line/route budget.
 * Mounted at /api/l2 by http/server.ts.
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";

export function l2LlmStatusRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // GET /llm-status (Phase D) — LLM 接入状态 + 今日预算水位（只读，无 LLM 调用）。
  // 用途：设置页"AI 扩展"卡；未配置时前端据此引导外部生成通道。
  app.get("/llm-status", async (c) => {
    return c.json(await services.l2content.getStatus());
  });

  return app;
}
