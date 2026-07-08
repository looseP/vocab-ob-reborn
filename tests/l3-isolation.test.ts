import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "./helpers/mock-db";

const mock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
}));

import { createRepositories } from "@/index";

beforeEach(() => mock.reset());

describe("L3 isolation", () => {
  it("source/context/occurrence writes do not update L1/L2/FSRS tables or words JSONB", async () => {
    mock.setRows([{ id: "ok" }]);
    const repos = createRepositories();

    await repos.l3Context.createSource({
      user_id: "u1",
      source_type: "manual",
      title: "Manual note",
    });
    await repos.l3Context.createContext({
      user_id: "u1",
      source_id: "src-1",
      context_type: "sentence",
      text: "A vivid context.",
    });
    await repos.l3Context.createOccurrence({
      user_id: "u1",
      context_id: "ctx-1",
      word_id: "w1",
      surface: "vivid",
    });

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("INSERT INTO l3_sources");
    expect(sql).toContain("INSERT INTO l3_contexts");
    expect(sql).toContain("INSERT INTO l3_occurrences");
    expect(sql).not.toContain("word_l2_content");
    expect(sql).not.toContain("user_word_progress");
    expect(sql).not.toContain("user_word_l2_progress");
    expect(sql).not.toContain("content_hash");
    expect(sql).not.toContain("l2_content_hash");
    expect(sql).not.toContain("UPDATE words");
  });

  it("proposal create and reject do not write active L3 or L1/L2 tables", async () => {
    mock.setRowMap({
      "INSERT INTO l3_proposals": [{ id: "prop-1", user_id: "u1", source_type: "agent", status: "pending" }],
      "INSERT INTO l3_proposal_items": [{ id: "item-1", proposal_id: "prop-1", user_id: "u1", item_type: "source", ordinal: 1 }],
      "UPDATE l3_proposal_items": [{ id: "item-1", proposal_id: "prop-1", user_id: "u1", status: "rejected" }],
      "UPDATE l3_proposals": [{ id: "prop-1", user_id: "u1", source_type: "agent", status: "rejected" }],
    });
    const repos = createRepositories();

    await repos.l3Proposal.createProposal({ user_id: "u1", source_type: "agent" });
    await repos.l3Proposal.createProposalItem({
      proposal_id: "prop-1",
      user_id: "u1",
      item_type: "source",
      ordinal: 1,
      payload: { sourceType: "article", title: "Essay" },
    });
    await repos.l3Proposal.markProposalItemsRejected("prop-1", "u1");
    await repos.l3Proposal.markProposalRejected("prop-1", "u1", "no");

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("INSERT INTO l3_proposals");
    expect(sql).toContain("INSERT INTO l3_proposal_items");
    expect(sql).not.toContain("INSERT INTO l3_sources");
    expect(sql).not.toContain("INSERT INTO l3_contexts");
    expect(sql).not.toContain("INSERT INTO l3_occurrences");
    expect(sql).not.toContain("INSERT INTO l3_context_links");
    expect(sql).not.toContain("word_l2_content");
    expect(sql).not.toContain("user_word_progress");
    expect(sql).not.toContain("user_word_l2_progress");
    expect(sql).not.toContain("UPDATE words");
  });

  it("raw and structured import proposal SQL does not write active L3 or L1/L2 tables", async () => {
    mock.setRowMap({
      "SELECT * FROM words WHERE slug": [{ id: "w1", slug: "vivid", is_deleted: false }],
      "INSERT INTO l3_import_jobs": [{ id: "job-1", user_id: "u1", status: "processing", input_hash: "hash" }],
      "UPDATE l3_import_jobs": [{ id: "job-1", user_id: "u1", status: "completed", input_hash: "hash" }],
      "INSERT INTO l3_proposals": [{ id: "prop-1", user_id: "u1", source_type: "import", status: "pending" }],
      "INSERT INTO l3_proposal_items": [{ id: "item-1", proposal_id: "prop-1", user_id: "u1", item_type: "source", ordinal: 1 }],
    });

    const { L3ProposalService } = await import("@/services/l3-proposal.service");
    const { L3ImportService } = await import("@/services/l3-import.service");
    const repos = createRepositories();
    const proposalService = new L3ProposalService(repos.l3Proposal, repos.l3Context);
    const importService = new L3ImportService(repos.l3Context, proposalService);

    await importService.createRawTextImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Note" },
      text: "A vivid account.",
      targetWords: [{ slug: "vivid" }],
    });
    await importService.createStructuredImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Examples" },
      contexts: [{ contextType: "sentence", text: "A vivid account." }],
    });

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("INSERT INTO l3_import_jobs");
    expect(sql).toContain("UPDATE l3_import_jobs");
    expect(sql).toContain("INSERT INTO l3_proposals");
    expect(sql).toContain("INSERT INTO l3_proposal_items");
    expect(sql).not.toContain("INSERT INTO l3_sources");
    expect(sql).not.toContain("INSERT INTO l3_contexts");
    expect(sql).not.toContain("INSERT INTO l3_occurrences");
    expect(sql).not.toContain("INSERT INTO l3_context_links");
    expect(sql).not.toContain("word_l2_content");
    expect(sql).not.toContain("user_word_progress");
    expect(sql).not.toContain("user_word_l2_progress");
    expect(sql).not.toContain("UPDATE words");
  });

  it("Phase 3D read model SQL is read-only and does not touch L1/L2 state", async () => {
    mock.setRows([]);
    const repos = createRepositories();

    await repos.l3Context.getContextDetail("u1", "00000000-0000-4000-8000-000000000001");
    await repos.l3Context.getWordSpace({ userId: "u1", slug: "vivid", limit: 10 });
    await repos.l3Context.getSourceSpace({ userId: "u1", sourceId: "00000000-0000-4000-8000-000000000002", limit: 10 });
    await repos.l3Context.getGraph({ userId: "u1", depth: 1, limit: 10 });

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("SELECT");
    expect(sql).not.toContain("INSERT");
    expect(sql).not.toContain("UPDATE");
    expect(sql).not.toContain("DELETE");
    expect(sql).not.toContain("INSERT INTO l3_import_jobs");
    expect(sql).not.toContain("UPDATE l3_import_jobs");
    expect(sql).not.toContain("INSERT INTO l3_proposals");
    expect(sql).not.toContain("INSERT INTO l3_proposal_items");
    expect(sql).not.toContain("INSERT INTO l3_sources");
    expect(sql).not.toContain("INSERT INTO l3_contexts");
    expect(sql).not.toContain("INSERT INTO l3_occurrences");
    expect(sql).not.toContain("INSERT INTO l3_context_links");
    expect(sql).not.toContain("word_l2_content");
    expect(sql).not.toContain("user_word_progress");
    expect(sql).not.toContain("user_word_l2_progress");
    expect(sql).not.toContain("UPDATE words");
  });

  it("recommendation generation writes only recommendation tables while reading signals", async () => {
    mock.setRowMap({
      "SELECT": [{
        word_id: "w1",
        slug: "vivid",
        title: "vivid",
        due_at: "2026-07-08T00:00:00Z",
        state: "review",
        retrievability: "0.5000",
        l1_weak_signal: true,
        review_count: 1,
        l2_retrievability: null,
        l2_due_at: null,
        l2_review_count: null,
        l2_paused: null,
        l2_fields: [],
        l3_context_count: 0,
        l3_occurrence_count: 0,
        l3_link_count: 0,
        graph_neighbor_count: 0,
      }],
      "INSERT INTO l3_recommendation_runs": [{
        id: "run-1",
        user_id: "u1",
        mode: "review_pack",
        status: "completed",
        stats: {},
        created_at: "2026-07-08T00:00:00Z",
        completed_at: "2026-07-08T00:00:00Z",
      }],
      "INSERT INTO l3_recommendation_items": [{
        id: "rec-1",
        run_id: "run-1",
        user_id: "u1",
        recommendation_type: "review_pack",
        status: "pending",
      }],
    });

    const { L3RecommendationService } = await import("@/services/l3-recommendation.service");
    const repos = createRepositories();
    const service = new L3RecommendationService(repos.l3Recommendation, repos.l3Context);

    await service.generateRecommendations({ userId: "u1", mode: "review_pack" });

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("INSERT INTO l3_recommendation_runs");
    expect(sql).toContain("INSERT INTO l3_recommendation_items");
    expect(sql).toContain("user_word_progress");
    expect(sql).toContain("word_l2_content");
    expect(sql).not.toContain("INSERT INTO l3_sources");
    expect(sql).not.toContain("INSERT INTO l3_contexts");
    expect(sql).not.toContain("INSERT INTO l3_occurrences");
    expect(sql).not.toContain("INSERT INTO l3_context_links");
    expect(sql).not.toContain("UPDATE user_word_progress");
    expect(sql).not.toContain("UPDATE user_word_l2_progress");
    expect(sql).not.toContain("INSERT INTO word_l2_content");
    expect(sql).not.toContain("UPDATE word_l2_content");
    expect(sql).not.toContain("UPDATE words");
  });

  it("recommendation link_gap accept writes proposal bridge only, not active L3", async () => {
    mock.setRowMap({
      "SELECT * FROM l3_recommendation_items": [{
        id: "rec-1",
        run_id: "run-1",
        user_id: "u1",
        wordbook_id: null,
        recommendation_type: "link_gap",
        status: "pending",
        title: "Link gap",
        summary: "Co-occurrence without link",
        priority_score: "80.0000",
        confidence: "0.7000",
        reason_codes: ["cooccurrence_without_link"],
        evidence: [],
        payload: {
          contextId: "00000000-0000-4000-8000-000000000001",
          wordId: "00000000-0000-4000-8000-000000000002",
          targetWordId: "00000000-0000-4000-8000-000000000003",
          targetSlug: "lucid",
          linkType: "collocates_with",
        },
        accepted_proposal_id: null,
        created_at: "2026-07-08T00:00:00Z",
        updated_at: "2026-07-08T00:00:00Z",
        expires_at: null,
        accepted_at: null,
        rejected_at: null,
        dismissed_at: null,
      }],
      "INSERT INTO l3_proposals": [{
        id: "prop-1",
        user_id: "u1",
        source_type: "agent",
        status: "pending",
      }],
      "INSERT INTO l3_proposal_items": [{
        id: "item-1",
        proposal_id: "prop-1",
        user_id: "u1",
        item_type: "context_link",
        ordinal: 1,
        status: "pending",
      }],
      "UPDATE l3_recommendation_items": [{
        id: "rec-1",
        user_id: "u1",
        status: "accepted",
        accepted_proposal_id: "prop-1",
      }],
    });

    const { L3RecommendationService } = await import("@/services/l3-recommendation.service");
    const repos = createRepositories();
    const service = new L3RecommendationService(repos.l3Recommendation, repos.l3Context);

    await service.acceptRecommendation({ userId: "u1", recommendationId: "rec-1" });

    const sql = mock.calls.map((call) => call.text).join("\n");
    expect(sql).toContain("INSERT INTO l3_proposals");
    expect(sql).toContain("INSERT INTO l3_proposal_items");
    expect(sql).toContain("UPDATE l3_recommendation_items");
    expect(sql).not.toContain("INSERT INTO l3_sources");
    expect(sql).not.toContain("INSERT INTO l3_contexts");
    expect(sql).not.toContain("INSERT INTO l3_occurrences");
    expect(sql).not.toContain("INSERT INTO l3_context_links");
    expect(sql).not.toContain("UPDATE user_word_progress");
    expect(sql).not.toContain("UPDATE user_word_l2_progress");
    expect(sql).not.toContain("INSERT INTO word_l2_content");
    expect(sql).not.toContain("UPDATE word_l2_content");
    expect(sql).not.toContain("UPDATE words");
  });
});
