import { randomUUID } from "node:crypto";
import { HTTP_REQUESTS_METRIC_NAME } from "../src/observability/telemetry";

const baseUrl = process.env.SMOKE_BASE_URL;
const metricsToken = process.env.SMOKE_METRICS_BEARER_TOKEN;
if (!baseUrl || !metricsToken) throw new Error("SMOKE_BASE_URL and SMOKE_METRICS_BEARER_TOKEN are required");
const origin = new URL(baseUrl).origin;
if (process.env.NODE_ENV === "production" && !origin.startsWith("https://")) throw new Error("Production smoke target must use HTTPS");

async function request(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try { return await fetch(new URL(path, origin), { ...init, signal: controller.signal, redirect: "error" }); }
  finally { clearTimeout(timer); }
}

const requestId = randomUUID();
const health = await request("/healthz", { headers: { "X-Request-ID": requestId } });
if (!health.ok || health.headers.get("X-Request-ID") !== requestId) throw new Error("Health/request-ID smoke failed");
const ready = await request("/readyz");
if (!ready.ok) throw new Error(`Readiness smoke failed: ${ready.status}`);
const unauthorized = await request("/metrics");
if (unauthorized.status !== 401) throw new Error("Metrics endpoint must fail closed without token");
const metrics = await request("/metrics", { headers: { Authorization: `Bearer ${metricsToken}` } });
if (!metrics.ok || !(await metrics.text()).includes(HTTP_REQUESTS_METRIC_NAME)) throw new Error("Authorized metrics smoke failed");
console.log(JSON.stringify({ ok: true, origin, requestId, readiness: ready.status, metrics: metrics.status }));
