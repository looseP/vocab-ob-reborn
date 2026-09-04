import { describe, expect, it } from "vitest";
import {
  l3ProposalBundleResponseSchema,
  l3ProposalListResponseSchema,
  l3RecommendationDetailResponseSchema,
  l3RecommendationListResponseSchema,
} from "../../src/http/l3-response-contract";

const proposal = {
  id: "proposal-1",
  user_id: "user-1",
  wordbook_id: null,
  source_type: "import" as const,
  status: "pending" as const,
  title: null,
  summary: "Imported contexts",
  input_hash: null,
  proposed_by: "importer",
  provenance: { source: "upload", nested: [1, "two", true, null, { deep: "value" }] },
  review_note: null,
  confirmed_at: null,
  rejected_at: null,
  created_at: "2026-07-13T00:00:00.000Z",
  updated_at: "2026-07-13T00:00:00.000Z",
};

const proposalItem = {
  id: "item-1",
  proposal_id: proposal.id,
  user_id: proposal.user_id,
  item_type: "context" as const,
  ordinal: 0,
  payload: { text: "Recursive JSON", tags: ["contract", 2, null] },
  status: "pending" as const,
  validation_errors: [],
  active_entity_type: null,
  active_entity_id: null,
  created_at: proposal.created_at,
  updated_at: proposal.updated_at,
};

function recommendation() {
  return {
    id: "recommendation-1",
    run_id: "run-1",
    user_id: "user-1",
    wordbook_id: null,
    recommendation_type: "weak_word" as const,
    status: "pending" as const,
    title: "Review orbit",
    summary: "Due soon",
    priority_score: "0.95",
    confidence: 0.8,
    reason_codes: ["fsrs_due", { rank: 1 }],
    evidence: [{ type: "fsrs_due", ref: { card_id: "card-1" }, weight: 1 }],
    payload: { slug: "orbit", details: { due: true } },
    accepted_proposal_id: null,
    created_at: "2026-07-13T00:00:00.000Z",
    updated_at: "2026-07-13T00:00:00.000Z",
    expires_at: null,
    accepted_at: null,
    rejected_at: null,
    dismissed_at: null,
  };
}

describe("L3 response contracts", () => {
  it("parses the exact listL3Proposals cursor page", () => {
    const response = { items: [proposal], limit: 20, cursor: null, nextCursor: "proposal-1" };

    expect(l3ProposalListResponseSchema.parse(response)).toEqual(response);
    expect(() => l3ProposalListResponseSchema.parse({ ...response, next_cursor: response.nextCursor })).toThrow();
    expect(() => l3ProposalListResponseSchema.parse({ ...response, limit: 0 })).toThrow();
    expect(() => l3ProposalListResponseSchema.parse({ ...response, limit: 1.5 })).toThrow();
    expect(() => l3ProposalListResponseSchema.parse({ ...response, items: [{ ...proposal, status: "unknown" }] })).toThrow();
    const { title: _title, ...missingTitle } = proposal;
    expect(() => l3ProposalListResponseSchema.parse({ ...response, items: [missingTitle] })).toThrow();
  });

  it("parses the exact getL3Proposal bundle", () => {
    const response = { proposal, items: [proposalItem] };

    expect(l3ProposalBundleResponseSchema.parse(response)).toEqual(response);
    expect(() => l3ProposalBundleResponseSchema.parse({ ...response, proposal_items: response.items })).toThrow();
    expect(() => l3ProposalBundleResponseSchema.parse({ ...response, items: [{ ...proposalItem, ordinal: -1 }] })).toThrow();
    expect(() => l3ProposalBundleResponseSchema.parse({ ...response, items: [{ ...proposalItem, ordinal: 0.5 }] })).toThrow();
  });

  it("parses the exact listL3Recommendations cursor page", () => {
    const item = recommendation();
    const response = { items: [item], limit: 10, cursor: "previous", nextCursor: null };

    expect(l3RecommendationListResponseSchema.parse(response)).toEqual(response);
    expect(() => l3RecommendationListResponseSchema.parse({ ...response, next_cursor: null })).toThrow();
    expect(() => l3RecommendationListResponseSchema.parse({ ...response, items: [{ ...item, recommendation_type: "unknown" }] })).toThrow();
  });

  it("parses the exact getL3Recommendation item", () => {
    const response = recommendation();

    expect(l3RecommendationDetailResponseSchema.parse(response)).toEqual(response);
    expect(l3RecommendationDetailResponseSchema.parse({ ...response, priority_score: 0.95 })).toMatchObject({ priority_score: 0.95 });
    expect(() => l3RecommendationDetailResponseSchema.parse({ ...response, priorityScore: response.priority_score })).toThrow();
    expect(() => l3RecommendationDetailResponseSchema.parse({ ...response, status: "unknown" })).toThrow();
    const { payload: _payload, ...missingPayload } = response;
    expect(() => l3RecommendationDetailResponseSchema.parse(missingPayload)).toThrow();
  });
});
