import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import type { CaptureResult } from "@/services/capture.service";

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

const AUTH_HEADERS = {
  Authorization: "Bearer test-owner",
  "Content-Type": "application/json",
};

const WORD_ID = "00000000-0000-4000-8000-00000000000a";
const SOURCE_ID = "00000000-0000-4000-8000-00000000000b";
const CONTEXT_ID = "00000000-0000-4000-8000-00000000000c";
const OCCURRENCE_ID = "00000000-0000-4000-8000-00000000000d";
const WORDBOOK_ID = "00000000-0000-4000-8000-00000000000e";

/** A payload that satisfies captureResponseSchema exactly. */
function validCaptureResult(): CaptureResult {
  return {
    ok: true,
    existed: false,
    word: {
      id: WORD_ID,
      slug: "enduring",
      title: "enduring",
      lemma: "enduring",
      shortDefinition: "持久的",
    },
    noteContentMd: null,
    l3Status: "captured",
    sourceId: SOURCE_ID,
    contextId: CONTEXT_ID,
    occurrenceId: OCCURRENCE_ID,
  };
}

function makeServices(captureResult: unknown = validCaptureResult()): {
  services: Services;
  capture: { capture: ReturnType<typeof vi.fn> };
  wordbooks: { getOrCreateDefault: ReturnType<typeof vi.fn> };
} {
  const capture = { capture: vi.fn(async () => captureResult) };
  const wordbooks = { getOrCreateDefault: vi.fn(async () => ({ id: WORDBOOK_ID })) };
  return {
    services: { capture, wordbooks } as unknown as Services,
    capture,
    wordbooks,
  };
}

describe("POST /api/capture response contract", () => {
  it("returns 201 and echoes the captured trio for a sentence capture", async () => {
    const { services, capture } = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/capture", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ headword: "enduring", sentence: "An enduring lesson." }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual(validCaptureResult());
    expect(capture.capture).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123",
      headword: "enduring",
      sentence: "An enduring lesson.",
    }));
  });

  it("accepts the deferred l3Status the runtime can still produce", async () => {
    const { services } = makeServices({
      ...validCaptureResult(),
      l3Status: "deferred",
      sourceId: null,
      contextId: null,
      occurrenceId: null,
    });
    const app = createApp(services);

    const res = await app.request("/api/capture", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ headword: "enduring" }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ l3Status: "deferred", sourceId: null });
  });

  it("fails loudly with 500 when the service returns a payload that violates the contract", async () => {
    // The point of validating at the edge: if the service ever returns an
    // l3Status outside the published enum, the route must not smuggle it to
    // clients. A ZodError is not an AppError, so it reduces to a generic 500 —
    // that is intentional, and it is what makes contract drift visible.
    const { services } = makeServices({ ...validCaptureResult(), l3Status: "bogus" });
    const app = createApp(services);

    const res = await app.request("/api/capture", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ headword: "enduring", sentence: "An enduring lesson." }),
    });

    expect(res.status).toBe(500);
  });

  it("rejects a malformed request before any service call", async () => {
    const { services, capture } = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/capture", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ headword: "" }),
    });

    expect(res.status).toBe(400);
    expect(capture.capture).not.toHaveBeenCalled();
  });
});
