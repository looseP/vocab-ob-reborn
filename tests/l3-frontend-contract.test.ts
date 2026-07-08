import { describe, expect, it, vi } from "vitest";
import {
  applyImportSuccess,
  applyProposalConfirmSuccess,
  applyProposalValidationResult,
  applyRecommendationAcceptSuccess,
  createL3FrontendClient,
  graphStateFromRead,
  L3_UI_COPY,
  normalizeL3Error,
  parseTargetWordInput,
  validateGraphParams,
  type L3ClientTransport,
  type L3ImportProposalResponse,
} from "@/l3/frontend/contract";
import type { L3GraphReadModel, L3ProposalConfirmResult, L3ProposalValidationResult, L3RecommendationAcceptResult } from "@/domain";

function makeTransport(response: { ok: boolean; status: number; body: unknown }): L3ClientTransport & { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async () => ({
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    })),
  };
}

describe("Phase 4A L3 frontend consumption contract", () => {
  it("submits raw import with camelCase payload and treats success as proposalCreated only", async () => {
    const response: L3ImportProposalResponse = {
      importJob: { id: "job-1", status: "completed" },
      proposal: { id: "prop-1", status: "pending" },
      items: [{ id: "item-1" }],
      parseStats: { contextCount: 1, occurrenceCount: 1, linkCount: 0, skippedContextCount: 0, warnings: [] },
    };
    const transport = makeTransport({ ok: true, status: 201, body: response });
    const client = createL3FrontendClient(transport);

    const result = await client.createRawTextImport({
      source: { sourceType: "manual", title: "Paste" },
      text: "A vivid account.",
      targetWords: parseTargetWordInput("vivid, vivid\naccount"),
      options: { contextType: "sentence" },
    });

    expect(transport.fetch).toHaveBeenCalledWith("/api/l3/imports/raw-text", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        source: { sourceType: "manual", title: "Paste" },
        text: "A vivid account.",
        targetWords: [{ slug: "vivid" }, { slug: "account" }],
        options: { contextType: "sentence" },
      }),
    }));
    expect(JSON.parse(transport.fetch.mock.calls[0][1].body)).not.toHaveProperty("source_type");

    const transition = applyImportSuccess(result);
    expect(transition.nextState).toBe("proposalCreated");
    expect(transition.message).toBe(L3_UI_COPY.importCreatedProposal);
    expect(transition.invalidate).toEqual(["l3.proposals.list"]);
    expect(transition.refreshGraph).toBe(false);
    expect(transition.createsActiveL3).toBe(false);
  });

  it("renders proposal validate valid=false as review feedback, not fatal error", () => {
    const validation: L3ProposalValidationResult = {
      proposal: { id: "prop-1", user_id: "u1", wordbook_id: null, source_type: "import", status: "pending", title: null, summary: null, input_hash: null, proposed_by: null, provenance: {}, review_note: null, confirmed_at: null, rejected_at: null, created_at: "now", updated_at: "now" },
      items: [],
      valid: false,
      errors: [{ itemId: "item-1", ordinal: 2, itemType: "occurrence", field: "surface", message: "surface mismatch" }],
    };

    const transition = applyProposalValidationResult(validation);

    expect(transition.nextState).toBe("invalid");
    expect(transition.refreshGraph).toBe(false);
    expect(transition.createsActiveL3).toBe(false);
    expect(transition.invalidate).toEqual(["l3.proposals.detail"]);
  });

  it("treats proposal confirm as the only active L3 graph-refreshing mutation", () => {
    const confirm: L3ProposalConfirmResult = {
      proposal: { id: "prop-1", user_id: "u1", wordbook_id: null, source_type: "import", status: "confirmed", title: null, summary: null, input_hash: null, proposed_by: null, provenance: {}, review_note: null, confirmed_at: "now", rejected_at: null, created_at: "now", updated_at: "now" },
      items: [],
      activeEntities: [{ itemId: "item-1", itemType: "context", activeEntityType: "context", activeEntityId: "ctx-1" }],
    };

    const transition = applyProposalConfirmSuccess(confirm);

    expect(transition.nextState).toBe("confirmed");
    expect(transition.createsActiveL3).toBe(true);
    expect(transition.refreshGraph).toBe(true);
    expect(transition.invalidate).toEqual(expect.arrayContaining(["l3.graph", "l3.context.detail", "l3.word.space", "l3.source.space"]));
  });

  it("accepts link_gap as proposal bridge without refreshing active graph", () => {
    const accept: L3RecommendationAcceptResult = {
      item: { id: "rec-1", run_id: "run-1", user_id: "u1", wordbook_id: null, recommendation_type: "link_gap", status: "accepted", title: "Link gap", summary: "Create link proposal", priority_score: 80, confidence: 0.8, reason_codes: [], evidence: [], payload: {}, accepted_proposal_id: "prop-1", created_at: "now", updated_at: "now", expires_at: null, accepted_at: "now", rejected_at: null, dismissed_at: null },
      proposal: {
        proposal: { id: "prop-1", user_id: "u1", wordbook_id: null, source_type: "agent", status: "pending", title: null, summary: null, input_hash: null, proposed_by: null, provenance: {}, review_note: null, confirmed_at: null, rejected_at: null, created_at: "now", updated_at: "now" },
        items: [],
      },
    };

    const transition = applyRecommendationAcceptSuccess(accept);

    expect(transition.nextState).toBe("accepted");
    expect(transition.message).toBe(L3_UI_COPY.recommendationAcceptedProposal);
    expect(transition.invalidate).toEqual(["l3.recommendations.detail", "l3.recommendations.list", "l3.proposals.list"]);
    expect(transition.refreshGraph).toBe(false);
    expect(transition.createsActiveL3).toBe(false);
  });

  it("normalizes 409 and 422 into actionable frontend errors", () => {
    expect(normalizeL3Error(409, { code: "CONFLICT", error: "Cannot confirm confirmed proposal" })).toMatchObject({
      status: 409,
      message: L3_UI_COPY.stateChanged,
      retryHint: "refresh",
    });

    expect(normalizeL3Error(422, {
      code: "VALIDATION_ERROR",
      error: "Proposal validation failed",
      details: { errors: [{ itemId: "item-1", ordinal: 1, field: "surface", message: "surface mismatch" }] },
    })).toMatchObject({
      status: 422,
      message: "Proposal validation failed",
      retryHint: "review-items",
      itemErrors: [{ itemId: "item-1", ordinal: 1, field: "surface", message: "surface mismatch" }],
    });
  });

  it("prevents invalid graph depth and limit before route request", async () => {
    expect(() => validateGraphParams({ depth: 3 })).toThrow(expect.objectContaining({
      status: 400,
      fieldErrors: { depth: ["Depth must be 1 or 2."] },
    }));
    expect(() => validateGraphParams({ limit: 301 })).toThrow(expect.objectContaining({
      status: 400,
      fieldErrors: { limit: ["Limit must be between 1 and 300."] },
    }));

    const graph: L3GraphReadModel = {
      nodes: [],
      edges: [],
      stats: { sourceCount: 0, contextCount: 0, occurrenceCount: 0, linkCount: 0, nodeCount: 0, edgeCount: 0 },
      limit: 100,
      cursor: null,
      nextCursor: null,
    };
    const transport = makeTransport({ ok: true, status: 200, body: graph });
    const client = createL3FrontendClient(transport);

    await client.getGraph({ slug: "vivid", depth: 2, limit: 50 });

    expect(transport.fetch).toHaveBeenCalledWith("/api/l3/graph?slug=vivid&depth=2&limit=50", expect.objectContaining({ method: "GET" }));
    expect(graphStateFromRead(graph)).toBe("empty");
  });
});
