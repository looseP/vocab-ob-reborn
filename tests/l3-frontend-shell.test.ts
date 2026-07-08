import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createBrowserL3Client } from "@/frontend/api/l3Client";
import { formatL3ErrorDetails } from "@/frontend/viewModels/l3ErrorViewModel";
import {
  applyGraphReadUiResult,
  buildGraphQueryPayload,
  graphEmptyMessage,
  graphStatsRows,
  summarizeGraphEdge,
  summarizeGraphNode,
} from "@/frontend/viewModels/l3GraphViewModel";
import { buildRawTextImportPayload, summarizeImportProposalItem } from "@/frontend/viewModels/l3ImportViewModel";
import { sortProposalItems, summarizeProposalItem } from "@/frontend/viewModels/l3ProposalViewModel";
import {
  applyRecommendationAcceptUiResult,
  applyRecommendationGenerateUiResult,
  applyRecommendationRejectUiResult,
  buildRecommendationGeneratePayload,
  proposalIdFromRecommendationAccept,
  recommendationAcceptMessage,
  recommendationActionsForStatus,
} from "@/frontend/viewModels/l3RecommendationViewModel";
import { normalizeL3Error } from "@/l3/frontend/contract";
import { markGraphStaleAfterProposalConfirm } from "@/frontend/state/l3CacheSignals";
import type {
  L3GraphReadModel,
  L3ProposalBundle,
  L3ProposalConfirmResult,
  L3ProposalItemRow,
  L3RecommendationBundle,
  L3RecommendationItemRow,
} from "@/domain";

describe("Phase 4B L3 frontend shell", () => {
  it("creates the browser L3 client through the shared contract adapter", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [], limit: 20, cursor: null, nextCursor: null }),
      input,
      init,
    })) as unknown as typeof fetch;

    const client = createBrowserL3Client("/backend", fetchImpl);
    const result = await client.listProposals({ status: "pending", limit: 20 });

    expect(result.items).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith("/backend/api/l3/proposals?status=pending&limit=20", expect.objectContaining({
      method: "GET",
    }));
  });

  it("keeps frontend shell imports away from server-only layers", () => {
    const files = [
      "src/frontend/App.tsx",
      "src/frontend/api/l3Client.ts",
      "src/frontend/components/L3ErrorMessage.tsx",
      "src/frontend/components/L3Shell.tsx",
      "src/frontend/pages/L3HomePage.tsx",
      "src/frontend/pages/L3ImportPage.tsx",
      "src/frontend/pages/L3ProposalPage.tsx",
      "src/frontend/pages/L3RecommendationPage.tsx",
      "src/frontend/pages/L3GraphPage.tsx",
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/@\/(?:db|repositories|services|http)\//);
      expect(source).not.toMatch(/@\/server/);
      expect(source).not.toMatch(/from ["'](?:node:)?(?:fs|path|crypto|process)["']/);
    }
  });

  it("keeps implemented L3 pages on the shared frontend client instead of local fetch calls", () => {
    const files = [
      "src/frontend/pages/L3ImportPage.tsx",
      "src/frontend/pages/L3ProposalPage.tsx",
      "src/frontend/pages/L3RecommendationPage.tsx",
      "src/frontend/pages/L3GraphPage.tsx",
    ];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/XMLHttpRequest/);
      expect(source).not.toContain("/api/l3/");
      expect(source).toMatch(/L3FrontendClient|client\./);
    }
  });

  it("builds raw import payloads only after explicit local field validation", () => {
    let caught: unknown;
    try {
      buildRawTextImportPayload({
        sourceTitle: " ",
        sourceType: "manual",
        sourceLanguage: "en",
        wordbookId: " ",
        text: " ",
        targetWords: "vivid",
        contextType: "sentence",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      status: 400,
      fieldErrors: {
        "source.title": ["source.title cannot be empty."],
        text: ["text cannot be empty."],
      },
    });

    const payload = buildRawTextImportPayload({
      sourceTitle: "  Manual note  ",
      sourceType: "manual",
      sourceLanguage: " en ",
      wordbookId: " wb-1 ",
      text: "A vivid sentence.",
      targetWords: " vivid,\nVIVID,, lucid ",
      contextType: "sentence",
    });

    expect(payload).toMatchObject({
      wordbookId: "wb-1",
      source: { sourceType: "manual", title: "Manual note", language: "en" },
      targetWords: [{ slug: "vivid" }, { slug: "lucid" }],
      options: { contextType: "sentence" },
    });
  });

  it("summarizes import and proposal items without relying on raw JSON dumps", () => {
    const contextItem = proposalItem({
      id: "item-2",
      item_type: "context",
      ordinal: 2,
      payload: { contextType: "sentence", text: "A long but readable context." },
    });
    const occurrenceItem = proposalItem({
      id: "item-1",
      item_type: "occurrence",
      ordinal: 1,
      payload: { slug: "vivid", surface: "vivid", startOffset: 2, endOffset: 7 },
    });

    expect(sortProposalItems([contextItem, occurrenceItem]).map((item: L3ProposalItemRow) => item.ordinal)).toEqual([1, 2]);
    expect(summarizeProposalItem(occurrenceItem)).toBe("vivid: vivid [2-7]");
    expect(summarizeProposalItem(contextItem)).toBe("A long but readable context.");
    expect(summarizeImportProposalItem({ item_type: "context_link", ordinal: 3, payload: { linkType: "illustrates", targetType: "word" } }, 0))
      .toBe("#3 context_link: illustrates -> word");
  });

  it("formats normalized error details without leaking object display strings", () => {
    const error = normalizeL3Error(409, {
      code: "CONFLICT",
      message: "State changed. Refresh and retry.",
      details: { currentStatus: "confirmed" },
    });
    const validation = normalizeL3Error(422, {
      message: "Validation failed.",
      details: { errors: [{ itemId: "item-1", field: "surface", message: "surface mismatch" }] },
    });

    expect(formatL3ErrorDetails(error)).toBe("{\"currentStatus\":\"confirmed\"}");
    expect(formatL3ErrorDetails(error)).not.toBe("[object Object]");
    expect(formatL3ErrorDetails(validation)).toBeNull();
    expect(validation.itemErrors).toEqual([{ itemId: "item-1", field: "surface", message: "surface mismatch" }]);
  });

  it("builds recommendation generate payloads with local numeric validation", () => {
    const payload = buildRecommendationGeneratePayload({
      mode: "gap_scan",
      wordbookId: " wb-1 ",
      seedSlug: " vivid ",
      limit: " 12 ",
      horizonDays: " 30 ",
      dryRun: true,
    });

    expect(payload).toEqual({
      mode: "gap_scan",
      wordbookId: "wb-1",
      seedSlug: "vivid",
      limit: 12,
      horizonDays: 30,
      dryRun: true,
    });

    let caught: unknown;
    try {
      buildRecommendationGeneratePayload({
        mode: "gap_scan",
        wordbookId: "",
        seedSlug: "",
        limit: "101",
        horizonDays: "0",
        dryRun: false,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      status: 400,
      fieldErrors: {
        limit: ["limit must be between 1 and 100."],
        horizonDays: ["horizonDays must be between 1 and 90."],
      },
    });
  });

  it("keeps recommendation generation scoped to recommendation cache only", () => {
    const result = applyRecommendationGenerateUiResult(recommendationBundle({
      run: { id: "run-1", mode: "gap_scan" },
      items: [recommendationItem({ id: "rec-1" })],
      stats: { generated: 1 },
    }));

    expect(result.nextState).toBe("pending");
    expect(result.refreshGraph).toBe(false);
    expect(result.createsActiveL3).toBe(false);
    expect(result.cache).toMatchObject({
      activeReadInvalidation: false,
      proposalInvalidation: false,
      recommendationInvalidation: true,
      reason: "recommendations_generated",
    });

    const dryRun = applyRecommendationGenerateUiResult(recommendationBundle({
      run: { id: "dry-run", mode: "gap_scan" },
      items: [recommendationItem({ id: "dry-rec" })],
      stats: { generated: 1 },
    }));

    expect(dryRun.invalidate).toEqual([]);
    expect(dryRun.cache.recommendationInvalidation).toBe(false);
  });

  it("models link_gap acceptance as a proposal bridge without active graph invalidation", () => {
    const accepted = recommendationItem({
      id: "rec-link",
      recommendation_type: "link_gap",
      status: "accepted",
      accepted_proposal_id: "prop-link",
    });
    const proposal = proposalBundle({ id: "prop-link" });
    const result = applyRecommendationAcceptUiResult({ item: accepted, proposal });

    expect(result.nextState).toBe("proposalBridgeCreated");
    expect(result.message).toContain("Confirm it before creating the active link");
    expect(result.refreshGraph).toBe(false);
    expect(result.createsActiveL3).toBe(false);
    expect(result.cache).toMatchObject({
      activeReadInvalidation: false,
      proposalInvalidation: true,
      recommendationInvalidation: true,
      reason: "recommendation_accept_created_pending_proposal",
      nextSuggestedAction: "review_proposal",
    });
    expect(proposalIdFromRecommendationAccept({ item: accepted, proposal })).toBe("prop-link");
    expect(recommendationAcceptMessage({ item: accepted, proposal })).toBe("Proposal created; review required before active L3 link exists.");
  });

  it("keeps future recommendation acceptance and rejection away from active graph invalidation", () => {
    const accepted = recommendationItem({
      id: "rec-future",
      recommendation_type: "learn_next",
      status: "accepted",
    });
    const acceptResult = applyRecommendationAcceptUiResult({ item: accepted, actionPayload: { next: "learn" } });

    expect(acceptResult.nextState).toBe("futureAction");
    expect(acceptResult.refreshGraph).toBe(false);
    expect(acceptResult.createsActiveL3).toBe(false);
    expect(acceptResult.cache).toMatchObject({
      activeReadInvalidation: false,
      proposalInvalidation: false,
      recommendationInvalidation: true,
      reason: "recommendation_accept_future_action",
    });
    expect(recommendationAcceptMessage({ item: accepted, actionPayload: { next: "learn" } })).toBe(
      "This acceptance records a future action; it does not create active L3 rows.",
    );

    const rejected = applyRecommendationRejectUiResult(recommendationItem({
      id: "rec-rejected",
      status: "rejected",
      recommendation_type: "context_gap",
    }));

    expect(rejected.nextState).toBe("rejected");
    expect(rejected.refreshGraph).toBe(false);
    expect(rejected.createsActiveL3).toBe(false);
    expect(rejected.cache).toMatchObject({
      activeReadInvalidation: false,
      proposalInvalidation: false,
      recommendationInvalidation: true,
      reason: "recommendation_rejected_no_active_l3_change",
    });
  });

  it("derives recommendation actions only for pending items", () => {
    expect(recommendationActionsForStatus("pending")).toEqual({ state: "pending", canAccept: true, canReject: true });
    expect(recommendationActionsForStatus("accepted")).toEqual({ state: "accepted", canAccept: false, canReject: false });
    expect(recommendationActionsForStatus("rejected")).toEqual({ state: "rejected", canAccept: false, canReject: false });
    expect(recommendationActionsForStatus("dismissed")).toEqual({ state: "dismissed", canAccept: false, canReject: false });
    expect(recommendationActionsForStatus("expired")).toEqual({ state: "expired", canAccept: false, canReject: false });
  });

  it("builds graph query payloads with local trim and bounds validation", () => {
    const payload = buildGraphQueryPayload({
      wordbookId: " wb-1 ",
      slug: " vivid ",
      sourceId: " src-1 ",
      depth: "2",
      limit: " 150 ",
      cursor: " cur-1 ",
    });

    expect(payload).toEqual({
      wordbookId: "wb-1",
      slug: "vivid",
      sourceId: "src-1",
      depth: 2,
      limit: 150,
      cursor: "cur-1",
    });

    expect(buildGraphQueryPayload({
      wordbookId: " ",
      slug: "",
      sourceId: " ",
      depth: "",
      limit: "",
      cursor: " ",
    })).toEqual({});

    for (const badDepth of ["0", "3", "abc"]) {
      let caught: unknown;
      try {
        buildGraphQueryPayload({ wordbookId: "", slug: "", sourceId: "", depth: badDepth, limit: "100", cursor: "" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        status: 400,
        fieldErrors: { depth: ["depth must be between 1 and 2."] },
      });
    }

    for (const badLimit of ["0", "301", "abc"]) {
      let caught: unknown;
      try {
        buildGraphQueryPayload({ wordbookId: "", slug: "", sourceId: "", depth: "1", limit: badLimit, cursor: "" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        status: 400,
        fieldErrors: { limit: ["limit must be between 1 and 300."] },
      });
    }
  });

  it("derives graph stats, rows, empty messages, and read-only cache behavior", () => {
    const emptyGraph = graphModel();
    const graph = graphModel({
      nodes: [{
        id: "word:w1",
        type: "word",
        label: "vivid",
        ref: { wordId: "w1" },
        metadata: { slug: "vivid" },
      }],
      edges: [{
        id: "edge-1",
        type: "illustrates",
        sourceNodeId: "context:ctx-1",
        targetNodeId: "word:w1",
        confidence: 0.9,
        evidence: { linkId: "link-1" },
      }],
      stats: {
        sourceCount: 1,
        contextCount: 1,
        occurrenceCount: 1,
        linkCount: 1,
        nodeCount: 1,
        edgeCount: 1,
      },
      limit: 25,
      nextCursor: "next-1",
    });

    expect(graphEmptyMessage(emptyGraph)).toBe("No L3 graph data for current filters.");
    expect(graphEmptyMessage(graphModel({ nodes: graph.nodes, edges: [] }))).toBe("No graph edges for current filters.");
    expect(graphEmptyMessage(graph)).toBeNull();
    expect(graphStatsRows(graph)).toEqual([
      { label: "Sources", value: 1 },
      { label: "Contexts", value: 1 },
      { label: "Occurrences", value: 1 },
      { label: "Links", value: 1 },
      { label: "Nodes", value: 1 },
      { label: "Edges", value: 1 },
      { label: "Limit", value: 25 },
      { label: "Next Cursor", value: "next-1" },
    ]);
    expect(summarizeGraphNode(graph.nodes[0])).toBe("word: vivid");
    expect(summarizeGraphEdge(graph.edges[0])).toBe("illustrates: context:ctx-1 -> word:w1");

    const transition = applyGraphReadUiResult(graph);
    expect(transition).toMatchObject({
      nextState: "loaded",
      invalidate: [],
      refreshGraph: false,
      createsActiveL3: false,
      cache: {
        activeReadInvalidation: false,
        proposalInvalidation: false,
        recommendationInvalidation: false,
        reason: "graph_read_no_invalidation",
      },
    });
  });

  it("keeps graph stale signals exclusive to proposal confirm semantics", () => {
    const confirm: L3ProposalConfirmResult = {
      proposal: proposalBundle({ status: "confirmed" }).proposal,
      items: [],
      activeEntities: [
        { itemId: "item-1", itemType: "context_link", activeEntityType: "context_link", activeEntityId: "link-1" },
      ],
    };

    expect(markGraphStaleAfterProposalConfirm(confirm)).toEqual({
      state: "staleAfterConfirm",
      reason: "proposal_confirmed_active_l3_created",
      activeEntities: confirm.activeEntities,
    });
    expect(applyGraphReadUiResult(graphModel()).cache.activeReadInvalidation).toBe(false);
  });
});

function proposalItem(overrides: Partial<L3ProposalItemRow>): L3ProposalItemRow {
  return {
    id: "item-1",
    proposal_id: "prop-1",
    user_id: "u1",
    item_type: "context",
    ordinal: 1,
    payload: {},
    status: "pending",
    validation_errors: {},
    active_entity_type: null,
    active_entity_id: null,
    created_at: "now",
    updated_at: "now",
    ...overrides,
  };
}

function proposalBundle(overrides: Partial<L3ProposalBundle["proposal"]> = {}): L3ProposalBundle {
  return {
    proposal: {
      id: "prop-1",
      user_id: "u1",
      wordbook_id: null,
      source_type: "agent",
      status: "pending",
      title: "Recommendation bridge",
      summary: null,
      input_hash: null,
      proposed_by: null,
      provenance: {},
      review_note: null,
      confirmed_at: null,
      rejected_at: null,
      created_at: "now",
      updated_at: "now",
      ...overrides,
    },
    items: [],
  };
}

function recommendationBundle(overrides: {
  run?: Partial<L3RecommendationBundle["run"]>;
  items?: L3RecommendationItemRow[];
  stats?: L3RecommendationBundle["stats"];
} = {}): L3RecommendationBundle {
  return {
    run: {
      id: "run-1",
      user_id: "u1",
      wordbook_id: null,
      mode: "gap_scan",
      status: "completed",
      input_hash: null,
      stats: {},
      created_at: "now",
      completed_at: "now",
      ...overrides.run,
    },
    items: overrides.items ?? [],
    stats: overrides.stats ?? {},
  };
}

function recommendationItem(overrides: Partial<L3RecommendationItemRow> = {}): L3RecommendationItemRow {
  return {
    id: "rec-1",
    run_id: "run-1",
    user_id: "u1",
    wordbook_id: null,
    recommendation_type: "link_gap",
    status: "pending",
    title: "Link gap",
    summary: "Candidate link gap.",
    priority_score: 80,
    confidence: 0.7,
    reason_codes: ["link_gap"],
    evidence: [{ type: "graph_edge", ref: { sourceWordId: "w1" } }],
    payload: { sourceWordId: "w1", targetWordId: "w2" },
    accepted_proposal_id: null,
    created_at: "now",
    updated_at: "now",
    expires_at: null,
    accepted_at: null,
    rejected_at: null,
    dismissed_at: null,
    ...overrides,
  };
}

function graphModel(overrides: Partial<L3GraphReadModel> = {}): L3GraphReadModel {
  return {
    nodes: [],
    edges: [],
    stats: {
      sourceCount: 0,
      contextCount: 0,
      occurrenceCount: 0,
      linkCount: 0,
      nodeCount: 0,
      edgeCount: 0,
    },
    limit: 100,
    cursor: null,
    nextCursor: null,
    ...overrides,
  };
}
