import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { ValidationError } from "@/errors";
import { captureResponseSchema } from "@/http/capture-response-contract";

const ORIGINAL_OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const ORIGINAL_LOCAL_OWNER = process.env.LOCAL_OWNER_ID;

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "test-owner";
  process.env.LOCAL_OWNER_ID = "user-123";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL_OWNER_TOKEN;
  process.env.LOCAL_OWNER_ID = ORIGINAL_LOCAL_OWNER;
});

const DEFAULT_WORDBOOK_ID = "11111111-1111-4111-8111-111111111111";
const EXPLICIT_WORDBOOK_ID = "33333333-3333-4333-8333-333333333333";
const WORD_ID = "22222222-2222-4222-8222-222222222222";

function captureResult(overrides: { existed?: boolean; noteContentMd?: string | null } = {}) {
  return {
    ok: true as const,
    existed: overrides.existed ?? false,
    word: {
      id: WORD_ID,
      slug: "abound",
      title: "abound",
      lemma: "abound",
      shortDefinition: null,
    },
    noteContentMd: overrides.noteContentMd === undefined ? null : overrides.noteContentMd,
    l3Status: "deferred" as const,
    sourceId: null,
    contextId: null,
    occurrenceId: null,
  };
}

function makeMockServices(): Services {
  return {
    capture: { capture: vi.fn().mockResolvedValue(captureResult()) },
    wordbooks: {
      getOrCreateDefault: vi.fn().mockResolvedValue({ id: DEFAULT_WORDBOOK_ID }),
    },
  } as unknown as Services;
}

const AUTH_HEADERS = { Authorization: "Bearer test-owner" };

function postCapture(body: unknown, headers: Record<string, string> = AUTH_HEADERS) {
  return {
    headers: { ...headers, "Content-Type": "application/json" },
    method: "POST" as const,
    body: JSON.stringify(body),
  };
}

describe("POST /api/capture", () => {
  it("captures a new headword and returns 201 matching the response contract", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/capture", postCapture({ headword: "abound" }));
    expect(res.status).toBe(201);
    const body = captureResponseSchema.parse(await res.json());
    expect(body.ok).toBe(true);
    expect(body.existed).toBe(false);
    expect(body.word.slug).toBe("abound");
  });

  it("falls back to the default wordbook when wordbookId is omitted", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/capture", postCapture({ headword: "abound" }));
    expect(res.status).toBe(201);
    expect(services.wordbooks.getOrCreateDefault).toHaveBeenCalledWith("user-123");
    expect(services.capture.capture).toHaveBeenCalledWith({
      userId: "user-123",
      wordbookId: DEFAULT_WORDBOOK_ID,
      headword: "abound",
      sentence: undefined,
      sourceUrl: undefined,
      obsidianRef: undefined,
    });
  });

  it("uses the explicit wordbookId and skips the default lookup", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request(
      "/api/capture",
      postCapture({ headword: "abound", wordbookId: EXPLICIT_WORDBOOK_ID }),
    );
    expect(res.status).toBe(201);
    expect(services.wordbooks.getOrCreateDefault).not.toHaveBeenCalled();
    expect(services.capture.capture).toHaveBeenCalledWith(
      expect.objectContaining({ wordbookId: EXPLICIT_WORDBOOK_ID }),
    );
  });

  it("reports existed=true and the retained note for an already-captured word", async () => {
    const services = makeMockServices();
    (services.capture.capture as ReturnType<typeof vi.fn>).mockResolvedValue(
      captureResult({ existed: true, noteContentMd: "existing note" }),
    );
    const app = createApp(services);
    const res = await app.request("/api/capture", postCapture({ headword: "abound" }));
    expect(res.status).toBe(201);
    const body = captureResponseSchema.parse(await res.json());
    expect(body.existed).toBe(true);
    expect(body.noteContentMd).toBe("existing note");
  });

  it("is idempotent in shape: l3Status is always deferred", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/capture", postCapture({ headword: "abound" }));
    const body = captureResponseSchema.parse(await res.json());
    expect(body.l3Status).toBe("deferred");
    expect(body.sourceId).toBeNull();
    expect(body.contextId).toBeNull();
    expect(body.occurrenceId).toBeNull();
  });

  it("forwards optional source metadata to the service", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request(
      "/api/capture",
      postCapture({
        headword: "abound",
        sentence: "Rumours abound.",
        sourceUrl: "https://example.com/post",
        obsidianRef: "notes/abound.md",
      }),
    );
    expect(res.status).toBe(201);
    expect(services.capture.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        sentence: "Rumours abound.",
        sourceUrl: "https://example.com/post",
        obsidianRef: "notes/abound.md",
      }),
    );
  });

  it("rejects a missing headword with 400", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/capture", postCapture({}));
    expect(res.status).toBe(400);
    expect(services.capture.capture).not.toHaveBeenCalled();
  });

  it("maps a service-level ValidationError for non-latin headwords to 422", async () => {
    const services = makeMockServices();
    (services.capture.capture as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ValidationError("headword must contain latin word characters", "headword"),
    );
    const app = createApp(services);
    const res = await app.request("/api/capture", postCapture({ headword: "的的" }));
    expect(res.status).toBe(422);
  });

  it("rejects missing credentials with 401", async () => {
    const services = makeMockServices();
    const app = createApp(services);
    const res = await app.request("/api/capture", postCapture({ headword: "abound" }, {}));
    expect(res.status).toBe(401);
    expect(services.capture.capture).not.toHaveBeenCalled();
  });
});
