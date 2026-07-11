import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { logger } from "../../observability/logger";
import type { Telemetry } from "../../observability/telemetry";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TelemetryEnv {
  Variables: {
    requestId: string;
  };
}

function stableRoute(path: string): string {
  if (path === "/health" || path === "/healthz" || path === "/readyz" || path === "/metrics") return path;
  if (path.startsWith("/api/auth")) return "/api/auth/*";
  if (path.startsWith("/api/operations")) return "/api/operations/*";
  if (path.startsWith("/api/words")) return "/api/words/*";
  if (path.startsWith("/api/review")) return "/api/review/*";
  if (path.startsWith("/api/l2")) return "/api/l2/*";
  if (path.startsWith("/api/l3")) return "/api/l3/*";
  return "unmatched";
}

export function requestTelemetry(telemetry: Telemetry): MiddlewareHandler<TelemetryEnv> {
  return async (c, next) => {
    const supplied = c.req.header("x-request-id")?.trim();
    const requestId = supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied.toLowerCase() : randomUUID();
    const started = performance.now();
    c.set("requestId", requestId);
    c.header("X-Request-ID", requestId);

    await next();

    const durationMs = Math.max(0, performance.now() - started);
    const route = stableRoute(c.req.path);
    telemetry.observeHttp(c.req.method, route, c.res.status, durationMs / 1_000);
    logger.info("http", "Request completed", {
      requestId,
      method: c.req.method,
      route,
      status: c.res.status,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  };
}

export function isMetricsAuthorized(authorization: string | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken || expectedToken.length < 24) return false;
  return authorization === `Bearer ${expectedToken}`;
}
