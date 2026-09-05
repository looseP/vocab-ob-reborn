/**
 * L2 candidate-pool route tests — Phase G.
 *
 * Covers the propose entry (default provenance injection), list mapping,
 * accept (full / picked subset via itemIndexes) and reject (hard delete).
 * The service layer is mocked; the real content-shape validation runs in the
 * route (isValidL2Content) which is exactly the boundary under test.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import {
  l2CandidateProposeResponseSchema,
  l2CandidatesResponseSchema,
  l2CandidateAcceptResponseSchema,
  l2CandidateRejectResponseSchema,
  l2ContentRowsResponseSchema,
  l2ContentRowMutateResponseSchema,
} from "@/http/l2-response-contract";

// ── Auth env setup（同 tests/http/l2.test.ts）────────────────────────────
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

function makeMockServices(l2content: unknown): Services {
  const words = {
    getWordBySlug: vi.fn(async () => ({ word: { id: "word-1", lemma: "abandon" } })),
  };
  return {
    words,
    reviews: {} as never,
    notes: {} as never,
    wordbooks: {} as never,
    stats: {} as never,
    l2Transition: {} as never,
    l2content,
  } as unknown as Services;
}

const VALID_COLLOCATION_ITEM = {
  phrase: "abandon ship",
  gloss: "弃船",
  tone: "neutral",
  example: "The captain ordered to abandon ship.",
  exampleTranslation: "船长下令弃船。",
};

const VALID_CORPUS_ITEM = {
  text: "They had to abandon the project.",
  translation: "他们不得不放弃这个项目。",
};

describe("POST /api/l2/:slug/candidates (propose)", () => {
  it("wraps items into a v1 document, injects default provenance, and returns candidateId/itemCount", async () => {
    const l2content = {
      proposeCandidates: vi.fn(async () => ({ candidateId: "cand-1", itemCount: 1 })),
    };
    const app = createApp(makeMockServices(l2content));

    const res = await app.request("/api/l2/abandon/candidates", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", items: [VALID_CORPUS_ITEM], sourceRef: "chat://1" }),
    });

    expect(res.status).toBe(200);
    const body = l2CandidateProposeResponseSchema.parse(await res.json());
    expect(body).toEqual({ candidateId: "cand-1", itemCount: 1 });
    // Default provenance injected so external agents don't need to know the
    // v1 provenance contract; sourceRef passes through. field=example → corpus.
    expect(l2content.proposeCandidates).toHaveBeenCalledWith(
      "word-1",
      "corpus",
      { schemaVersion: "l2-content-v1", field: "example", items: [{ ...VALID_CORPUS_ITEM, provenance: { source: "external_chat" } }] },
      { source: "external_chat", sourceRef: "chat://1", actorId: "user-123" },
    );
  });

  it("keeps caller-supplied provenance intact", async () => {
    const l2content = {
      proposeCandidates: vi.fn(async () => ({ candidateId: "cand-1", itemCount: 1 })),
    };
    const app = createApp(makeMockServices(l2content));
    const item = { ...VALID_CORPUS_ITEM, provenance: { source: "llm" } };

    await app.request("/api/l2/abandon/candidates", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", items: [item] }),
    });

    const content = (l2content.proposeCandidates.mock.calls[0] as unknown[])[2] as { items: unknown[] };
    expect(content.items[0]).toEqual(item);
  });

  it("returns 400 with the first zod issue when a collocation lacks evidence.rawPhrase", async () => {
    const l2content = { proposeCandidates: vi.fn() };
    const app = createApp(makeMockServices(l2content));

    const res = await app.request("/api/l2/abandon/candidates", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "collocation", items: [VALID_COLLOCATION_ITEM] }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    // 400 附带首个 zod issue（词典锚定红线先于 rawPhrase 检查命中）
    expect(body.message).toContain("machine-generated collocation requires dictionaryName");
    expect(l2content.proposeCandidates).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid field", async () => {
    const app = createApp(makeMockServices({ proposeCandidates: vi.fn() }));

    const res = await app.request("/api/l2/abandon/candidates", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "bogus", items: [VALID_CORPUS_ITEM] }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, unknown>).code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for malformed items (route-level content validation)", async () => {
    const l2content = { proposeCandidates: vi.fn() };
    const app = createApp(makeMockServices(l2content));

    const res = await app.request("/api/l2/abandon/candidates", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", items: [{ text: 123 }] }),
    });

    expect(res.status).toBe(400);
    expect(l2content.proposeCandidates).not.toHaveBeenCalled();
  });

  it("returns 404 when the word does not exist", async () => {
    const { NotFoundError } = await import("@/errors");
    const services = makeMockServices({ proposeCandidates: vi.fn() });
    (services.words.getWordBySlug as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundError("Word", "nope"));
    const app = createApp(services);

    const res = await app.request("/api/l2/nope/candidates", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", items: [VALID_CORPUS_ITEM] }),
    });

    expect(res.status).toBe(404);
  });
});

describe("GET /api/l2/:slug/candidates", () => {
  it("maps service candidates to the wire contract", async () => {
    const l2content = {
      listCandidates: vi.fn(async () => [
        { id: "cand-1", field: "collocation", items: [VALID_COLLOCATION_ITEM], source: "external_chat", createdAt: "2026-09-05T00:00:00.000Z" },
      ]),
    };
    const app = createApp(makeMockServices(l2content));

    const res = await app.request("/api/l2/abandon/candidates", { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    const body = l2CandidatesResponseSchema.parse(await res.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: "cand-1", field: "collocation", itemCount: 1, source: "external_chat" });
    expect(l2content.listCandidates).toHaveBeenCalledWith("word-1", "user-123");
  });
});

describe("POST /api/l2/:slug/candidates/:candidateId/accept", () => {
  it("forwards the full accept and returns the item count", async () => {
    const l2content = { acceptCandidate: vi.fn(async () => ({ itemCount: 2, replacedCount: 0 })) };
    const app = createApp(makeMockServices(l2content));

    const res = await app.request("/api/l2/abandon/candidates/c0a80101-0000-4000-8000-000000000001/accept", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(l2CandidateAcceptResponseSchema.parse(await res.json())).toEqual({ ok: true, itemCount: 2, replacedCount: 0 });
    expect(l2content.acceptCandidate).toHaveBeenCalledWith("word-1", "c0a80101-0000-4000-8000-000000000001", undefined, "user-123", "append");
  });

  it("forwards itemIndexes for a picked-subset accept", async () => {
    const l2content = { acceptCandidate: vi.fn(async () => ({ itemCount: 1, replacedCount: 0 })) };
    const app = createApp(makeMockServices(l2content));

    await app.request("/api/l2/abandon/candidates/c0a80101-0000-4000-8000-000000000001/accept", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ itemIndexes: [1] }),
    });

    expect(l2content.acceptCandidate).toHaveBeenCalledWith("word-1", "c0a80101-0000-4000-8000-000000000001", [1], "user-123", "append");
  });

  it("forwards mode=replace when the body asks for it", async () => {
    const l2content = { acceptCandidate: vi.fn(async () => ({ itemCount: 1, replacedCount: 3 })) };
    const app = createApp(makeMockServices(l2content));

    const res = await app.request("/api/l2/abandon/candidates/c0a80101-0000-4000-8000-000000000001/accept", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ mode: "replace" }),
    });

    expect(res.status).toBe(200);
    expect(l2CandidateAcceptResponseSchema.parse(await res.json())).toEqual({ ok: true, itemCount: 1, replacedCount: 3 });
    expect(l2content.acceptCandidate).toHaveBeenCalledWith("word-1", "c0a80101-0000-4000-8000-000000000001", undefined, "user-123", "replace");
  });

  it("returns 400 for a malformed candidate id", async () => {
    const app = createApp(makeMockServices({ acceptCandidate: vi.fn() }));

    const res = await app.request("/api/l2/abandon/candidates/not-a-uuid/accept", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when itemIndexes are not non-negative integers", async () => {
    const app = createApp(makeMockServices({ acceptCandidate: vi.fn() }));

    const res = await app.request("/api/l2/abandon/candidates/c0a80101-0000-4000-8000-000000000001/accept", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ itemIndexes: [-1] }),
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/l2/:slug/candidates/:candidateId/reject", () => {
  it("hard-deletes via the service", async () => {
    const l2content = { rejectCandidate: vi.fn(async () => {}) };
    const app = createApp(makeMockServices(l2content));

    const res = await app.request("/api/l2/abandon/candidates/c0a80101-0000-4000-8000-000000000002/reject", {
      method: "POST",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(l2CandidateRejectResponseSchema.parse(await res.json())).toEqual({ ok: true });
    expect(l2content.rejectCandidate).toHaveBeenCalledWith("word-1", "c0a80101-0000-4000-8000-000000000002", "user-123");
  });
});

describe("L2 content row management (l2-rows)", () => {
  const ROW = {
    id: "row-1",
    field: "corpus",
    itemCount: 1,
    items: [{ text: "Abound in coal." }],
    source: "external_chat",
    sourceRef: "agent-demo-001",
    approvedBy: "user",
    approvedAt: "2026-09-05T09:40:00.000Z",
    createdAt: "2026-09-05T08:50:03.295Z",
  };

  it("lists active and retired rows", async () => {
    const l2content = {
      listContentRows: vi.fn(async () => ({ active: [ROW], retired: [{ ...ROW, id: "row-2" }] })),
    };
    const app = createApp(makeMockServices(l2content));

    const res = await app.request("/api/l2/abandon/l2-rows", { headers: AUTH_HEADERS });

    expect(res.status).toBe(200);
    const body = l2ContentRowsResponseSchema.parse(await res.json());
    expect(body.active).toHaveLength(1);
    expect(body.retired).toHaveLength(1);
    expect(l2content.listContentRows).toHaveBeenCalledWith("word-1", "user-123");
  });

  it("deactivates an active row", async () => {
    const l2content = { deactivateContentRow: vi.fn(async () => {}) };
    const app = createApp(makeMockServices(l2content));

    const res = await app.request("/api/l2/abandon/l2-rows/c0a80101-0000-4000-8000-00000000000a/deactivate", {
      method: "POST",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(l2ContentRowMutateResponseSchema.parse(await res.json())).toEqual({ ok: true });
    expect(l2content.deactivateContentRow).toHaveBeenCalledWith("word-1", "c0a80101-0000-4000-8000-00000000000a", "user-123");
  });

  it("hard-deletes a row", async () => {
    const l2content = { deleteContentRow: vi.fn(async () => {}) };
    const app = createApp(makeMockServices(l2content));

    const res = await app.request("/api/l2/abandon/l2-rows/c0a80101-0000-4000-8000-00000000000a", {
      method: "DELETE",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(l2content.deleteContentRow).toHaveBeenCalledWith("word-1", "c0a80101-0000-4000-8000-00000000000a", "user-123");
  });

  it("returns 400 for a malformed row id", async () => {
    const app = createApp(makeMockServices({ deactivateContentRow: vi.fn() }));

    const res = await app.request("/api/l2/abandon/l2-rows/nope/deactivate", {
      method: "POST",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(400);
  });

  it("maps service ValidationError (unknown row) to 422 via the global handler", async () => {
    const { ValidationError } = await import("@/errors");
    const l2content = {
      deactivateContentRow: vi.fn(async () => {
        throw new ValidationError("Content row not found for this word", "corpus");
      }),
    };
    const app = createApp(makeMockServices(l2content));

    const res = await app.request("/api/l2/abandon/l2-rows/c0a80101-0000-4000-8000-00000000000a/deactivate", {
      method: "POST",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(422);
  });
});
