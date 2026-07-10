import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  applyGraphReadSuccess,
  applyImportSuccess,
  applyManualDeleteSuccess,
  applyProposalConfirmSuccess,
  applyProposalRejectSuccess,
  applyProposalValidationResult,
  applyRecommendationAcceptSuccess,
  applyRecommendationGenerateSuccess,
  applyRecommendationRejectSuccess,
  createL3FrontendClient,
  graphStateAfterConfirm,
  graphStateFromRead,
  L3_UI_COPY,
  normalizeL3Error,
  normalizeL3TransportError,
  parseTargetWordInput,
  proposalActionsForStatus,
  recommendationActionForAcceptResult,
  validateGraphParams,
  validateManualContextCreateInput,
  validateManualContextLinkCreateInput,
  validateManualOccurrenceCreateInput,
  validateManualSourceCreateInput,
  validateRawTextImportInput,
  validateRecommendationGenerateInput,
  validateSourceSpaceParams,
  validateSpaceParams,
  validateStructuredImportInput,
  type L3ClientTransport,
  type L3ImportProposalResponse,
} from "@/l3/frontend/contract";
import { markGraphStaleAfterProposalConfirm } from "@/frontend/state/l3CacheSignals";
import type {
  L3GraphReadModel,
  L3ProposalBundle,
  L3ProposalConfirmResult,
  L3ProposalRow,
  L3ProposalValidationResult,
  L3RecommendationAcceptResult,
  L3RecommendationBundle,
  L3RecommendationItemRow,
  L3RecommendationRunRow,
} from "@/domain";

interface CapturedRequest {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

function makeTransport(response: { ok: boolean; status: number; body: unknown; jsonThrows?: boolean }): L3ClientTransport & {
  fetch: ReturnType<typeof vi.fn>;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  return {
    calls,
    fetch: vi.fn(async (url: string, init?: CapturedRequest["init"]) => {
      calls.push({ url, init });
      return {
        ok: response.ok,
        status: response.status,
        json: async () => {
          if (response.jsonThrows) throw new Error("invalid json");
          return response.body;
        },
      };
    }),
  };
}

function rejectingTransport(error: unknown): L3ClientTransport & { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async () => {
      throw error;
    }),
  };
}

function parsedBody(transport: { calls: CapturedRequest[] }, index = 0): Record<string, unknown> {
  const body = transport.calls[index]?.init?.body;
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

function expectNormalizedThrow(fn: () => unknown, expected: Record<string, unknown>): void {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject(expected);
    return;
  }
  throw new Error("Expected normalized L3 error");
}

const proposalRow = (status: L3ProposalRow["status"] = "pending"): L3ProposalRow => ({
  id: "prop-1",
  user_id: "u1",
  wordbook_id: null,
  source_type: "import",
  status,
  title: null,
  summary: null,
  input_hash: null,
  proposed_by: null,
  provenance: {},
  review_note: null,
  confirmed_at: status === "confirmed" ? "now" : null,
  rejected_at: status === "rejected" ? "now" : null,
  created_at: "now",
  updated_at: "now",
});

const recommendationRun = (id = "run-1"): L3RecommendationRunRow => ({
  id,
  user_id: "u1",
  wordbook_id: null,
  mode: "gap_scan",
  status: "completed",
  input_hash: null,
  stats: {},
  created_at: "now",
  completed_at: "now",
});

const recommendationItem = (
  status: L3RecommendationItemRow["status"] = "pending",
  type: L3RecommendationItemRow["recommendation_type"] = "link_gap",
): L3RecommendationItemRow => ({
  id: "rec-1",
  run_id: "run-1",
  user_id: "u1",
  wordbook_id: null,
  recommendation_type: type,
  status,
  title: "Recommendation",
  summary: "Summary",
  priority_score: "80.0000",
  confidence: "0.8000",
  reason_codes: [],
  evidence: [],
  payload: {},
  accepted_proposal_id: status === "accepted" ? "prop-1" : null,
  created_at: "now",
  updated_at: "now",
  expires_at: null,
  accepted_at: status === "accepted" ? "now" : null,
  rejected_at: status === "rejected" ? "now" : null,
  dismissed_at: null,
});

const graph = (nodes: L3GraphReadModel["nodes"] = []): L3GraphReadModel => ({
  nodes,
  edges: [],
  stats: {
    sourceCount: 0,
    contextCount: 0,
    occurrenceCount: 0,
    linkCount: 0,
    nodeCount: nodes.length,
    edgeCount: 0,
  },
  limit: 100,
  cursor: null,
  nextCursor: null,
});

describe("Phase 4A.1 L3 frontend contract scaffold", () => {
  it("keeps the contract module free of server-only runtime dependencies", () => {
    const source = readFileSync("src/l3/frontend/contract.ts", "utf8");

    expect(source).not.toMatch(/from ["']@\/(?:db|repositories|services|http)\//);
    expect(source).not.toMatch(/from ["'](?:node:)?(?:fs|path|crypto|process)["']/);
    expect(source).not.toMatch(/\bprocess\./);
  });

  it("maps every client endpoint to the frozen HTTP method, path, query, and camelCase body", async () => {
    const transport = makeTransport({ ok: true, status: 200, body: { items: [], limit: 20, cursor: null, nextCursor: null } });
    const client = createL3FrontendClient(transport);

    await client.createSource({ sourceType: "manual", title: "Manual source", language: "en", metadata: { provenance: { source: "manual" } } });
    await client.createContext({ sourceId: "src-1", contextType: "sentence", text: "A vivid sentence.", metadata: { provenance: { source: "manual" } } });
    await client.createOccurrence({ contextId: "ctx-1", slug: "vivid", surface: "vivid", startOffset: 2, endOffset: 7, evidence: { method: "manual", slug: "vivid" } });
    await client.createContextLink({ contextId: "ctx-1", linkType: "manual_link", targetType: "l2_item", targetRef: { field: "corpus", contentId: "l2-1" }, provenance: { source: "manual" } });
    await client.deleteOccurrence("occ 1");
    await client.deleteContextLink("link 1");
    await client.deleteSource("source id");
    await client.deleteContext("context id");
    await client.createRawTextImport({
      source: { sourceType: "manual", title: "Paste" },
      text: "A vivid account.",
      targetWords: parseTargetWordInput("vivid, VIVID\nlucid"),
      options: { contextType: "sentence" },
    });
    await client.createStructuredImport({
      source: { sourceType: "manual", title: "Structured" },
      contexts: [{
        clientRef: "ctx-1",
        contextType: "sentence",
        text: "A vivid sentence.",
        occurrences: [{ slug: "vivid", surface: "vivid", startOffset: 2, endOffset: 7 }],
        links: [{ wordId: "w1", linkType: "illustrates", targetType: "external", targetRef: { url: "https://example.test" } }],
      }],
    });
    await client.createProposal({ sourceType: "agent", items: [{ itemType: "source", payload: { sourceType: "manual", title: "Draft" } }] });
    await client.listProposals({ status: "pending", limit: 20, cursor: null });
    await client.getProposal("prop 1");
    await client.validateProposal("prop-1");
    await client.confirmProposal("prop-1");
    await client.rejectProposal("prop-1", "Nope");
    await client.generateRecommendations({ mode: "gap_scan", limit: 10, horizonDays: 7, dryRun: false });
    await client.listRecommendations({ status: "pending", recommendationType: "link_gap", limit: 20 });
    await client.getRecommendation("rec-1");
    await client.acceptRecommendation("rec-1");
    await client.rejectRecommendation("rec-1", null);
    await client.getContextDetail("ctx-1");
    await client.getWordSpace("vivid word", { wordbookId: "wb-1", limit: 50, cursor: undefined });
    await client.getSourceSpace("src-1", { limit: 50, cursor: null });
    await client.getGraph({ slug: "vivid", depth: 2, limit: 50, wordbookId: null });

    expect(transport.calls.map((call) => [call.init?.method, call.url])).toEqual([
      ["POST", "/api/l3/sources"],
      ["POST", "/api/l3/contexts"],
      ["POST", "/api/l3/occurrences"],
      ["POST", "/api/l3/context-links"],
      ["DELETE", "/api/l3/occurrences/occ%201"],
      ["DELETE", "/api/l3/context-links/link%201"],
      ["DELETE", "/api/l3/sources/source%20id"],
      ["DELETE", "/api/l3/contexts/context%20id"],
      ["POST", "/api/l3/imports/raw-text"],
      ["POST", "/api/l3/imports/structured"],
      ["POST", "/api/l3/proposals"],
      ["GET", "/api/l3/proposals?status=pending&limit=20"],
      ["GET", "/api/l3/proposals/prop%201"],
      ["POST", "/api/l3/proposals/prop-1/validate"],
      ["POST", "/api/l3/proposals/prop-1/confirm"],
      ["POST", "/api/l3/proposals/prop-1/reject"],
      ["POST", "/api/l3/recommendations/generate"],
      ["GET", "/api/l3/recommendations?status=pending&recommendationType=link_gap&limit=20"],
      ["GET", "/api/l3/recommendations/rec-1"],
      ["POST", "/api/l3/recommendations/rec-1/accept"],
      ["POST", "/api/l3/recommendations/rec-1/reject"],
      ["GET", "/api/l3/contexts/ctx-1"],
      ["GET", "/api/l3/words/vivid%20word/space?wordbookId=wb-1&limit=50"],
      ["GET", "/api/l3/sources/src-1/space?limit=50"],
      ["GET", "/api/l3/graph?slug=vivid&depth=2&limit=50"],
    ]);
    expect(transport.calls.map((call) => call.url).filter((url) => url.includes("/api/l3/manual/"))).toEqual([]);

    expect(parsedBody(transport, 0)).toEqual({
      sourceType: "manual",
      title: "Manual source",
      language: "en",
      metadata: { provenance: { source: "manual" } },
    });
    expect(parsedBody(transport, 1)).toMatchObject({
      sourceId: "src-1",
      contextType: "sentence",
      text: "A vivid sentence.",
    });
    expect(parsedBody(transport, 2)).toMatchObject({
      contextId: "ctx-1",
      slug: "vivid",
      surface: "vivid",
      startOffset: 2,
      endOffset: 7,
    });
    expect(parsedBody(transport, 3)).toMatchObject({
      contextId: "ctx-1",
      linkType: "manual_link",
      targetType: "l2_item",
      targetRef: { field: "corpus", contentId: "l2-1" },
    });
    expect(parsedBody(transport, 8)).toEqual({
      source: { sourceType: "manual", title: "Paste" },
      text: "A vivid account.",
      targetWords: [{ slug: "vivid" }, { slug: "lucid" }],
      options: { contextType: "sentence" },
    });
    expect(parsedBody(transport, 8)).not.toHaveProperty("source_type");
    expect(JSON.parse(transport.calls[9].init?.body ?? "{}")).toMatchObject({
      source: { sourceType: "manual" },
      contexts: [{
        clientRef: "ctx-1",
        contextType: "sentence",
        occurrences: [{ startOffset: 2, endOffset: 7 }],
        links: [{ targetType: "external", targetRef: { url: "https://example.test" } }],
      }],
    });
  });

  it("preserves manual delete response shapes", async () => {
    const occurrenceResponse = {
      deleted: { entityType: "occurrence" as const, id: "occ-1" },
      activeReadInvalidation: true as const,
    };
    const occurrenceTransport = makeTransport({ ok: true, status: 200, body: occurrenceResponse });

    await expect(createL3FrontendClient(occurrenceTransport).deleteOccurrence("occ-1")).resolves.toEqual(occurrenceResponse);

    const linkResponse = {
      deleted: { entityType: "context_link" as const, id: "link-1" },
      activeReadInvalidation: true as const,
    };
    const linkTransport = makeTransport({ ok: true, status: 200, body: linkResponse });

    await expect(createL3FrontendClient(linkTransport).deleteContextLink("link-1")).resolves.toEqual(linkResponse);

    const sourceResponse = {
      deleted: { entityType: "source" as const, id: "src-1" },
      activeReadInvalidation: true as const,
    };
    const sourceTransport = makeTransport({ ok: true, status: 200, body: sourceResponse });

    await expect(createL3FrontendClient(sourceTransport).deleteSource("src-1")).resolves.toEqual(sourceResponse);

    const contextResponse = {
      deleted: { entityType: "context" as const, id: "ctx-1" },
      activeReadInvalidation: true as const,
    };
    const contextTransport = makeTransport({ ok: true, status: 200, body: contextResponse });

    await expect(createL3FrontendClient(contextTransport).deleteContext("ctx-1")).resolves.toEqual(contextResponse);
  });

  it("treats raw and structured import success as proposal-only cache invalidation", () => {
    const response: L3ImportProposalResponse = {
      importJob: { id: "job-1", status: "completed" },
      proposal: { id: "prop-1", status: "pending" },
      items: [{ id: "item-1" }],
      parseStats: { contextCount: 1, occurrenceCount: 1, linkCount: 0, skippedContextCount: 0, warnings: [] },
    };

    const transition = applyImportSuccess(response);

    expect(transition.nextState).toBe("proposalCreated");
    expect(transition.message).toBe(L3_UI_COPY.importCreatedProposal);
    expect(transition.invalidate).toEqual(["l3.proposals.list", "l3.proposals.detail:prop-1"]);
    expect(transition.cache).toMatchObject({
      activeReadInvalidation: false,
      proposalInvalidation: true,
      recommendationInvalidation: false,
      reason: "import_created_pending_proposal",
    });
    expect(transition.refreshGraph).toBe(false);
    expect(transition.createsActiveL3).toBe(false);
  });

  it("normalizes route, schema, proposal, non-json, network, and abort errors", async () => {
    expect(normalizeL3Error(400, {
      error: { code: "VALIDATION_ERROR", message: "Bad request", details: { fieldErrors: { text: ["Required"] } } },
    })).toMatchObject({
      status: 400,
      kind: "bad_request",
      code: "VALIDATION_ERROR",
      message: "Bad request",
      fieldErrors: { text: ["Required"] },
      retryHint: "fix-input",
    });

    expect(normalizeL3Error(404, { message: "Missing" })).toMatchObject({
      status: 404,
      kind: "not_found",
      message: "Missing",
      retryHint: "refresh",
    });

    expect(normalizeL3Error(409, { code: "CONFLICT", error: "Cannot confirm confirmed proposal" })).toMatchObject({
      status: 409,
      kind: "conflict",
      message: "Cannot confirm confirmed proposal",
      retryHint: "refresh",
    });

    expect(normalizeL3Error(422, {
      code: "VALIDATION_ERROR",
      message: "Proposal validation failed",
      details: { errors: [{ itemId: "item-1", ordinal: 1, field: "surface", message: "surface mismatch" }] },
    })).toMatchObject({
      status: 422,
      kind: "validation",
      retryHint: "review-items",
      itemErrors: [{ itemId: "item-1", ordinal: 1, field: "surface", message: "surface mismatch" }],
    });

    const nonJsonTransport = makeTransport({ ok: false, status: 500, body: null, jsonThrows: true });
    await expect(createL3FrontendClient(nonJsonTransport).getProposal("prop-1")).rejects.toMatchObject({
      status: 500,
      kind: "unexpected",
      code: "INTERNAL",
    });

    await expect(createL3FrontendClient(rejectingTransport(new Error("offline"))).getGraph()).rejects.toMatchObject({
      status: 0,
      kind: "network",
      retryHint: "retry",
    });

    expect(normalizeL3TransportError({ name: "AbortError", message: "cancelled" })).toMatchObject({
      status: 0,
      kind: "aborted",
      retryHint: "none",
    });
  });

  it("normalizes manual delete HTTP errors through the shared request path", async () => {
    const missingTransport = makeTransport({ ok: false, status: 404, body: { code: "NOT_FOUND", message: "Missing" } });

    await expect(createL3FrontendClient(missingTransport).deleteOccurrence("occ-1")).rejects.toMatchObject({
      status: 404,
      kind: "not_found",
      code: "NOT_FOUND",
      retryHint: "refresh",
    });

    await expect(createL3FrontendClient(missingTransport).deleteSource("src-1")).rejects.toMatchObject({
      status: 404,
      kind: "not_found",
      code: "NOT_FOUND",
      retryHint: "refresh",
    });

    const validationTransport = makeTransport({
      ok: false,
      status: 400,
      body: { error: "VALIDATION_ERROR", details: { fieldErrors: { id: ["Invalid uuid"] } } },
    });

    await expect(createL3FrontendClient(validationTransport).deleteContextLink("bad-id")).rejects.toMatchObject({
      status: 400,
      kind: "bad_request",
      fieldErrors: { id: ["Invalid uuid"] },
      retryHint: "fix-input",
    });

    const blockers = { contextCount: 0, occurrenceCount: 1, contextLinkCount: 0, inboundContextLinkCount: 2 };
    const conflictTransport = makeTransport({
      ok: false,
      status: 409,
      body: {
        code: "CONFLICT",
        message: "Cannot delete L3 context with active dependencies",
        details: { entityType: "context", id: "ctx-1", blockers },
      },
    });

    await expect(createL3FrontendClient(conflictTransport).deleteContext("ctx-1")).rejects.toMatchObject({
      status: 409,
      kind: "conflict",
      code: "CONFLICT",
      retryHint: "refresh",
      details: { entityType: "context", id: "ctx-1", blockers },
    });
  });

  it("derives proposal states without treating valid=false as a fatal error", () => {
    const validation: L3ProposalValidationResult = {
      proposal: proposalRow("pending"),
      items: [],
      valid: false,
      errors: [{ itemId: "item-1", ordinal: 2, itemType: "occurrence", field: "surface", message: "surface mismatch" }],
    };

    const transition = applyProposalValidationResult(validation);

    expect(transition.nextState).toBe("invalid");
    expect(transition.cache).toMatchObject({
      activeReadInvalidation: false,
      proposalInvalidation: true,
      reason: "proposal_validation_feedback",
      nextSuggestedAction: "review_items",
    });
    expect(transition.refreshGraph).toBe(false);
    expect(proposalActionsForStatus("pending")).toEqual({
      state: "needsValidation",
      canValidate: true,
      canConfirm: true,
      canReject: true,
    });
    expect(proposalActionsForStatus("confirmed")).toEqual({
      state: "confirmed",
      canValidate: false,
      canConfirm: false,
      canReject: false,
    });
    expect(proposalActionsForStatus("rejected").canConfirm).toBe(false);
  });

  it("makes proposal confirm the only proposal-review active-read invalidating command", () => {
    const confirm: L3ProposalConfirmResult = {
      proposal: proposalRow("confirmed"),
      items: [],
      activeEntities: [
        { itemId: "item-1", itemType: "context", activeEntityType: "context", activeEntityId: "ctx-1" },
        { itemId: "item-2", itemType: "context_link", activeEntityType: "context_link", activeEntityId: "link-1" },
      ],
    };

    const transition = applyProposalConfirmSuccess(confirm);
    const rejectTransition = applyProposalRejectSuccess({ proposal: proposalRow("rejected"), items: [] });

    expect(transition.nextState).toBe("confirmed");
    expect(transition.createsActiveL3).toBe(true);
    expect(transition.refreshGraph).toBe(true);
    expect(transition.cache).toMatchObject({
      activeReadInvalidation: true,
      proposalInvalidation: true,
      reason: "proposal_confirmed_active_l3_created",
    });
    expect(transition.invalidate).toEqual(expect.arrayContaining(["l3.graph", "l3.context.detail", "l3.word.space", "l3.source.space"]));
    expect(graphStateAfterConfirm()).toBe("staleAfterConfirm");

    expect(rejectTransition.refreshGraph).toBe(false);
    expect(rejectTransition.cache.activeReadInvalidation).toBe(false);
  });

  it("treats manual delete as active-read invalidation only", () => {
    const response = {
      deleted: { entityType: "occurrence" as const, id: "occ-1" },
      activeReadInvalidation: true as const,
    };

    const transition = applyManualDeleteSuccess(response);

    expect(transition.data).toBe(response);
    expect(transition.nextState).toBe("deleted");
    expect(transition.createsActiveL3).toBe(false);
    expect(transition.refreshGraph).toBe(true);
    expect(transition.invalidate).toEqual(expect.arrayContaining([
      "l3.graph",
      "l3.context.detail",
      "l3.word.space",
      "l3.source.space",
    ]));
    expect(transition.cache).toMatchObject({
      keys: ["l3.graph", "l3.context.detail", "l3.word.space", "l3.source.space"],
      activeReadInvalidation: true,
      proposalInvalidation: false,
      recommendationInvalidation: false,
      reason: "manual_active_l3_deleted",
      nextSuggestedAction: "refresh_active_reads",
    });
  });

  it("maps proposal confirm into the Phase 4C graph stale state", () => {
    const confirm: L3ProposalConfirmResult = {
      proposal: proposalRow("confirmed"),
      items: [],
      activeEntities: [
        { itemId: "item-1", itemType: "source", activeEntityType: "source", activeEntityId: "src-1" },
      ],
    };

    expect(markGraphStaleAfterProposalConfirm(confirm)).toEqual({
      state: "staleAfterConfirm",
      reason: "proposal_confirmed_active_l3_created",
      activeEntities: confirm.activeEntities,
    });
  });

  it("separates recommendation generation, link_gap acceptance, future actions, and rejection cache signals", () => {
    const generated: L3RecommendationBundle = {
      run: recommendationRun(),
      items: [recommendationItem()],
      stats: { itemCount: 1 },
    };
    const dryRun: L3RecommendationBundle = {
      run: recommendationRun("dry-run"),
      items: [recommendationItem()],
      stats: { itemCount: 1, dryRun: true },
    };
    const acceptedLinkGap: L3RecommendationAcceptResult = {
      item: recommendationItem("accepted", "link_gap"),
      proposal: { proposal: proposalRow("pending"), items: [] },
    };
    const acceptedFuture: L3RecommendationAcceptResult = {
      item: recommendationItem("accepted", "review_pack"),
      actionPayload: { action: "future_consumer" },
    };

    expect(applyRecommendationGenerateSuccess(generated).cache).toMatchObject({
      keys: ["l3.recommendations.list"],
      recommendationInvalidation: true,
      activeReadInvalidation: false,
    });
    expect(applyRecommendationGenerateSuccess(dryRun).cache).toMatchObject({
      keys: [],
      recommendationInvalidation: false,
      reason: "recommendation_dry_run_no_cache_change",
    });

    const acceptTransition = applyRecommendationAcceptSuccess(acceptedLinkGap);
    expect(acceptTransition.nextState).toBe("proposalBridgeCreated");
    expect(acceptTransition.message).toBe(L3_UI_COPY.recommendationAcceptedProposal);
    expect(acceptTransition.cache).toMatchObject({
      activeReadInvalidation: false,
      proposalInvalidation: true,
      recommendationInvalidation: true,
    });
    expect(acceptTransition.invalidate).toEqual(expect.arrayContaining(["l3.proposals.list", "l3.proposals.detail:prop-1"]));
    expect(acceptTransition.refreshGraph).toBe(false);
    expect(recommendationActionForAcceptResult(acceptedLinkGap)).toBe("proposalBridgeCreated");

    expect(applyRecommendationAcceptSuccess(acceptedFuture).nextState).toBe("futureAction");
    expect(recommendationActionForAcceptResult(acceptedFuture)).toBe("futureAction");
    expect(applyRecommendationRejectSuccess(recommendationItem("rejected")).cache).toMatchObject({
      activeReadInvalidation: false,
      recommendationInvalidation: true,
    });
  });

  it("keeps graph read state and cache effects read-only", () => {
    const emptyGraph = graph();
    const loadedGraph = graph([{ id: "word:w1", type: "word", label: "vivid", ref: { wordId: "w1" } }]);

    expect(graphStateFromRead(emptyGraph)).toBe("empty");
    expect(graphStateFromRead(loadedGraph)).toBe("loaded");
    expect(applyGraphReadSuccess(loadedGraph)).toMatchObject({
      nextState: "loaded",
      invalidate: [],
      refreshGraph: false,
      createsActiveL3: false,
      cache: {
        keys: [],
        activeReadInvalidation: false,
        proposalInvalidation: false,
        recommendationInvalidation: false,
        reason: "graph_read_no_invalidation",
      },
    });
  });

  it("blocks invalid frontend inputs before transport fetch", async () => {
    expectNormalizedThrow(() => validateGraphParams({ depth: 3 }), {
      status: 400,
      fieldErrors: { depth: ["Depth must be 1 or 2."] },
    });
    expectNormalizedThrow(() => validateGraphParams({ limit: 301 }), {
      status: 400,
      fieldErrors: { limit: ["limit must be between 1 and 300."] },
    });
    expectNormalizedThrow(() => validateSpaceParams({ limit: 101 }), {
      fieldErrors: { limit: ["limit must be between 1 and 100."] },
    });
    expectNormalizedThrow(() => validateSourceSpaceParams({ limit: 101 }), {
      fieldErrors: { limit: ["limit must be between 1 and 100."] },
    });
    expectNormalizedThrow(() => validateRecommendationGenerateInput({ mode: "gap_scan", limit: 101 }), {
      fieldErrors: { limit: ["limit must be between 1 and 100."] },
    });
    expectNormalizedThrow(() => validateRecommendationGenerateInput({ mode: "gap_scan", horizonDays: 91 }), {
      fieldErrors: { horizonDays: ["horizonDays must be between 1 and 90."] },
    });
    expectNormalizedThrow(() => validateRawTextImportInput({ source: { sourceType: "manual", title: " " }, text: "x" }), {
      fieldErrors: { "source.title": ["source.title cannot be empty."] },
    });
    expectNormalizedThrow(() => validateRawTextImportInput({ source: { sourceType: "manual", title: "Paste" }, text: " " }), {
      fieldErrors: { text: ["text cannot be empty."] },
    });
    expectNormalizedThrow(() => validateRawTextImportInput({
      source: { sourceType: "manual", title: "Paste" },
      text: "x",
      targetWords: [{ slug: " " }],
    }), {
      fieldErrors: { targetWords: ["targetWords entries require wordId or non-empty slug."] },
    });
    expectNormalizedThrow(() => validateStructuredImportInput({
      source: { sourceType: "manual", title: "Structured" },
      contexts: [],
    }), {
      fieldErrors: { contexts: ["contexts cannot be empty."] },
    });
    expectNormalizedThrow(() => validateManualSourceCreateInput({ sourceType: "manual", title: " " }), {
      fieldErrors: { title: ["title cannot be empty."] },
    });
    expectNormalizedThrow(() => validateManualContextCreateInput({ sourceId: "", contextType: "sentence", text: "context" }), {
      fieldErrors: { sourceId: ["sourceId cannot be empty."] },
    });
    expectNormalizedThrow(() => validateManualOccurrenceCreateInput({ contextId: "ctx-1", surface: "vivid" }), {
      fieldErrors: { wordId: ["wordId or slug is required."] },
    });
    expectNormalizedThrow(() => validateManualOccurrenceCreateInput({ contextId: "ctx-1", slug: "vivid", surface: "vivid", startOffset: 1 }), {
      fieldErrors: { startOffset: ["startOffset and endOffset must be supplied together."] },
    });
    expectNormalizedThrow(() => validateManualContextLinkCreateInput({ linkType: "manual_link", targetType: "context", targetId: "ctx-target" }), {
      fieldErrors: { contextId: ["contextId or wordId is required."] },
    });
    expectNormalizedThrow(() => validateManualContextLinkCreateInput({ contextId: "ctx-1", linkType: "manual_link", targetType: "context", targetId: " " }), {
      fieldErrors: { targetId: ["targetId is required for context targets."] },
    });
    expectNormalizedThrow(() => validateManualContextLinkCreateInput({ contextId: "ctx-1", linkType: "manual_link", targetType: "l2_item", targetRef: { field: "corpus" } }), {
      fieldErrors: { targetRef: ["l2_item targetRef requires field plus contentId, hash, or sourceRef."] },
    });

    const transport = makeTransport({ ok: true, status: 200, body: graph() });
    expectNormalizedThrow(() => createL3FrontendClient(transport).getGraph({ limit: 0 }), { status: 400 });
    expect(transport.fetch).not.toHaveBeenCalled();

    const deleteTransport = makeTransport({ ok: true, status: 200, body: graph() });
    const deleteClient = createL3FrontendClient(deleteTransport);
    expectNormalizedThrow(() => deleteClient.deleteOccurrence(""), {
      status: 400,
      code: "FRONTEND_VALIDATION_ERROR",
      fieldErrors: { id: ["id cannot be empty."] },
    });
    expectNormalizedThrow(() => deleteClient.deleteContextLink("   "), {
      status: 400,
      code: "FRONTEND_VALIDATION_ERROR",
      fieldErrors: { id: ["id cannot be empty."] },
    });
    expectNormalizedThrow(() => deleteClient.deleteSource(""), {
      status: 400,
      code: "FRONTEND_VALIDATION_ERROR",
      fieldErrors: { id: ["id cannot be empty."] },
    });
    expectNormalizedThrow(() => deleteClient.deleteContext("   "), {
      status: 400,
      code: "FRONTEND_VALIDATION_ERROR",
      fieldErrors: { id: ["id cannot be empty."] },
    });
    expect(deleteTransport.fetch).not.toHaveBeenCalled();
  });
});
