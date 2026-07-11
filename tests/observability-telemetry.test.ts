import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import { HTTP_REQUESTS_METRIC_NAME, Telemetry } from "@/observability/telemetry";
import type { Services } from "@/services";

const token = "metrics-token-at-least-24-characters";

afterEach(() => {
  delete process.env.METRICS_BEARER_TOKEN;
});

function makeServices(): Services {
  return {
    runtimeStatus: {
      getReadiness: vi.fn(async () => ({ status: "ready", checks: { process: { status: "up" }, database: { status: "up" } } })),
      getMetrics: vi.fn(async () => ({
        process: { uptimeSeconds: 10, draining: false },
        database: { healthy: true, totalConnections: 2, idleConnections: 1, waitingRequests: 0 },
        outbox: { pending: 1, processing: 0, deadLetter: 0, oldestPendingAgeSeconds: 3 },
        llmReservations: { pending: 0, expiredPending: 0, oldestPendingAgeSeconds: 0 },
      })),
    },
    authSessions: { authenticate: vi.fn(async () => null) },
  } as unknown as Services;
}

describe("request telemetry", () => {
  it("generates a request ID and preserves a valid upstream UUID", async () => {
    const app = createApp(makeServices(), new Telemetry(false));
    const generated = await app.request("/healthz");
    expect(generated.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/);

    const supplied = "550e8400-e29b-41d4-a716-446655440000";
    const preserved = await app.request("/healthz", { headers: { "X-Request-ID": supplied } });
    expect(preserved.headers.get("X-Request-ID")).toBe(supplied);
  });

  it("rejects untrusted IDs and does not create path-cardinality labels", async () => {
    const telemetry = new Telemetry(false);
    const app = createApp(makeServices(), telemetry);
    const response = await app.request("/api/words/user-controlled-secret", {
      headers: { "X-Request-ID": "attacker-controlled" },
    });
    expect(response.headers.get("X-Request-ID")).not.toBe("attacker-controlled");
    const metrics = await telemetry.render();
    expect(metrics).toContain('route="/api/words/*"');
    expect(metrics).not.toContain("user-controlled-secret");
  });
});

describe("Prometheus endpoint", () => {
  it("fails closed without a dedicated token and exports bounded metrics when authorized", async () => {
    const telemetry = new Telemetry(false);
    const services = makeServices();
    const app = createApp(services, telemetry);
    expect((await app.request("/metrics")).status).toBe(401);

    process.env.METRICS_BEARER_TOKEN = token;
    expect((await app.request("/metrics", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    const response = await app.request("/metrics", { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    const body = await response.text();
    expect(body).toContain(HTTP_REQUESTS_METRIC_NAME);
    expect(body).toContain('metric="outbox_pending"');
    expect(services.runtimeStatus.getMetrics).toHaveBeenCalledTimes(1);
  });
});
