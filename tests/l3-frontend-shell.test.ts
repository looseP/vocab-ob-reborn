import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createBrowserL3Client } from "@/frontend/api/l3Client";
import { L3_SHELL_SECTIONS } from "@/frontend/viewModels/l3ShellViewModel";
import {
  frontendCacheSignalMatrix,
  frontendRuntimeSmokeMatrix,
  graphEdgeRowsFromRead,
  graphStaleBannerText,
  importProposalReviewHandoff,
  recommendationProposalReviewHandoff,
  shouldClearGraphStaleAfterRead,
} from "@/frontend/viewModels/l3ClosedLoopViewModel";
import { formatL3ErrorDetails, l3ErrorUxContract } from "@/frontend/viewModels/l3ErrorViewModel";
import {
  applyGraphReadUiResult,
  buildGraphCanvasModel,
  buildGraphQueryPayload,
  compactGraphLabel,
  getGraphEdgeDisplay,
  getGraphLegendItems,
  getGraphNodeDisplay,
  graphEmptyMessage,
  graphStatsRows,
  layoutGraphNodes,
  summarizeGraphEdge,
  summarizeGraphNode,
  summarizeSelectedGraphItem,
} from "@/frontend/viewModels/l3GraphViewModel";
import { buildRawTextImportPayload, summarizeImportProposalItem } from "@/frontend/viewModels/l3ImportViewModel";
import {
  canNavigate,
  contextNavigationAction,
  contextSourceNavigationAction,
  graphForSourceNavigationAction,
  graphForWordNavigationAction,
  graphSelectionNavigation,
  linkTargetNavigationAction,
  occurrenceContextNavigationAction,
  occurrenceWordNavigationAction,
  proposalReviewNavigationAction,
  sourceNavigationAction,
  wordNavigationAction,
} from "@/frontend/viewModels/l3NavigationViewModel";
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
import {
  applySpaceReadUiResult,
  buildContextLookupPayload,
  buildSourceSpaceQueryPayload,
  buildWordSpaceQueryPayload,
  contextEmptyMessages,
  contextPreview,
  linkSummary,
  occurrenceSummary,
  readStaleBannerText,
  shouldClearReadStaleAfterSpaceRead,
  sourceSpaceEmptyMessage,
  wordSpaceEmptyMessage,
} from "@/frontend/viewModels/l3SpaceViewModel";
import { normalizeL3Error, normalizeL3TransportError, type L3ImportProposalResponse } from "@/l3/frontend/contract";
import { markActiveReadStaleAfterProposalConfirm, markGraphStaleAfterProposalConfirm } from "@/frontend/state/l3CacheSignals";
import type {
  L3ContextDetail,
  L3ContextLinkRow,
  L3ContextRow,
  L3GraphReadModel,
  L3OccurrenceRow,
  L3ProposalBundle,
  L3ProposalConfirmResult,
  L3ProposalItemRow,
  L3ProposalValidationResult,
  L3RecommendationBundle,
  L3RecommendationItemRow,
  L3SourceRow,
  L3SourceSpace,
  L3WordSpace,
  WordRow,
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
    for (const file of l3FrontendBoundaryFiles()) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/@\/(?:db|repositories|services|http)\//);
      expect(source).not.toMatch(/@\/server/);
      expect(source).not.toMatch(/from ["'](?:node:)?(?:fs|path|crypto|process)["']/);
    }
  });

  it("keeps implemented L3 frontend files away from local network calls", () => {
    for (const file of l3FrontendBoundaryFiles().filter((candidate) => !candidate.endsWith("src/frontend/api/l3Client.ts"))) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/XMLHttpRequest/);
      expect(source).not.toContain("/api/l3/");
      if (file.includes("/pages/") && !file.endsWith("src/frontend/pages/L3HomePage.tsx")) {
        expect(source).toMatch(/L3FrontendClient|client\./);
      }
    }
  });

  it("locks the Phase 4I shell navigation matrix to every read/review surface", () => {
    expect(L3_SHELL_SECTIONS).toEqual([
      { id: "home", label: "L3 Home" },
      { id: "import", label: "Import" },
      { id: "proposals", label: "Proposals" },
      { id: "recommendations", label: "Recommendations" },
      { id: "graph", label: "Graph" },
      { id: "context", label: "Context" },
      { id: "word", label: "Word Space" },
      { id: "source", label: "Source Space" },
    ]);
    expect(frontendRuntimeSmokeMatrix().map((row) => row.surface)).toEqual([
      "import",
      "proposals",
      "recommendations",
      "graph",
      "context",
      "word",
      "source",
    ]);
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

  it("keeps 409 and 422 feedback shapes consistent across L3 surfaces", () => {
    const conflict = normalizeL3Error(409, {
      code: "CONFLICT",
      message: "State changed. Refresh and retry.",
      details: { currentStatus: "accepted" },
    });
    const graphValidation = normalizeL3Error(422, {
      code: "VALIDATION_ERROR",
      message: "Graph cursor is invalid.",
      details: { fieldErrors: { cursor: ["Invalid cursor."] } },
    });

    expect(conflict).toMatchObject({
      status: 409,
      kind: "conflict",
      retryHint: "refresh",
    });
    expect(formatL3ErrorDetails(conflict)).toBe("{\"currentStatus\":\"accepted\"}");
    expect(graphValidation).toMatchObject({
      status: 422,
      kind: "validation",
      retryHint: "review-items",
      fieldErrors: { cursor: ["Invalid cursor."] },
    });
    expect(formatL3ErrorDetails(graphValidation)).toBeNull();
  });

  it("keeps 400/404/409/422/500/network/aborted error UX out of empty-state handling", () => {
    const errors = [
      normalizeL3Error(400, { message: "Bad form", details: { fieldErrors: { text: ["Required"] } } }),
      normalizeL3Error(404, { message: "Missing context" }),
      normalizeL3Error(409, { message: "Already confirmed", details: { currentStatus: "confirmed" } }),
      normalizeL3Error(422, { message: "Validation failed", details: { errors: [{ field: "surface", message: "mismatch" }] } }),
      normalizeL3Error(500, { message: "Unexpected" }),
      normalizeL3TransportError(new Error("Network failed")),
      normalizeL3TransportError({ name: "AbortError", message: "Request was cancelled" }),
    ];

    expect(errors.map((error) => l3ErrorUxContract(error))).toEqual([
      { title: "Request needs local input changes.", retryHint: "fix-input", preservesInput: true, isEmptyState: false },
      { title: "Requested L3 record was not found.", retryHint: "refresh", preservesInput: true, isEmptyState: false },
      { title: "L3 state changed; refresh before retrying.", retryHint: "refresh", preservesInput: true, isEmptyState: false },
      { title: "L3 business validation failed.", retryHint: "review-items", preservesInput: true, isEmptyState: false },
      { title: "Unexpected L3 service error.", retryHint: "retry", preservesInput: true, isEmptyState: false },
      { title: "Network request failed.", retryHint: "retry", preservesInput: true, isEmptyState: false },
      { title: "Request was cancelled.", retryHint: "none", preservesInput: true, isEmptyState: false },
    ]);
    for (const error of errors) {
      expect(formatL3ErrorDetails(error)).not.toBe("[object Object]");
      expect(l3ErrorUxContract(error).isEmptyState).toBe(false);
    }
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

  it("builds context, word, and source space read payloads with local validation", () => {
    expect(buildContextLookupPayload({ contextId: " ctx-1 " })).toEqual({ contextId: "ctx-1" });
    expect(buildWordSpaceQueryPayload({
      slug: " vivid ",
      wordbookId: " wb-1 ",
      limit: " 25 ",
      cursor: " next ",
    })).toEqual({
      slug: "vivid",
      params: { wordbookId: "wb-1", limit: 25, cursor: "next" },
    });
    expect(buildWordSpaceQueryPayload({
      slug: "lucid",
      wordbookId: " ",
      limit: "",
      cursor: "",
    })).toEqual({ slug: "lucid", params: {} });
    expect(buildSourceSpaceQueryPayload({
      sourceId: " src-1 ",
      limit: "50",
      cursor: " c1 ",
    })).toEqual({
      sourceId: "src-1",
      params: { limit: 50, cursor: "c1" },
    });

    for (const build of [
      () => buildContextLookupPayload({ contextId: " " }),
      () => buildWordSpaceQueryPayload({ slug: "", wordbookId: "", limit: "", cursor: "" }),
      () => buildSourceSpaceQueryPayload({ sourceId: "", limit: "", cursor: "" }),
      () => buildWordSpaceQueryPayload({ slug: "vivid", wordbookId: "", limit: "101", cursor: "" }),
      () => buildSourceSpaceQueryPayload({ sourceId: "src-1", limit: "0", cursor: "" }),
    ]) {
      let caught: unknown;
      try {
        build();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ status: 400, kind: "bad_request" });
    }
  });

  it("derives context, word, and source space summaries without backend inference", () => {
    const detail = contextDetail({ occurrences: [], links: [] });
    const word = wordSpace({
      contexts: [],
      occurrences: [],
      links: [],
      stats: { sourceCount: 1, contextCount: 0, occurrenceCount: 0, linkCount: 0 },
    });
    const source = sourceSpace({
      contexts: [],
      occurrences: [],
      links: [],
      stats: { sourceCount: 1, contextCount: 0, occurrenceCount: 0, linkCount: 0 },
    });
    const occurrence = occurrenceRow({ surface: "vivid", lemma: "vivid", start_offset: 2, end_offset: 7 });
    const link = linkRow({ link_type: "illustrates", target_type: "word", target_id: "word-1" });

    expect(contextPreview(detail.context)).toBe("A vivid context sentence.");
    expect(contextEmptyMessages(detail)).toEqual([
      "No occurrences are attached to this context.",
      "No context links are attached to this context.",
    ]);
    expect(wordSpaceEmptyMessage(word)).toBe("No active L3 space rows for this word.");
    expect(sourceSpaceEmptyMessage(source)).toBe("No contexts are attached to this source.");
    expect(occurrenceSummary(occurrence)).toBe("vivid / vivid [2-7]");
    expect(linkSummary(link)).toBe("illustrates: ctx-1 -> word:word-1");
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

  it("builds deterministic graph canvas models without fabricating response data", () => {
    const graph = graphModel({
      nodes: [
        { id: "word:w1", type: "word", label: "vivid", ref: { wordId: "w1" }, metadata: { slug: "vivid" } },
        { id: "source:src-1", type: "source", label: "Manual source", ref: { sourceId: "src-1" } },
        { id: "context:ctx-1", type: "context", label: "A vivid sentence", ref: { contextId: "ctx-1" } },
      ],
      edges: [
        { id: "edge-2", type: "occurs_in", sourceNodeId: "word:w1", targetNodeId: "context:ctx-1", confidence: 0.9 },
        { id: "edge-1", type: "belongs_to", sourceNodeId: "context:ctx-1", targetNodeId: "source:src-1" },
      ],
      stats: { sourceCount: 1, contextCount: 1, occurrenceCount: 1, linkCount: 0, nodeCount: 3, edgeCount: 2 },
    });

    const first = buildGraphCanvasModel(graph);
    const second = buildGraphCanvasModel(graphModel({
      ...graph,
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    }));

    expect(first).toEqual(second);
    expect(first.state).toBe("ready");
    expect(first.nodes).toHaveLength(graph.nodes.length);
    expect(first.edges).toHaveLength(graph.edges.length);
    expect(first.nodes.map((node) => node.id)).toEqual(["source:src-1", "context:ctx-1", "word:w1"]);
    expect(first.edges.map((edge) => edge.id)).toEqual(["edge-1", "edge-2"]);
    expect(first.summary).toBe("3 visual nodes / 2 visual edges from graph response.");
  });

  it("handles empty graph, unknown types, long labels, and missing edge endpoints safely", () => {
    const empty = buildGraphCanvasModel(graphModel());
    const unknownGraph = graphModel({
      nodes: [{
        id: "",
        type: "mystery" as never,
        label: "A very long graph node label that should be compacted for display",
        ref: {},
      }],
      edges: [{
        id: "",
        type: "unexpected_edge" as never,
        sourceNodeId: "missing-source",
        targetNodeId: "missing-target",
      }],
      stats: { sourceCount: 0, contextCount: 0, occurrenceCount: 0, linkCount: 1, nodeCount: 1, edgeCount: 1 },
    });
    const model = buildGraphCanvasModel(unknownGraph);

    expect(empty).toMatchObject({ state: "empty", nodes: [], edges: [], summary: "No visual graph data for current filters." });
    expect(buildGraphCanvasModel(graphModel({
      nodes: [],
      edges: [{
        id: "edge-without-response-nodes",
        type: "illustrates",
        sourceNodeId: "word:w1",
        targetNodeId: "word:w2",
      }],
    }))).toMatchObject({
      state: "ready",
      nodes: [],
      edges: [{ id: "edge-without-response-nodes", missingEndpoint: true }],
      summary: "0 visual nodes / 1 visual edges from graph response.",
    });
    expect(getGraphNodeDisplay(unknownGraph.nodes[0])).toMatchObject({
      id: "unknown-node",
      type: "mystery",
      typeLabel: "Unknown",
      compactLabel: "A very long gra...",
    });
    expect(getGraphEdgeDisplay(unknownGraph.edges[0])).toMatchObject({
      id: "missing-source:unexpected_edge:missing-target",
      type: "unexpected_edge",
      label: "unexpected edge",
    });
    expect(model.nodes).toHaveLength(1);
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0].missingEndpoint).toBe(true);
    expect(compactGraphLabel("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefg...");
  });

  it("summarizes graph canvas node and edge selection from latest read response", () => {
    const graph = graphModel({
      nodes: [
        { id: "context:ctx-1", type: "context", label: "Context detail", ref: { contextId: "ctx-1" } },
        { id: "word:w1", type: "word", label: "vivid", ref: { wordId: "w1" } },
      ],
      edges: [
        { id: "edge-1", type: "illustrates", sourceNodeId: "context:ctx-1", targetNodeId: "word:w1", evidence: { linkId: "link-1" } },
      ],
      stats: { sourceCount: 0, contextCount: 1, occurrenceCount: 1, linkCount: 1, nodeCount: 2, edgeCount: 1 },
    });

    expect(summarizeSelectedGraphItem(graph, null)).toBe("Select a node or edge to inspect graph response details.");
    expect(summarizeSelectedGraphItem(graph, { kind: "node", id: "word:w1" })).toBe("Word: vivid");
    expect(summarizeSelectedGraphItem(graph, { kind: "edge", id: "edge-1" })).toBe("illustrates: context:ctx-1 -> word:w1");
    expect(summarizeSelectedGraphItem(graph, { kind: "node", id: "missing" })).toBe("Selected node is no longer present in the latest graph response.");
    expect(summarizeSelectedGraphItem(graph, { kind: "edge", id: "missing" })).toBe("Selected edge is no longer present in the latest graph response.");
  });

  it("derives graph canvas legend and layout with stable display guards", () => {
    const graph = graphModel({
      nodes: [
        { id: "external:e1", type: "external", label: "External target", ref: { targetRef: "e1" } },
        { id: "word:w1", type: "word", label: "vivid", ref: { wordId: "w1" } },
        { id: "word:w2", type: "word", label: "lucid", ref: { wordId: "w2" } },
      ],
      edges: [
        { id: "edge-1", type: "illustrates", sourceNodeId: "word:w1", targetNodeId: "word:w2" },
      ],
    });

    expect(layoutGraphNodes(graph.nodes, graph.edges).map((node) => ({ id: node.id, x: node.x, y: node.y }))).toEqual([
      { id: "word:w2", x: 320, y: 140 },
      { id: "word:w1", x: 640, y: 160 },
      { id: "external:e1", x: 320, y: 280 },
    ]);
    expect(getGraphLegendItems(graph)).toEqual([
      { type: "word", label: "Word", color: "#2563eb", count: 2 },
      { type: "external", label: "External", color: "#6b7280", count: 1 },
    ]);
  });

  it("builds graph node and edge navigation intents only from explicit response targets", () => {
    const graph = graphModel({
      nodes: [
        { id: "context:ctx-1", type: "context", label: "Context detail", ref: { contextId: "ctx-1" } },
        { id: "word:w1", type: "word", label: "vivid", ref: { wordId: "w1" }, metadata: { slug: "vivid", wordbookId: "wb-1" } },
        { id: "source:src-1", type: "source", label: "Manual source", ref: { sourceId: "src-1", wordbookId: "wb-1" } },
        { id: "topic:t1", type: "topic", label: "Weather", ref: { label: "weather" } },
        { id: "word:w2", type: "word", label: "No slug word", ref: { wordId: "w2" } },
      ],
      edges: [
        { id: "edge-1", type: "occurs_in", sourceNodeId: "word:w1", targetNodeId: "context:ctx-1" },
        { id: "edge-2", type: "illustrates", sourceNodeId: "topic:t1", targetNodeId: "word:w2" },
      ],
    });

    expect(graphSelectionNavigation(graph, { kind: "node", id: "context:ctx-1" }).selected).toEqual([
      { label: "Open Context", intent: { target: "context", contextId: "ctx-1" }, reason: null },
    ]);
    expect(graphSelectionNavigation(graph, { kind: "node", id: "word:w1" }).selected).toEqual([
      { label: "Open Word Space", intent: { target: "word", slug: "vivid", wordbookId: "wb-1" }, reason: null },
    ]);
    expect(graphSelectionNavigation(graph, { kind: "node", id: "source:src-1" }).selected).toEqual([
      { label: "Open Source Space", intent: { target: "source", sourceId: "src-1" }, reason: null },
    ]);

    const edgeNavigation = graphSelectionNavigation(graph, { kind: "edge", id: "edge-1" });
    expect(edgeNavigation.endpoints).toEqual([
      { label: "Open Source Node", intent: { target: "word", slug: "vivid", wordbookId: "wb-1" }, reason: null },
      { label: "Open Target Node", intent: { target: "context", contextId: "ctx-1" }, reason: null },
    ]);

    const disabled = graphSelectionNavigation(graph, { kind: "edge", id: "edge-2" }).endpoints;
    expect(disabled.map((action) => canNavigate(action))).toEqual([false, false]);
    expect(disabled.map((action) => action.reason)).toEqual([
      "topic nodes are metadata-only in this phase.",
      "Missing explicit slug in graph response.",
    ]);
  });

  it("builds context, word, source, and proposal navigation intents without guessing slugs from labels", () => {
    const context = contextRow({ id: "ctx-99", source_id: "src-99" });
    const source = sourceRow({ id: "src-99", wordbook_id: "wb-99" });
    const occurrenceWithSlug = occurrenceRow({ context_id: "ctx-99", evidence: { slug: "vivid" } });
    const occurrenceWithoutSlug = occurrenceRow({ context_id: "ctx-99", surface: "guessable" });

    expect(contextNavigationAction(context)).toEqual({
      label: "Open Context",
      intent: { target: "context", contextId: "ctx-99" },
      reason: null,
    });
    expect(sourceNavigationAction(source)).toEqual({
      label: "Open Source Space",
      intent: { target: "source", sourceId: "src-99" },
      reason: null,
    });
    expect(contextSourceNavigationAction(contextDetail({ source }))).toEqual(sourceNavigationAction(source));
    expect(occurrenceContextNavigationAction(occurrenceWithSlug)).toEqual({
      label: "Open Context",
      intent: { target: "context", contextId: "ctx-99" },
      reason: null,
    });
    expect(occurrenceWordNavigationAction(occurrenceWithSlug, "wb-99")).toEqual({
      label: "Open Word Space",
      intent: { target: "word", slug: "vivid", wordbookId: "wb-99" },
      reason: null,
    });
    expect(occurrenceWordNavigationAction(occurrenceWithoutSlug, "wb-99")).toEqual({
      label: "Open Word Space",
      intent: null,
      reason: "Missing explicit slug; word id alone is not enough.",
    });
    expect(wordNavigationAction({ slug: " lucid ", wordbookId: " wb-99 " })).toEqual({
      label: "Open Word Space",
      intent: { target: "word", slug: "lucid", wordbookId: "wb-99" },
      reason: null,
    });
    expect(graphForWordNavigationAction(wordSpace({ word: wordRow({ slug: "vivid" }) }), "wb-99")).toEqual({
      label: "Open Graph for this word",
      intent: { target: "graph", query: { slug: "vivid", wordbookId: "wb-99" } },
      reason: null,
    });
    expect(graphForSourceNavigationAction(sourceSpace({ source }))).toEqual({
      label: "Open Graph for this source",
      intent: { target: "graph", query: { sourceId: "src-99" } },
      reason: null,
    });
    expect(proposalReviewNavigationAction("prop-99")).toEqual({
      label: "Open Proposal Review",
      intent: { target: "proposal", proposalId: "prop-99" },
      reason: null,
    });
  });

  it("builds context link target navigation only for supported active read surfaces", () => {
    expect(linkTargetNavigationAction(linkRow({
      target_type: "context",
      target_id: "ctx-target",
    }))).toEqual({
      label: "Open Target Context",
      intent: { target: "context", contextId: "ctx-target" },
      reason: null,
    });
    expect(linkTargetNavigationAction(linkRow({
      target_type: "source",
      target_id: "src-target",
    }))).toEqual({
      label: "Open Target Source",
      intent: { target: "source", sourceId: "src-target" },
      reason: null,
    });
    expect(linkTargetNavigationAction(linkRow({
      target_type: "word",
      target_id: "word-target",
      target_ref: { slug: "lucid", wordbookId: "wb-1" },
    }))).toEqual({
      label: "Open Target Word",
      intent: { target: "word", slug: "lucid", wordbookId: "wb-1" },
      reason: null,
    });
    expect(linkTargetNavigationAction(linkRow({
      target_type: "word",
      target_id: "word-target",
      target_ref: {},
    }))).toEqual({
      label: "Open Target Word",
      intent: null,
      reason: "Missing explicit slug; word id alone is not enough.",
    });
    expect(linkTargetNavigationAction(linkRow({
      target_type: "l2_item",
      target_id: null,
      target_ref: { field: "definition", contentId: "l2-1" },
    }))).toEqual({
      label: "Open Link Target",
      intent: null,
      reason: "l2_item targets are metadata-only in this phase.",
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
    expect(markActiveReadStaleAfterProposalConfirm(confirm)).toEqual(markGraphStaleAfterProposalConfirm(confirm));
    expect(applyGraphReadUiResult(graphModel()).cache.activeReadInvalidation).toBe(false);
  });

  it("lets Context, Word, and Source reads consume read stale without clearing proposal or recommendation flags", () => {
    const confirm = proposalConfirmResult("prop-space", "ctx-1");
    const stale = markActiveReadStaleAfterProposalConfirm(confirm);
    const contextTransition = applySpaceReadUiResult(contextDetail(), false);
    const wordTransition = applySpaceReadUiResult(wordSpace(), false);
    const sourceTransition = applySpaceReadUiResult(sourceSpace(), false);

    expect(readStaleBannerText(stale)).toBe("L3 read data may be stale after proposal confirmation: proposal_confirmed_active_l3_created");
    for (const transition of [contextTransition, wordTransition, sourceTransition]) {
      expect(transition).toMatchObject({
        invalidate: [],
        refreshGraph: false,
        createsActiveL3: false,
        cache: {
          activeReadInvalidation: false,
          proposalInvalidation: false,
          recommendationInvalidation: false,
          reason: "space_read_no_invalidation",
        },
      });
      expect(shouldClearReadStaleAfterSpaceRead(transition)).toBe(true);
    }
  });

  it("models import proposal handoff through proposal confirm and graph stale refresh", () => {
    const importResult = importProposalResponse("prop-import");
    const handoff = importProposalReviewHandoff(importResult);
    const confirm = proposalConfirmResult("prop-import", "link-1");
    const stale = markGraphStaleAfterProposalConfirm(confirm);

    expect(handoff).toEqual({ proposalId: "prop-import", canOpenProposalReview: true });
    expect(importProposalReviewHandoff(null)).toEqual({ proposalId: null, canOpenProposalReview: false });
    expect(graphStaleBannerText(stale)).toBe("Graph may be stale after proposal confirmation: proposal_confirmed_active_l3_created");
    expect(shouldClearGraphStaleAfterRead(graphModel({
      nodes: [{ id: "word:w1", type: "word", label: "vivid", ref: { wordId: "w1" } }],
    }))).toBe(true);
  });

  it("models recommendation link_gap handoff through proposal confirm and graph edge readback", () => {
    const accepted = recommendationItem({
      id: "rec-link",
      recommendation_type: "link_gap",
      status: "accepted",
      accepted_proposal_id: "prop-link",
    });
    const proposal = proposalBundle({ id: "prop-link" });
    const handoff = recommendationProposalReviewHandoff({ item: accepted, proposal });
    const confirm = proposalConfirmResult("prop-link", "confirmed-link-id");
    const readGraph = graphModel({
      nodes: [
        { id: "context:ctx-1", type: "context", label: "Context", ref: { contextId: "ctx-1" } },
        { id: "word:w1", type: "word", label: "vivid", ref: { wordId: "w1" } },
      ],
      edges: [{
        id: "edge-from-graph-read",
        type: "collocates_with",
        sourceNodeId: "context:ctx-1",
        targetNodeId: "word:w1",
        confidence: 0.8,
        evidence: { activeLinkId: "confirmed-link-id" },
      }],
      stats: {
        sourceCount: 0,
        contextCount: 1,
        occurrenceCount: 1,
        linkCount: 1,
        nodeCount: 2,
        edgeCount: 1,
      },
    });

    expect(handoff).toEqual({ proposalId: "prop-link", canOpenProposalReview: true });
    expect(markGraphStaleAfterProposalConfirm(confirm).activeEntities[0].activeEntityId).toBe("confirmed-link-id");
    expect(graphEdgeRowsFromRead(readGraph)).toEqual([{
      id: "edge-from-graph-read",
      type: "collocates_with",
      sourceNodeId: "context:ctx-1",
      targetNodeId: "word:w1",
    }]);
  });

  it("locks the frontend cache and stale signal matrix across closed-loop actions", () => {
    const proposal = proposalBundle({ id: "prop-1" });
    const recommendation = recommendationItem({ status: "accepted", accepted_proposal_id: "prop-1" });
    const matrix = frontendCacheSignalMatrix({
      importResult: importProposalResponse("prop-1"),
      proposalValidation: proposalValidationResult("prop-1"),
      proposalConfirm: proposalConfirmResult("prop-1", "link-1"),
      proposalReject: proposalBundle({ id: "prop-reject", status: "rejected" }),
      recommendationGenerate: recommendationBundle({ items: [recommendationItem()] }),
      recommendationAccept: { item: recommendation, proposal },
      recommendationReject: recommendationItem({ id: "rec-reject", status: "rejected" }),
      graphRead: graphModel(),
    });

    expect(matrix.importSuccess).toMatchObject({ proposalInvalidation: true, activeReadInvalidation: false, recommendationInvalidation: false });
    expect(matrix.proposalValidation).toMatchObject({ proposalInvalidation: true, activeReadInvalidation: false });
    expect(matrix.proposalConfirm).toMatchObject({ proposalInvalidation: true, activeReadInvalidation: true, reason: "proposal_confirmed_active_l3_created" });
    expect(matrix.proposalReject).toMatchObject({ proposalInvalidation: true, activeReadInvalidation: false });
    expect(matrix.recommendationGenerate).toMatchObject({ recommendationInvalidation: true, activeReadInvalidation: false });
    expect(matrix.recommendationAccept).toMatchObject({ recommendationInvalidation: true, proposalInvalidation: true, activeReadInvalidation: false });
    expect(matrix.recommendationReject).toMatchObject({ recommendationInvalidation: true, activeReadInvalidation: false });
    expect(matrix.graphRead).toMatchObject({
      keys: [],
      proposalInvalidation: false,
      recommendationInvalidation: false,
      activeReadInvalidation: false,
      reason: "graph_read_no_invalidation",
    });
  });

  it("locks the Phase 4F runtime smoke surface matrix without adding feature scope", () => {
    expect(frontendRuntimeSmokeMatrix()).toEqual([
      {
        surface: "import",
        clientMethods: ["createRawTextImport"],
        readOnly: false,
        clearsActiveReadStale: false,
        marksActiveReadStale: false,
      },
      {
        surface: "proposals",
        clientMethods: ["listProposals", "getProposal", "validateProposal", "confirmProposal", "rejectProposal"],
        readOnly: false,
        clearsActiveReadStale: false,
        marksActiveReadStale: true,
      },
      {
        surface: "recommendations",
        clientMethods: ["generateRecommendations", "listRecommendations", "getRecommendation", "acceptRecommendation", "rejectRecommendation"],
        readOnly: false,
        clearsActiveReadStale: false,
        marksActiveReadStale: false,
      },
      {
        surface: "graph",
        clientMethods: ["getGraph"],
        readOnly: true,
        clearsActiveReadStale: true,
        marksActiveReadStale: false,
      },
      {
        surface: "context",
        clientMethods: ["getContextDetail"],
        readOnly: true,
        clearsActiveReadStale: true,
        marksActiveReadStale: false,
      },
      {
        surface: "word",
        clientMethods: ["getWordSpace"],
        readOnly: true,
        clearsActiveReadStale: true,
        marksActiveReadStale: false,
      },
      {
        surface: "source",
        clientMethods: ["getSourceSpace"],
        readOnly: true,
        clearsActiveReadStale: true,
        marksActiveReadStale: false,
      },
    ]);
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

function proposalValidationResult(proposalId = "prop-1"): L3ProposalValidationResult {
  return {
    ...proposalBundle({ id: proposalId }),
    valid: true,
    errors: [],
  };
}

function proposalConfirmResult(proposalId = "prop-1", activeEntityId = "link-1"): L3ProposalConfirmResult {
  return {
    ...proposalBundle({ id: proposalId, status: "confirmed", confirmed_at: "now" }),
    activeEntities: [
      { itemId: "item-1", itemType: "context_link", activeEntityType: "context_link", activeEntityId },
    ],
  };
}

function importProposalResponse(proposalId = "prop-1"): L3ImportProposalResponse {
  return {
    importJob: { id: "job-1", status: "completed" },
    proposal: { id: proposalId, status: "pending", title: "Imported proposal" },
    items: [{ id: "item-1", item_type: "context", ordinal: 1, payload: { text: "A vivid context." } }],
    parseStats: {
      contextCount: 1,
      occurrenceCount: 1,
      linkCount: 0,
      skippedContextCount: 0,
      warnings: [],
    },
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

function wordRow(overrides: Partial<WordRow> = {}): WordRow {
  return {
    id: "word-1",
    slug: "vivid",
    title: "Vivid",
    lemma: "vivid",
    pos: "adj",
    cefr: "B2",
    ipa: null,
    aliases: [],
    short_definition: "bright and clear",
    definition_md: "Bright and clear.",
    body_md: "",
    examples: [],
    metadata: {},
    source_path: "words/vivid.md",
    source_updated_at: null,
    content_hash: "hash",
    is_published: true,
    is_deleted: false,
    created_at: "now",
    updated_at: "now",
    ...overrides,
  };
}

function sourceRow(overrides: Partial<L3SourceRow> = {}): L3SourceRow {
  return {
    id: "src-1",
    user_id: "u1",
    wordbook_id: "wb-1",
    source_type: "manual",
    title: "Manual source",
    author: null,
    url: null,
    language: "en",
    metadata: {},
    created_at: "now",
    updated_at: "now",
    ...overrides,
  };
}

function contextRow(overrides: Partial<L3ContextRow> = {}): L3ContextRow {
  return {
    id: "ctx-1",
    source_id: "src-1",
    user_id: "u1",
    context_type: "sentence",
    text: "A vivid context sentence.",
    normalized_text: "a vivid context sentence.",
    language: "en",
    position: {},
    metadata: {},
    created_at: "now",
    updated_at: "now",
    ...overrides,
  };
}

function occurrenceRow(overrides: Partial<L3OccurrenceRow> = {}): L3OccurrenceRow {
  return {
    id: "occ-1",
    context_id: "ctx-1",
    word_id: "word-1",
    user_id: "u1",
    surface: "vivid",
    lemma: null,
    start_offset: null,
    end_offset: null,
    confidence: null,
    evidence: {},
    created_at: "now",
    ...overrides,
  };
}

function linkRow(overrides: Partial<L3ContextLinkRow> = {}): L3ContextLinkRow {
  return {
    id: "link-1",
    user_id: "u1",
    context_id: "ctx-1",
    word_id: "word-1",
    link_type: "illustrates",
    target_type: "word",
    target_id: "word-1",
    target_ref: {},
    confidence: null,
    provenance: {},
    created_at: "now",
    ...overrides,
  };
}

function contextDetail(overrides: Partial<L3ContextDetail> = {}): L3ContextDetail {
  return {
    context: contextRow(),
    source: sourceRow(),
    occurrences: [occurrenceRow()],
    links: [linkRow()],
    ...overrides,
  };
}

function wordSpace(overrides: Partial<L3WordSpace> = {}): L3WordSpace {
  return {
    word: wordRow(),
    contexts: [contextRow()],
    sources: [sourceRow()],
    occurrences: [occurrenceRow()],
    links: [linkRow()],
    stats: { sourceCount: 1, contextCount: 1, occurrenceCount: 1, linkCount: 1 },
    limit: 50,
    cursor: null,
    nextCursor: null,
    ...overrides,
  };
}

function sourceSpace(overrides: Partial<L3SourceSpace> = {}): L3SourceSpace {
  return {
    source: sourceRow(),
    contexts: [contextRow()],
    occurrences: [occurrenceRow()],
    links: [linkRow()],
    stats: { sourceCount: 1, contextCount: 1, occurrenceCount: 1, linkCount: 1 },
    limit: 50,
    cursor: null,
    nextCursor: null,
    ...overrides,
  };
}

function l3FrontendBoundaryFiles(): string[] {
  const explicitFiles = [
    "src/frontend/App.tsx",
    "src/frontend/api/l3Client.ts",
  ];
  const directories = [
    "src/frontend/components",
    "src/frontend/pages",
    "src/frontend/state",
    "src/frontend/viewModels",
  ];
  const discoveredFiles = directories.flatMap((directory) => (
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
      .map((entry) => `${directory}/${entry.name}`)
  ));
  return [...explicitFiles, ...discoveredFiles].sort();
}
