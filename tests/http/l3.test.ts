import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import { ConflictError, NotFoundError, ValidationError } from "@/errors";
import type { Services } from "@/services";

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

const SOURCE_ID = "00000000-0000-4000-8000-000000000001";
const CONTEXT_ID = "00000000-0000-4000-8000-000000000002";
const WORD_ID = "00000000-0000-4000-8000-000000000003";

function makeServices(
  contextOverrides: Partial<Record<keyof Services["l3Context"], unknown>> = {},
  proposalOverrides: Partial<Record<keyof Services["l3Proposal"], unknown>> = {},
  importOverrides: Partial<Record<keyof Services["l3Import"], unknown>> = {},
  readOverrides: Partial<Record<keyof Services["l3Read"], unknown>> = {},
  recommendationOverrides: Partial<Record<keyof Services["l3Recommendation"], unknown>> = {},
): Services {
  const l3Context = {
    createSource: vi.fn(async () => ({ source: { id: "src-1", user_id: "user-123" } })),
    createContext: vi.fn(async () => ({ context: { id: "ctx-1", source_id: "src-1", user_id: "user-123" } })),
    createOccurrence: vi.fn(async () => ({ occurrence: { id: "occ-1", context_id: "ctx-1", word_id: "w1" } })),
    createContextLink: vi.fn(async () => ({ link: { id: "link-1", context_id: "ctx-1" } })),
    createImportJob: vi.fn(),
    listContextsForWord: vi.fn(async () => ({
      items: [
        {
          context: { id: "ctx-1", text: "A vivid context." },
          source: { id: "src-1", title: "Essay" },
          occurrence: { id: "occ-1", surface: "vivid" },
          links: [],
        },
      ],
      limit: 50,
      cursor: null,
      nextCursor: null,
    })),
    listContextsForSource: vi.fn(async () => ({ items: [], limit: 50, cursor: null, nextCursor: null })),
    ...contextOverrides,
  };
  const l3Proposal = {
    createProposal: vi.fn(async () => ({ proposal: { id: "prop-1", status: "pending" }, items: [] })),
    listProposals: vi.fn(async () => ({ items: [{ id: "prop-1", status: "pending" }], limit: 50, cursor: null, nextCursor: null })),
    getProposal: vi.fn(async () => ({ proposal: { id: "prop-1", status: "pending" }, items: [] })),
    validateProposal: vi.fn(async () => ({ proposal: { id: "prop-1", status: "pending" }, items: [], valid: true, errors: [] })),
    confirmProposal: vi.fn(async () => ({ proposal: { id: "prop-1", status: "confirmed" }, items: [], activeEntities: [] })),
    rejectProposal: vi.fn(async () => ({ proposal: { id: "prop-1", status: "rejected" }, items: [] })),
    ...proposalOverrides,
  };
  const l3Import = {
    createRawTextImportProposal: vi.fn(async () => ({
      importJob: { id: "job-1", status: "completed" },
      proposal: { id: "prop-1", status: "pending" },
      items: [],
      parseStats: { contextCount: 1, occurrenceCount: 1, linkCount: 0, skippedContextCount: 0, warnings: [] },
    })),
    createStructuredImportProposal: vi.fn(async () => ({
      importJob: { id: "job-1", status: "completed" },
      proposal: { id: "prop-1", status: "pending" },
      items: [],
      parseStats: { contextCount: 1, occurrenceCount: 1, linkCount: 1, skippedContextCount: 0, warnings: [] },
    })),
    ...importOverrides,
  };
  const l3Read = {
    getContextDetail: vi.fn(async () => ({
      context: { id: CONTEXT_ID, text: "A vivid context." },
      source: { id: SOURCE_ID, title: "Essay" },
      occurrences: [{ id: "occ-1", surface: "vivid" }],
      links: [],
    })),
    getWordSpace: vi.fn(async () => ({
      word: { id: WORD_ID, slug: "vivid" },
      contexts: [{ id: CONTEXT_ID, text: "A vivid context." }],
      sources: [{ id: SOURCE_ID, title: "Essay" }],
      occurrences: [{ id: "occ-1", surface: "vivid" }],
      links: [],
      stats: { sourceCount: 1, contextCount: 1, occurrenceCount: 1, linkCount: 0 },
      limit: 50,
      cursor: null,
      nextCursor: null,
    })),
    getSourceSpace: vi.fn(async () => ({
      source: { id: SOURCE_ID, title: "Essay" },
      contexts: [{ id: CONTEXT_ID, text: "A vivid context." }],
      occurrences: [{ id: "occ-1", surface: "vivid" }],
      links: [],
      stats: { sourceCount: 1, contextCount: 1, occurrenceCount: 1, linkCount: 0 },
      limit: 50,
      cursor: null,
      nextCursor: null,
    })),
    getGraph: vi.fn(async () => ({
      nodes: [{ id: "context:ctx-1", type: "context", label: "A vivid context.", ref: { contextId: "ctx-1" } }],
      edges: [],
      stats: { sourceCount: 1, contextCount: 1, occurrenceCount: 0, linkCount: 0, nodeCount: 1, edgeCount: 0 },
      limit: 100,
      cursor: null,
      nextCursor: null,
    })),
    ...readOverrides,
  };
  const l3Recommendation = {
    generateRecommendations: vi.fn(async () => ({
      run: { id: "run-1", status: "completed", mode: "review_pack" },
      items: [{ id: "rec-1", status: "pending", recommendation_type: "review_pack" }],
      stats: { itemCount: 1 },
    })),
    listRecommendations: vi.fn(async () => ({
      items: [{ id: "rec-1", status: "pending", recommendation_type: "review_pack" }],
      limit: 50,
      cursor: null,
      nextCursor: null,
    })),
    getRecommendation: vi.fn(async () => ({ id: "rec-1", status: "pending", recommendation_type: "review_pack" })),
    acceptRecommendation: vi.fn(async () => ({ item: { id: "rec-1", status: "accepted" }, actionPayload: { action: "future_consumer" } })),
    rejectRecommendation: vi.fn(async () => ({ id: "rec-1", status: "rejected" })),
    ...recommendationOverrides,
  };
  return {
    words: {} as never,
    reviews: {} as never,
    notes: {} as never,
    wordbooks: {} as never,
    stats: {} as never,
    l2Transition: {} as never,
    crossTrack: {} as never,
    l2content: {} as never,
    l3Context,
    l3Proposal,
    l3Read,
    l3Import,
    l3Recommendation,
  } as unknown as Services;
}

describe("L3 HTTP routes", () => {
  it("GET /api/l3/contexts/:id succeeds", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request(`/api/l3/contexts/${CONTEXT_ID}`, {
      method: "GET",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { context: { id: string }; occurrences: unknown[] };
    expect(body.context.id).toBe(CONTEXT_ID);
    expect(body.occurrences).toHaveLength(1);
    expect(services.l3Read.getContextDetail).toHaveBeenCalledWith({
      userId: "user-123",
      contextId: CONTEXT_ID,
    });
  });

  it("GET /api/l3/words/:slug/space succeeds", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request(`/api/l3/words/vivid/space?wordbookId=${SOURCE_ID}&limit=25`, {
      method: "GET",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(services.l3Read.getWordSpace).toHaveBeenCalledWith({
      userId: "user-123",
      slug: "vivid",
      wordbookId: SOURCE_ID,
      limit: 25,
      cursor: null,
    });
  });

  it("GET /api/l3/sources/:id/space succeeds", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request(`/api/l3/sources/${SOURCE_ID}/space?limit=25`, {
      method: "GET",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(services.l3Read.getSourceSpace).toHaveBeenCalledWith({
      userId: "user-123",
      sourceId: SOURCE_ID,
      limit: 25,
      cursor: null,
    });
  });

  it("GET /api/l3/graph succeeds", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request(`/api/l3/graph?sourceId=${SOURCE_ID}&slug=vivid&depth=2&limit=200`, {
      method: "GET",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(services.l3Read.getGraph).toHaveBeenCalledWith({
      userId: "user-123",
      wordbookId: null,
      slug: "vivid",
      sourceId: SOURCE_ID,
      depth: 2,
      limit: 200,
      cursor: null,
    });
  });

  it("maps read route validation to 400 and service errors to 404/422", async () => {
    const services = makeServices({}, {}, {}, {
      getContextDetail: vi.fn(async () => {
        throw new NotFoundError("L3Context", "missing");
      }),
      getGraph: vi.fn(async () => {
        throw new ValidationError("Invalid pagination cursor", "cursor");
      }),
    });
    const app = createApp(services);

    const routeError = await app.request("/api/l3/graph?limit=301", { method: "GET", headers: AUTH_HEADERS });
    expect(routeError.status).toBe(400);

    const missing = await app.request(`/api/l3/contexts/${CONTEXT_ID}`, { method: "GET", headers: AUTH_HEADERS });
    expect(missing.status).toBe(404);

    const badCursor = await app.request("/api/l3/graph?cursor=bad", { method: "GET", headers: AUTH_HEADERS });
    expect(badCursor.status).toBe(422);
  });

  it.each(["0", "-1", "3", "abc"])("maps invalid graph depth %s to 400", async (depth) => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request(`/api/l3/graph?depth=${depth}`, {
      method: "GET",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(400);
    expect(services.l3Read.getGraph).not.toHaveBeenCalled();
  });

  it("POST /api/l3/sources succeeds", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/sources", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sourceType: "article", title: "Essay", metadata: { origin: "manual" } }),
    });

    expect(res.status).toBe(201);
    expect(services.l3Context.createSource).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123",
      sourceType: "article",
      title: "Essay",
    }));
  });

  it("POST /api/l3/contexts succeeds", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/contexts", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sourceId: SOURCE_ID, contextType: "sentence", text: "A vivid context." }),
    });

    expect(res.status).toBe(201);
    expect(services.l3Context.createContext).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123",
      sourceId: SOURCE_ID,
    }));
  });

  it("POST /api/l3/occurrences succeeds", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/occurrences", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        contextId: CONTEXT_ID,
        wordId: WORD_ID,
        surface: "vivid",
        startOffset: 2,
        endOffset: 7,
      }),
    });

    expect(res.status).toBe(201);
    expect(services.l3Context.createOccurrence).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123",
      surface: "vivid",
    }));
  });

  it("GET /api/l3/words/:slug/contexts succeeds", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/words/vivid/contexts", {
      method: "GET",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.items).toHaveLength(1);
    expect(services.l3Context.listContextsForWord).toHaveBeenCalledWith({
      userId: "user-123",
      slug: "vivid",
      limit: 50,
      cursor: null,
    });
  });

  it("maps service NotFoundError to 404", async () => {
    const services = makeServices({
      createContext: vi.fn(async () => {
        throw new NotFoundError("L3Source", "missing");
      }),
    });
    const app = createApp(services);

    const res = await app.request("/api/l3/contexts", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ sourceId: SOURCE_ID, contextType: "sentence", text: "A vivid context." }),
    });

    expect(res.status).toBe(404);
  });

  it("maps service ValidationError to 422", async () => {
    const services = makeServices({
      createOccurrence: vi.fn(async () => {
        throw new ValidationError("Occurrence offsets exceed context text length", "offset");
      }),
    });
    const app = createApp(services);

    const res = await app.request("/api/l3/occurrences", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        contextId: CONTEXT_ID,
        wordId: WORD_ID,
        surface: "vivid",
        startOffset: 2,
        endOffset: 99,
      }),
    });

    expect(res.status).toBe(422);
  });

  it("GET /api/l3/sources/:id/contexts returns context-level items with occurrences", async () => {
    const services = makeServices({
      listContextsForSource: vi.fn(async () => ({
        items: [
          {
            context: { id: "ctx-1", text: "A vivid context." },
            source: { id: "src-1", title: "Essay" },
            occurrences: [
              { id: "occ-1", surface: "vivid" },
              { id: "occ-2", surface: "context" },
            ],
            links: [],
          },
        ],
        limit: 50,
        cursor: null,
        nextCursor: null,
      })),
    });
    const app = createApp(services);

    const res = await app.request(`/api/l3/sources/${SOURCE_ID}/contexts`, {
      method: "GET",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ occurrences: unknown[] }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].occurrences).toHaveLength(2);
    expect(services.l3Context.listContextsForSource).toHaveBeenCalledWith({
      userId: "user-123",
      sourceId: SOURCE_ID,
      limit: 50,
      cursor: null,
    });
  });

  it("maps bad cursor ValidationError to 422", async () => {
    const services = makeServices({
      listContextsForSource: vi.fn(async () => {
        throw new ValidationError("Invalid pagination cursor", "cursor");
      }),
    });
    const app = createApp(services);

    const res = await app.request(`/api/l3/sources/${SOURCE_ID}/contexts?cursor=bad`, {
      method: "GET",
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(422);
  });

  it("POST /api/l3/imports/raw-text returns 201", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/imports/raw-text", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        source: { sourceType: "article", title: "Essay", language: "en" },
        text: "She gave a vivid account.",
        targetWords: [{ slug: "vivid" }],
        options: { contextType: "sentence" },
        provenance: { source: "manual_import" },
      }),
    });

    expect(res.status).toBe(201);
    expect(services.l3Import.createRawTextImportProposal).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123",
      source: expect.objectContaining({ sourceType: "article", title: "Essay" }),
      targetWords: [{ slug: "vivid" }],
    }));
  });

  it("POST /api/l3/imports/structured returns 201", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/imports/structured", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        source: { sourceType: "manual", title: "Examples" },
        contexts: [{
          clientRef: "ctx-1",
          contextType: "sentence",
          text: "She gave a vivid account.",
          occurrences: [{ slug: "vivid", surface: "vivid", startOffset: 11, endOffset: 16 }],
          links: [{ linkType: "illustrates", targetType: "external", targetRef: { url: "https://example.com" } }],
        }],
      }),
    });

    expect(res.status).toBe(201);
    expect(services.l3Import.createStructuredImportProposal).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123",
      contexts: [expect.objectContaining({ clientRef: "ctx-1", contextType: "sentence" })],
    }));
  });

  it("maps import route body errors to 400 and business errors to 422", async () => {
    const services = makeServices({}, {}, {
      createRawTextImportProposal: vi.fn(async () => {
        throw new ValidationError("text cannot be empty", "text");
      }),
    });
    const app = createApp(services);

    const bodyError = await app.request("/api/l3/imports/raw-text", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ source: { sourceType: "manual", title: "Note" }, text: "" }),
    });
    expect(bodyError.status).toBe(400);

    const businessError = await app.request("/api/l3/imports/raw-text", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ source: { sourceType: "manual", title: "Note" }, text: "A vivid account." }),
    });
    expect(businessError.status).toBe(422);
  });

  it("maps import missing wordbook to 404", async () => {
    const services = makeServices({}, {}, {
      createStructuredImportProposal: vi.fn(async () => {
        throw new NotFoundError("Wordbook", "missing");
      }),
    });
    const app = createApp(services);

    const res = await app.request("/api/l3/imports/structured", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        wordbookId: "00000000-0000-4000-8000-000000000099",
        source: { sourceType: "manual", title: "Examples" },
        contexts: [{ contextType: "sentence", text: "A vivid account." }],
      }),
    });

    expect(res.status).toBe(404);
  });

  it("POST /api/l3/proposals returns 201", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/proposals", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        sourceType: "agent",
        title: "Candidate contexts",
        items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
      }),
    });

    expect(res.status).toBe(201);
    expect(services.l3Proposal.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-123",
      sourceType: "agent",
    }));
  });

  it("POST /api/l3/recommendations/generate returns 201", async () => {
    const services = makeServices();
    const app = createApp(services);

    const res = await app.request("/api/l3/recommendations/generate", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        mode: "review_pack",
        wordbookId: SOURCE_ID,
        seedSlug: "vivid",
        limit: 10,
        horizonDays: 14,
        dryRun: true,
      }),
    });

    expect(res.status).toBe(201);
    expect(services.l3Recommendation.generateRecommendations).toHaveBeenCalledWith({
      userId: "user-123",
      wordbookId: SOURCE_ID,
      mode: "review_pack",
      seedSlug: "vivid",
      limit: 10,
      horizonDays: 14,
      dryRun: true,
    });
  });

  it("GET/accept/reject recommendation routes work", async () => {
    const services = makeServices();
    const app = createApp(services);

    const list = await app.request("/api/l3/recommendations?status=pending&recommendationType=review_pack", {
      method: "GET",
      headers: AUTH_HEADERS,
    });
    expect(list.status).toBe(200);
    expect(services.l3Recommendation.listRecommendations).toHaveBeenCalledWith({
      userId: "user-123",
      status: "pending",
      recommendationType: "review_pack",
      limit: 50,
      cursor: null,
    });

    const get = await app.request("/api/l3/recommendations/rec-1", { method: "GET", headers: AUTH_HEADERS });
    expect(get.status).toBe(200);
    expect(services.l3Recommendation.getRecommendation).toHaveBeenCalledWith({ userId: "user-123", recommendationId: "rec-1" });

    const accept = await app.request("/api/l3/recommendations/rec-1/accept", { method: "POST", headers: AUTH_HEADERS });
    expect(accept.status).toBe(200);
    expect(services.l3Recommendation.acceptRecommendation).toHaveBeenCalledWith({ userId: "user-123", recommendationId: "rec-1" });

    const reject = await app.request("/api/l3/recommendations/rec-1/reject", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ reviewNote: "not relevant" }),
    });
    expect(reject.status).toBe(200);
    expect(services.l3Recommendation.rejectRecommendation).toHaveBeenCalledWith({
      userId: "user-123",
      recommendationId: "rec-1",
      reviewNote: "not relevant",
    });
  });

  it("maps recommendation schema, not found, conflict, and validation errors", async () => {
    const services = makeServices({}, {}, {}, {}, {
      getRecommendation: vi.fn(async () => {
        throw new NotFoundError("L3Recommendation", "missing");
      }),
      acceptRecommendation: vi.fn(async () => {
        throw new ConflictError("Cannot accept accepted recommendation");
      }),
      generateRecommendations: vi.fn(async () => {
        throw new ValidationError("horizonDays must be between 1 and 90", "horizonDays");
      }),
    });
    const app = createApp(services);

    const schemaError = await app.request("/api/l3/recommendations/generate", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ mode: "review_pack", limit: 101 }),
    });
    expect(schemaError.status).toBe(400);

    const missing = await app.request("/api/l3/recommendations/missing", { method: "GET", headers: AUTH_HEADERS });
    expect(missing.status).toBe(404);

    const conflict = await app.request("/api/l3/recommendations/rec-1/accept", { method: "POST", headers: AUTH_HEADERS });
    expect(conflict.status).toBe(409);

    const validation = await app.request("/api/l3/recommendations/generate", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ mode: "review_pack", horizonDays: 30 }),
    });
    expect(validation.status).toBe(422);
  });

  it("GET /api/l3/proposals and GET /api/l3/proposals/:id work", async () => {
    const services = makeServices();
    const app = createApp(services);

    const list = await app.request("/api/l3/proposals?status=pending", { method: "GET", headers: AUTH_HEADERS });
    expect(list.status).toBe(200);
    expect(services.l3Proposal.listProposals).toHaveBeenCalledWith({
      userId: "user-123",
      status: "pending",
      limit: 50,
      cursor: null,
    });

    const get = await app.request("/api/l3/proposals/prop-1", { method: "GET", headers: AUTH_HEADERS });
    expect(get.status).toBe(200);
    expect(services.l3Proposal.getProposal).toHaveBeenCalledWith({ userId: "user-123", proposalId: "prop-1" });
  });

  it("POST validate/confirm/reject proposal routes work", async () => {
    const services = makeServices();
    const app = createApp(services);

    const validate = await app.request("/api/l3/proposals/prop-1/validate", { method: "POST", headers: AUTH_HEADERS });
    expect(validate.status).toBe(200);
    expect(services.l3Proposal.validateProposal).toHaveBeenCalledWith({ userId: "user-123", proposalId: "prop-1" });

    const confirm = await app.request("/api/l3/proposals/prop-1/confirm", { method: "POST", headers: AUTH_HEADERS });
    expect(confirm.status).toBe(200);
    expect(services.l3Proposal.confirmProposal).toHaveBeenCalledWith({ userId: "user-123", proposalId: "prop-1" });

    const reject = await app.request("/api/l3/proposals/prop-1/reject", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ reviewNote: "duplicate" }),
    });
    expect(reject.status).toBe(200);
    expect(services.l3Proposal.rejectProposal).toHaveBeenCalledWith({
      userId: "user-123",
      proposalId: "prop-1",
      reviewNote: "duplicate",
    });
  });

  it("maps proposal conflict and validation errors", async () => {
    const services = makeServices({}, {
      confirmProposal: vi.fn(async () => {
        throw new ConflictError("Cannot confirm rejected proposal");
      }),
      validateProposal: vi.fn(async () => {
        throw new ValidationError("Proposal validation failed", "proposal");
      }),
    });
    const app = createApp(services);

    const conflict = await app.request("/api/l3/proposals/prop-1/confirm", { method: "POST", headers: AUTH_HEADERS });
    expect(conflict.status).toBe(409);

    const validation = await app.request("/api/l3/proposals/prop-1/validate", { method: "POST", headers: AUTH_HEADERS });
    expect(validation.status).toBe(422);
  });

  it("maps proposal bad cursor to 422", async () => {
    const services = makeServices({}, {
      listProposals: vi.fn(async () => {
        throw new ValidationError("Invalid pagination cursor", "cursor");
      }),
    });
    const app = createApp(services);

    const res = await app.request("/api/l3/proposals?cursor=bad", { method: "GET", headers: AUTH_HEADERS });

    expect(res.status).toBe(422);
  });

  it("maps missing proposal to 404", async () => {
    const services = makeServices({}, {
      getProposal: vi.fn(async () => {
        throw new NotFoundError("L3Proposal", "missing");
      }),
    });
    const app = createApp(services);

    const res = await app.request("/api/l3/proposals/missing", { method: "GET", headers: AUTH_HEADERS });

    expect(res.status).toBe(404);
  });
});
