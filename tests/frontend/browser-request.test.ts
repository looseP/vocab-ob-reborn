import { describe, expect, it, vi } from "vitest";
import { createBrowserSession, deleteBrowserSession, getBrowserSession } from "@/frontend/api/browserAuth";
import { BrowserApiError, createBrowserRequest, createBrowserResponseRequest } from "@/frontend/api/browserRequest";
import { createBrowserL3Client } from "@/frontend/api/l3Client";
import { adaptCursorPage, adaptOffsetPage } from "@/frontend/api/pagination";

function response(body: unknown, status = 200): Response {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text } as Response;
}

describe("browser API request", () => {
  it("uses same-origin JSON credentials and session mutation headers", async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true })) as unknown as typeof fetch;
    const request = createBrowserRequest({ fetch: fetchImpl, cookie: () => "other=x; vocab_csrf=csrf%20token" });
    await request("/api/words", { method: "POST", body: "{}" });

    const init = vi.mocked(fetchImpl).mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(init.credentials).toBe("same-origin");
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-CSRF-Token")).toBe("csrf token");
    expect(headers.get("X-Requested-With")).toBe("VocabObservatory");
  });

  it("does not attach CSRF to GET", async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true })) as unknown as typeof fetch;
    await createBrowserRequest({ fetch: fetchImpl, cookie: () => "vocab_csrf=secret" })("/api/words");
    expect(new Headers(vi.mocked(fetchImpl).mock.calls[0]![1]!.headers).has("X-CSRF-Token")).toBe(false);
  });

  it("ignores a malformed encoded CSRF cookie instead of crashing the request", async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true })) as unknown as typeof fetch;
    await createBrowserRequest({ fetch: fetchImpl, cookie: () => "vocab_csrf=%E0%A4%A" })("/api/words", {
      method: "POST",
      body: "{}",
    });
    expect(new Headers(vi.mocked(fetchImpl).mock.calls[0]![1]!.headers).has("X-CSRF-Token")).toBe(false);
  });

  it("supports Bearer auth without persisting it or attaching session CSRF", async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true })) as unknown as typeof fetch;
    const request = createBrowserRequest({ fetch: fetchImpl, cookie: () => "vocab_csrf=secret" });
    await request("/api/words", { method: "POST", bearerToken: "agent-token" });
    await request("/api/words");

    const firstHeaders = new Headers(vi.mocked(fetchImpl).mock.calls[0]![1]!.headers);
    const secondHeaders = new Headers(vi.mocked(fetchImpl).mock.calls[1]![1]!.headers);
    expect(firstHeaders.get("Authorization")).toBe("Bearer agent-token");
    expect(firstHeaders.has("X-CSRF-Token")).toBe(false);
    expect(secondHeaders.has("Authorization")).toBe(false);
  });

  it("returns undefined for 204 and empty responses", async () => {
    const noContent = createBrowserRequest({ fetch: vi.fn(async () => response(undefined, 204)) as unknown as typeof fetch });
    const empty = createBrowserRequest({ fetch: vi.fn(async () => response(undefined)) as unknown as typeof fetch });
    await expect(noContent<void>("/api/empty")).resolves.toBeUndefined();
    await expect(empty<void>("/api/empty")).resolves.toBeUndefined();
  });

  it("throws structured and non-JSON API errors", async () => {
    const structured = createBrowserRequest({ fetch: vi.fn(async () => response({ code: "VALIDATION_ERROR", message: "Invalid", details: { field: "word" }, requestId: "req-1" }, 400)) as unknown as typeof fetch });
    const plain = createBrowserRequest({ fetch: vi.fn(async () => response("Gateway failure", 502)) as unknown as typeof fetch });

    await expect(structured("/api/words")).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR", message: "Invalid", details: { field: "word" }, requestId: "req-1" });
    await expect(plain("/api/words")).rejects.toMatchObject({ status: 502, message: "Gateway failure", body: "Gateway failure" });
  });

  it("supports all three browser auth operations", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ authenticated: true, actorId: "owner", role: "owner" }))
      .mockResolvedValueOnce(response({ authenticated: true, actorId: "owner", role: "owner" }))
      .mockResolvedValueOnce(response(undefined, 204)) as unknown as typeof fetch;

    await expect(getBrowserSession(fetchImpl)).resolves.toMatchObject({ authenticated: true });
    await expect(createBrowserSession("owner-token", fetchImpl)).resolves.toMatchObject({ actorId: "owner" });
    await expect(deleteBrowserSession(fetchImpl)).resolves.toBeUndefined();
    expect(vi.mocked(fetchImpl).mock.calls.map((call) => call[1]?.method)).toEqual(["GET", "POST", "DELETE"]);
  });

  it("maps only an unauthorized auth lookup to null and preserves other failures", async () => {
    const unauthorized = vi.fn(async () => response({ error: "Unauthorized" }, 401)) as unknown as typeof fetch;
    const unavailable = vi.fn(async () => response("Unavailable", 503)) as unknown as typeof fetch;
    await expect(getBrowserSession(unauthorized)).resolves.toBeNull();
    await expect(getBrowserSession(unavailable)).rejects.toMatchObject({ status: 503 });
    await expect(createBrowserSession("bad", unauthorized)).rejects.toBeInstanceOf(BrowserApiError);
    await expect(deleteBrowserSession(unauthorized)).resolves.toBeUndefined();
  });

  it("returns the real successful status with its parsed payload", async () => {
    const payload = { created: true };
    const fetchImpl = vi.fn(async () => response(payload, 201)) as unknown as typeof fetch;
    const result = await createBrowserResponseRequest({ fetch: fetchImpl })("/api/items", { method: "POST", body: "{}" });
    expect(result).toEqual({ data: payload, status: 201 });
  });

  it("keeps the L3 wire path while reusing shared request policy", async () => {
    const fetchImpl = vi.fn(async () => response({ items: [], limit: 20, cursor: null, nextCursor: null })) as unknown as typeof fetch;
    const client = createBrowserL3Client("/backend", fetchImpl);
    await expect(client.listProposals({ status: "pending", limit: 20 })).resolves.toMatchObject({
      kind: "cursor",
      hasNextPage: false,
      cursor: null,
      nextCursor: null,
    });
    expect(fetchImpl).toHaveBeenCalledWith("/backend/api/l3/proposals?status=pending&limit=20", expect.objectContaining({ credentials: "same-origin", method: "GET" }));
  });
});

describe("pagination adapters", () => {
  it("preserves offset wire fields", () => {
    expect(adaptOffsetPage({ items: ["a", "b"], limit: 2, offset: 2, total: 5 })).toEqual({
      kind: "offset", items: ["a", "b"], limit: 2, offset: 2, total: 5, hasNextPage: true, nextOffset: 4,
    });
  });

  it("preserves cursor wire fields", () => {
    expect(adaptCursorPage({ items: ["a"], limit: 1, cursor: "before", nextCursor: "after" })).toEqual({
      kind: "cursor", items: ["a"], limit: 1, cursor: "before", nextCursor: "after", hasNextPage: true,
    });
  });
});
