/**
 * HTTP 应用工厂 —— Phase 1
 *
 * /health 保持公开；/api/* 全部经 authMiddleware("owner") 鉴权后委派给路由模块。
 * 路由模块只依赖 @/services，绝不直连 @/db 或 @/repositories（dependency-cruiser 强制）。
 *
 * 架构约束（dependency-cruiser 强制）：
 * - http 层不得直连 db/repositories，必须通过 service
 * - http 层不得直接调 llm provider，必须通过 service
 */
import { Hono } from "hono";
import type { Services } from "../services";
import { handleError } from "./middleware/error";
import { authMiddleware } from "./middleware/auth";
import { wordRoutes, type AppEnv } from "./routes/words";
import { reviewRoutes } from "./routes/review";
import { l2Routes } from "./routes/l2";
import { l3Routes } from "./routes/l3";

export function createApp(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // 全局错误处理：AppError 子类映射到对应 HTTP 状态码
  app.onError(handleError);

  // 健康检查（公开，无需鉴权）
  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "vocab-observatory-v2",
      phase: "1-http",
    });
  });

  // /api/* 需 owner 角色；authMiddleware 注入 role / userId 到 context
  app.use("/api/*", authMiddleware("owner"));

  // 路由模块挂载
  app.route("/api/words", wordRoutes(services));
  app.route("/api/review", reviewRoutes(services));
  app.route("/api/l2", l2Routes(services));
  app.route("/api/l3", l3Routes(services));

  return app;
}
