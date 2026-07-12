/**
 * HTTP 应用工厂 —— Phase 1
 *
 * /healthz、/health、/readyz 保持公开；运行指标经 owner 鉴权；其余 /api/* 委派给业务路由。
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
import { requestTelemetry, isMetricsAuthorized } from "./middleware/telemetry";
import { jsonError } from "./error-response";
import { telemetry, type Telemetry } from "../observability/telemetry";

export function createApp(services: Services, metrics: Telemetry = telemetry): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // 全局错误处理：AppError 子类映射到对应 HTTP 状态码
  app.onError(handleError);
  app.use("*", requestTelemetry(metrics));
  app.use("*", secureHeaders({
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    referrerPolicy: "no-referrer",
  }));

  // Liveness is dependency-free: DB failures must not cause restart storms.
  app.get("/healthz", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ status: "ok" });
  });
  app.get("/health", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      ok: true,
      service: "vocab-observatory-v2",
      phase: "1-http",
    });
  });

  app.get("/readyz", async (c) => {
    c.header("Cache-Control", "no-store");
    const readiness = await services.runtimeStatus.getReadiness();
    if (readiness.status === "not_ready") {
      c.header("Retry-After", "1");
      return c.json(readiness, 503);
    }
    return c.json(readiness);
  });

  app.get("/metrics", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!isMetricsAuthorized(c.req.header("authorization"), process.env.METRICS_BEARER_TOKEN)) {
      c.header("WWW-Authenticate", "Bearer");
      return c.text("Unauthorized", 401);
    }
    try {
      metrics.setRuntime(await services.runtimeStatus.getMetrics());
      c.header("Content-Type", metrics.contentType);
      return c.body(await metrics.render());
    } catch {
      return c.text("Metrics unavailable", 503);
    }
  });

  // Reject oversized API bodies before auth or route handlers parse them.
  app.use("/api/*", bodyLimit({
    maxSize: API_JSON_BODY_MAX_BYTES,
    onError: (c) => jsonError(c, 413, "PAYLOAD_TOO_LARGE", "Request body exceeds 1 MiB limit"),
  }));

  // Browser sessions are exchanged here before the protected /api middleware.
  app.route("/api/auth", authRoutes(services));

  // /api/* 需 owner 角色；支持服务端 Bearer 或浏览器 HttpOnly Session。
  app.use("/api/*", authMiddleware(services.authSessions, "owner"));

  app.get("/api/operations/metrics", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await services.runtimeStatus.getMetrics());
  });

  // 路由模块挂载
  app.route("/api/words", wordRoutes(services));
  app.route("/api/review", reviewRoutes(services));
  app.route("/api/l2", l2Routes(services));
  app.route("/api/l3", l3Routes(services));

  return app;
}
