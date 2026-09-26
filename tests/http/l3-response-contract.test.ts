import { describe, expect, it } from "vitest";
import {
  l3CapabilitiesResponseSchema,
  l3ContextLinkListResponseSchema,
  l3OccurrenceListResponseSchema,
  l3ProposalBundleResponseSchema,
  l3ProposalListResponseSchema,
  l3RecommendationDetailResponseSchema,
  l3RecommendationListResponseSchema,
} from "../../src/http/l3-response-contract";
import { ERROR_CODES } from "../../src/errors/codes";
import { L3_AUTHORING_CAPABILITIES } from "../../src/domain/l3-authoring";
import {
  API_JSON_BODY_MAX_BYTES,
  JSON_MAX_DEPTH,
  JSON_RECORD_MAX_BYTES,
  L3_PROPOSAL_MAX_ITEMS,
  L3_PROPOSAL_PAYLOAD_MAX_BYTES,
  L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES,
} from "../../src/schemas/resource-budget";

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

  it("parses the exact listL3Occurrences cursor page", () => {
    const item = {
      occurrence: {
        id: "occ-1", context_id: "ctx-1", word_id: "word-1", user_id: "user-1",
        surface: "orbits", lemma: "orbit", start_offset: 4, end_offset: 10,
        confidence: 0.9, evidence: { parsed: true }, bound_sense: "沿轨道运行",
        created_at: "2026-07-13T00:00:00.000Z",
      },
      word: { id: "word-1", slug: "orbit", title: "orbit" },
      context: {
        id: "ctx-1", source_id: "src-1", user_id: "user-1", context_type: "sentence",
        text: "The moon orbits the earth.", normalized_text: null, language: "en",
        position: {}, metadata: {},
        created_at: "2026-07-13T00:00:00.000Z", updated_at: "2026-07-13T00:00:00.000Z",
      },
      source: {
        id: "src-1", user_id: "user-1", wordbook_id: null, source_type: "article",
        title: "Astronomy 101", author: null, url: null, language: "en", metadata: {},
        content_text: null, content_hash: null,
        created_at: "2026-07-13T00:00:00.000Z", updated_at: "2026-07-13T00:00:00.000Z",
      },
    };
    const response = { items: [item], limit: 20, cursor: null, nextCursor: "occ-1" };

    expect(l3OccurrenceListResponseSchema.parse(response)).toEqual(response);
    expect(() => l3OccurrenceListResponseSchema.parse({ ...response, next_cursor: response.nextCursor })).toThrow();
    expect(() => l3OccurrenceListResponseSchema.parse({ ...response, items: [{ ...item, word: { ...item.word, slug: 7 } }] })).toThrow();
    const { bound_sense: _boundSense, ...occurrenceMissing } = item.occurrence;
    expect(() => l3OccurrenceListResponseSchema.parse({ ...response, items: [{ ...item, occurrence: occurrenceMissing }] })).toThrow();
  });

  it("parses the exact listL3ContextLinks cursor page", () => {
    const item = {
      link: {
        id: "link-1", user_id: "user-1", context_id: "ctx-1", word_id: "word-1",
        link_type: "supports", target_type: "external", target_id: "https://example.com/a",
        target_ref: {}, confidence: "0.75", provenance: { source: "agent" },
        created_at: "2026-07-13T00:00:00.000Z",
      },
      word: { id: "word-1", slug: "orbit", title: "orbit" },
      context: null,
      source: null,
    };
    const response = { items: [item], limit: 50, cursor: "prev", nextCursor: null };

    expect(l3ContextLinkListResponseSchema.parse(response)).toEqual(response);
    expect(() => l3ContextLinkListResponseSchema.parse({ ...response, items: [{ ...item, link: { ...item.link, link_type: "unknown" } }] })).toThrow();
    expect(() => l3ContextLinkListResponseSchema.parse({ ...response, items: [{ ...item, link: { ...item.link, target_type: "nope" } }] })).toThrow();
  });

  it("parses the exact getL3Capabilities payload and rejects drift", () => {
    // 数字与词表引用单一真源（resource-budget / errors/codes）构造期望值。
    const response = {
      role: "agent" as const,
      access: { read: "all" as const, write: "proposal_only" as const, upgrade: "owner_only" as const },
      // 批次二（ADR-0034 §4）：评卷授权语义段（提交即授权；执行面批次三）。
      grading: { annotationReadScope: "submitted_sheet_drafts" as const, annotationWriteScope: "review_only" as const },
      // 录题授权语义（ADR-0037 决策 8）：单列，不并进 access（录题不是 proposal）。
      authoring: { ...L3_AUTHORING_CAPABILITIES },
      limits: {
        apiJsonBodyMaxBytes: API_JSON_BODY_MAX_BYTES,
        jsonRecordMaxBytes: JSON_RECORD_MAX_BYTES,
        jsonMaxDepth: JSON_MAX_DEPTH,
        proposalMaxItems: L3_PROPOSAL_MAX_ITEMS,
        proposalPayloadMaxBytes: L3_PROPOSAL_PAYLOAD_MAX_BYTES,
        proposalTotalPayloadMaxBytes: L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES,
      },
      errorCodes: [...Object.values(ERROR_CODES)],
    };

    expect(l3CapabilitiesResponseSchema.parse(response)).toEqual(response);
    expect(() => l3CapabilitiesResponseSchema.parse({ ...response, role: "public" })).toThrow();
    expect(() => l3CapabilitiesResponseSchema.parse({ ...response, access: { ...response.access, write: "direct" } })).toThrow();
    expect(() => l3CapabilitiesResponseSchema.parse({ ...response, errorCodes: [...response.errorCodes, "NOT_A_CODE"] })).toThrow();
    const { limits: _limits, ...missingLimits } = response;
    expect(() => l3CapabilitiesResponseSchema.parse(missingLimits)).toThrow();
    const { grading: _grading, ...missingGrading } = response;
    expect(() => l3CapabilitiesResponseSchema.parse(missingGrading)).toThrow();
    const { authoring: _authoring, ...missingAuthoring } = response;
    expect(() => l3CapabilitiesResponseSchema.parse(missingAuthoring)).toThrow();
    // 字面值漂移即拒：agentCanCreate 若被改成 boolean/"active"，闸门口径就变了
    expect(() => l3CapabilitiesResponseSchema.parse({ ...response, authoring: { ...response.authoring, agentCanCreate: "active" } })).toThrow();
  });
});
