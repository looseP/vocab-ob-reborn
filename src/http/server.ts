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
import { resolveMinRole } from "./middleware/api-authorization";
import { wordRoutes, type AppEnv } from "./routes/words";
import { plazaRoutes } from "./routes/plaza";
import { reviewRoutes } from "./routes/review";
import { captureRoutes } from "./routes/capture";
import { importRoutes } from "./routes/imports";
import { wordbookRoutes } from "./routes/wordbooks";
import { noteRoutes } from "./routes/notes";
import { l2Routes } from "./routes/l2";
import { l2LlmStatusRoutes } from "./routes/l2-llm-status";
import { l2PromotionRoutes } from "./routes/l2-promotion";
import { l2CandidateRoutes } from "./routes/l2-candidates";
import { l2DrillRoutes } from "./routes/l2-drill";
import { l3Routes } from "./routes/l3";
import { l3ListsRoutes } from "./routes/l3/lists";
import { l3CapabilitiesRoutes } from "./routes/l3/capabilities";
import { l3SummaryRoutes } from "./routes/l3/summary";
import { l3SourceSpacesRoutes } from "./routes/l3/spaces";
import { papersRoutes } from "./routes/l3/papers";
import { annotationsRoutes } from "./routes/l3/annotations";
import { annotationsWithdrawRoutes } from "./routes/l3/annotations-withdraw";
import { sheetsRoutes } from "./routes/l3/sheets";
import { sheetsExportRoutes } from "./routes/l3/sheets-export";
import { upgradeWorkOrdersRoutes } from "./routes/upgrade-work-orders";
import { l3PracticeRoutes } from "./routes/l3-practice";
import { l3SessionsRoutes } from "./routes/l3-sessions";
import { forgettingRoutes } from "./routes/forgetting";
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

  // /api/* 按端点最小角色鉴权（ADR-0029 决策 1/2）：由注册表编译的 method+模板查找表
  // 决定每条路由所需角色（读 → agent，写 proposal → agent，其余写/升级动作 → owner）。
  // 查找表查不到的路由 fail-closed 按 owner（见 middleware/api-authorization.ts）。
  // 支持服务端 Bearer 或浏览器 HttpOnly Session；agent 走 bearer。
  app.use("/api/*", authMiddleware(services.authSessions, (c) => resolveMinRole(c.req.method, c.req.path)));

  app.get("/api/operations/metrics", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await services.runtimeStatus.getMetrics());
  });

  // 路由模块挂载
  app.route("/api/words", wordRoutes(services));
  app.route("/api/plaza", plazaRoutes(services));
  app.route("/api/review", reviewRoutes(services));
  app.route("/api/capture", captureRoutes(services));
  app.route("/api/imports", importRoutes(services));
  app.route("/api/wordbooks", wordbookRoutes(services));
  app.route("/api/notes", noteRoutes(services));
  app.route("/api/l2", l2Routes(services));
  // Phase D：llm-status 独立薄路由（l2.ts 受复杂度棘轮约束不可再加端点）
  app.route("/api/l2", l2LlmStatusRoutes(services));
  // Phase F：主动晋升入口（独立薄路由，同上）
  app.route("/api/l2", l2PromotionRoutes(services));
  // Phase G：Agent 候选池（独立薄路由，同上）
  app.route("/api/l2", l2CandidateRoutes(services));
  app.route("/api/l2-drill", l2DrillRoutes(services));
  app.route("/api/l3", l3Routes(services));
  // ADR-0029 §6 读面补缺：带 space/direction 两轴过滤的列表读 + occurrences /
  // context-links list（独立薄路由——sources.ts / reads.ts 受复杂度棘轮约束）。
  app.route("/api/l3", l3ListsRoutes(services));
  // ADR-0029 §8② 能力发现读面（独立薄路由——l3/index.ts 受复杂度棘轮冻结）。
  app.route("/api/l3", l3CapabilitiesRoutes());
  // B1 素材宇宙：空间汇总读面（独立薄路由——l3/index.ts 受复杂度棘轮冻结）。
  app.route("/api/l3", l3SummaryRoutes(services));
  // V0 能力域标签全量替换（独立薄路由——sources.ts 受复杂度棘轮冻结）。
  app.route("/api/l3", l3SourceSpacesRoutes(services));
  // ADR-0030：题目/试卷（试卷工作台 V1，独立薄路由——同 lists/summary 直挂先例）。
  app.route("/api/l3", papersRoutes(services));
  // 批次一：做题注记（原文分析）与规律标签字典（独立薄路由——index.ts 棘轮冻结）。
  app.route("/api/l3", annotationsRoutes(services));
  // v2 §4.7：注记撤回（annotations.ts 受棘轮约束，新端点独立薄路由拆分）。
  app.route("/api/l3", annotationsWithdrawRoutes(services));
  // 批次二：题纸（开纸/读/merge/定格）与作答历史（批量/软删）（独立薄路由——
  // index.ts 棘轮冻结，同 annotations/papers 先例直挂）。
  app.route("/api/l3", sheetsRoutes(services));
  // 批次二收官：题纸冻结导出（sheets.ts 受棘轮约束，新端点独立薄路由拆分）。
  app.route("/api/l3", sheetsExportRoutes(services));

  // W3/T09：升级工单 / L3 练习记录 / L3 会话计划 / 一键遗忘（独立薄路由，
  // 全部位于 owner 鉴权挂载之后）。
  app.route("/api/upgrade-work-orders", upgradeWorkOrdersRoutes(services));
  app.route("/api/l3-practice", l3PracticeRoutes(services));
  app.route("/api/l3-sessions", l3SessionsRoutes(services));
  app.route("/api/forgetting", forgettingRoutes(services));

  return app;
}
