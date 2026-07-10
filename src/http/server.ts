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
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { Services } from "../services";
import { API_JSON_BODY_MAX_BYTES } from "../schemas/resource-budget";
import { handleError } from "./middleware/error";
import { authMiddleware } from "./middleware/auth";
import { wordRoutes, type AppEnv } from "./routes/words";
import { reviewRoutes } from "./routes/review";
import { l2Routes } from "./routes/l2";
import { l3Routes } from "./routes/l3";
import { authRoutes } from "./routes/auth";
import { problemDetails } from "../errors";

export function createApp(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // 全局错误处理：AppError 子类映射到对应 HTTP 状态码
  app.onError(handleError);
  app.use("*", secureHeaders({
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    referrerPolicy: "no-referrer",
  }));

  // 健康检查（公开，无需鉴权）
  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "vocab-observatory-v2",
      phase: "1-http",
    });
  });

  // Reject oversized API bodies before auth or route handlers parse them.
  app.use("/api/*", bodyLimit({
    maxSize: API_JSON_BODY_MAX_BYTES,
    onError: (c) => c.json(
      problemDetails(413, "PAYLOAD_TOO_LARGE", "Request body exceeds 1 MiB limit", { instance: c.req.path }),
      413,
    ),
  }));

  // Browser sessions are exchanged here before the protected /api middleware.
  app.route("/api/auth", authRoutes(services));

  // /api/* 需 owner 角色；支持服务端 Bearer 或浏览器 HttpOnly Session。
  app.use("/api/*", authMiddleware(services.authSessions, "owner"));

  // 路由模块挂载
  app.route("/api/words", wordRoutes(services));
  app.route("/api/review", reviewRoutes(services));
  app.route("/api/l2", l2Routes(services));
  app.route("/api/l3", l3Routes(services));

  return app;
}
