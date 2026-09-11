import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { isMetricsAuthorized, requestTelemetry } from "@/http/middleware/telemetry";
import { Telemetry } from "@/observability/telemetry";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPPLIED_REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Hono {
  const app = new Hono();
  app.use("*", requestTelemetry(new Telemetry(false)));
  app.get("/api/words/:slug", (c) => c.json({ ok: true }));
  app.get("/healthz", (c) => c.text("ok"));
  return app;
}

function captureLogEntries(): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const [first] = args;
    if (typeof first === "string") entries.push(JSON.parse(first) as Record<string, unknown>);
  });
  return entries;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestTelemetry request-id correlation", () => {
  it("echoes a valid client X-Request-ID and promotes it to a top-level log field", async () => {
    const entries = captureLogEntries();
    const res = await makeApp().request("/api/words/hello", {
      headers: { "x-request-id": SUPPLIED_REQUEST_ID },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-ID")).toBe(SUPPLIED_REQUEST_ID);

    const log = entries.find((entry) => entry.msg === "Request completed");
    expect(log).toBeDefined();
    expect(log?.requestId).toBe(SUPPLIED_REQUEST_ID);
    // The header the client sees and the field the operator greps are identical.
    expect(log?.requestId).toBe(res.headers.get("X-Request-ID"));
    // requestId is a first-class field, never buried inside meta.
    expect((log?.meta as Record<string, unknown> | undefined)?.requestId).toBeUndefined();
    expect(log?.meta).toMatchObject({ method: "GET", route: "/api/words/*", status: 200 });
  });

  it("replaces an invalid supplied id with a generated one and keeps both sides aligned", async () => {
    const entries = captureLogEntries();
    const res = await makeApp().request("/healthz", {
      headers: { "x-request-id": "not-a-uuid" },
    });

    const header = res.headers.get("X-Request-ID");
    expect(header).toMatch(REQUEST_ID_PATTERN);

    const log = entries.find((entry) => entry.msg === "Request completed");
    expect(log?.requestId).toBe(header);
    expect(log?.meta).toMatchObject({ route: "/healthz" });
  });

  it("labels unmatched routes and still correlates the log line", async () => {
    const entries = captureLogEntries();
    const res = await makeApp().request("/nope");

    expect(res.status).toBe(404);
    const log = entries.find((entry) => entry.msg === "Request completed");
    expect(log?.requestId).toBe(res.headers.get("X-Request-ID"));
    expect(log?.meta).toMatchObject({ route: "unmatched", status: 404 });
  });
});

describe("isMetricsAuthorized", () => {
  it("requires a bearer token of meaningful length", () => {
    expect(isMetricsAuthorized(undefined, "a".repeat(24))).toBe(false);
    expect(isMetricsAuthorized("Bearer short", "short")).toBe(false);
    expect(isMetricsAuthorized(`Bearer ${"a".repeat(24)}`, "a".repeat(24))).toBe(true);
    expect(isMetricsAuthorized(`Bearer ${"a".repeat(24)}`, "b".repeat(24))).toBe(false);
  });
});
