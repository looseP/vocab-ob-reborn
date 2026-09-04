import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { operationMetricsResponseSchema } from "@/http/operation-metrics-response-contract";
import { createApp } from "@/http/server";
import type { Services } from "@/services";

const originalToken = process.env.OWNER_API_TOKEN;
const originalOwner = process.env.LOCAL_OWNER_ID;

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "test-owner";
  process.env.LOCAL_OWNER_ID = "user-123";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = originalToken;
  process.env.LOCAL_OWNER_ID = originalOwner;
});

function makeServices(status: "ready" | "not_ready" = "ready"): Services {
  return {
    runtimeStatus: {
      getReadiness: vi.fn(async () => ({
        status,
        checks: {
          process: { status: status === "ready" ? "up" : "draining" },
          database: { status: status === "ready" ? "up" : "down" },
        },
      })),
      getMetrics: vi.fn(async () => ({
        process: { uptimeSeconds: 10, draining: false },
        database: { healthy: true, totalConnections: 2, idleConnections: 1, waitingRequests: 0 },
        outbox: { pending: 0, processing: 0, deadLetter: 0, oldestPendingAgeSeconds: null },
        llmReservations: { pending: 0, expiredPending: 0, oldestPendingAgeSeconds: 0 },
      })),
    },
    authSessions: {
      authenticate: vi.fn(async () => null),
    } as never,
  } as unknown as Services;
}

describe("observability HTTP endpoints", () => {
  it("keeps liveness dependency-free and public on both paths", async () => {
    const services = makeServices();
    const app = createApp(services);
    const healthz = await app.request("/healthz");
    expect(healthz.status).toBe(200);
    expect(await healthz.json()).toEqual({ status: "ok" });
    expect(healthz.headers.get("Cache-Control")).toBe("no-store");

    const legacy = await app.request("/health");
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual({ ok: true, service: "vocab-observatory-v2", phase: "1-http" });
    expect(legacy.headers.get("Cache-Control")).toBe("no-store");
    expect(services.runtimeStatus.getReadiness).not.toHaveBeenCalled();
  });

  it("returns 200 for ready and 503 with Retry-After for not ready", async () => {
    const ready = await createApp(makeServices("ready")).request("/readyz");
    expect(ready.status).toBe(200);

    const notReady = await createApp(makeServices("not_ready")).request("/readyz");
    expect(notReady.status).toBe(503);
    expect(notReady.headers.get("Retry-After")).toBe("1");
    expect(notReady.headers.get("Cache-Control")).toBe("no-store");
  });

  it("protects operational metrics with owner authentication", async () => {
    const services = makeServices();
    const app = createApp(services);
    const unauthorized = await app.request("/api/operations/metrics");
    expect(unauthorized.status).toBe(401);
    expect(services.runtimeStatus.getMetrics).not.toHaveBeenCalled();

    const authorized = await app.request("/api/operations/metrics", {
      headers: { Authorization: "Bearer test-owner" },
    });
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get("Cache-Control")).toBe("no-store");
    const body = operationMetricsResponseSchema.parse(await authorized.json());
    expect(body.database.healthy).toBe(true);
  });
});
