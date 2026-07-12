import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "@/errors";
import type {
  IL3ContextRepository,
  IL3ProposalRepository,
  IL3RecommendationRepository,
  IRepositories,
  L3RecommendationSignal,
} from "@/repositories/interfaces";
import type {
  Json,
  L3ProposalItemRow,
  L3ProposalRow,
  L3RecommendationItemRow,
  L3RecommendationRunRow,
  WordRow,
  WordbookRow,
} from "@/domain";
import { L3RecommendationService } from "@/services/l3-recommendation.service";

const WORDBOOK_ROW: WordbookRow = {
  id: "wb-1",
  user_id: "u1",
  name: "Default",
  description: null,
  is_default: true,
  settings: {},
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
};

const WORD_ROW: WordRow = {
  id: "w1",
  slug: "vivid",
  title: "vivid",
  lemma: "vivid",
  pos: null,
  cefr: null,
  ipa: null,
  aliases: [],
  short_definition: null,
  definition_md: "",
  body_md: "",
  examples: [],
  metadata: {},
  source_path: "words/vivid.md",
  source_updated_at: null,
  content_hash: "a".repeat(64),
  is_published: true,
  is_deleted: false,
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
};

const RUN_ROW: L3RecommendationRunRow = {
  id: "run-1",
  user_id: "u1",
  wordbook_id: "wb-1",
  mode: "review_pack",
  status: "completed",
  input_hash: "hash",
  stats: {},
  created_at: "2026-07-08T00:00:00Z",
  completed_at: "2026-07-08T00:00:00Z",
};

function signal(overrides: Partial<L3RecommendationSignal> = {}): L3RecommendationSignal {
  return {
    word_id: "w1",
    slug: "vivid",
    title: "vivid",
    due_at: "2026-07-08T00:00:00Z",
    state: "review",
    retrievability: "0.4000",
    l1_weak_signal: false,
    review_count: 3,
    l2_retrievability: "0.5000",
    l2_due_at: null,
    l2_review_count: 1,
    l2_paused: false,
    l2_fields: ["corpus"],
    l3_context_count: 1,
    l3_occurrence_count: 2,
    l3_link_count: 0,
    graph_neighbor_count: 1,
    ...overrides,
  };
}

function recItem(overrides: Partial<L3RecommendationItemRow> = {}): L3RecommendationItemRow {
  return {
    id: "rec-1",
    run_id: "run-1",
    user_id: "u1",
    wordbook_id: "wb-1",
    recommendation_type: "review_pack",
    status: "pending",
    title: "Review pack",
    summary: "Due words",
    priority_score: "80.0000",
    confidence: "0.8000",
    reason_codes: ["fsrs_due"],
    evidence: [],
    payload: {},
    accepted_proposal_id: null,
    created_at: "2026-07-08T00:00:00Z",
    updated_at: "2026-07-08T00:00:00Z",
    expires_at: null,
    accepted_at: null,
    rejected_at: null,
    dismissed_at: null,
    ...overrides,
  };
}

function makeContextRepo(overrides: Partial<IL3ContextRepository> = {}): IL3ContextRepository {
  return {
    createSource: vi.fn(),
    createContext: vi.fn(),
    createOccurrence: vi.fn(),
    createContextLink: vi.fn(),
    createImportJob: vi.fn(),
    updateImportJobStatus: vi.fn(),
    findWordbookByIdForUser: vi.fn(async () => WORDBOOK_ROW),
    findSourceById: vi.fn(),
    findContextById: vi.fn(),
    findContextWithSourceById: vi.fn(),
    findWordById: vi.fn(async () => WORD_ROW),
    findWordBySlug: vi.fn(async () => WORD_ROW),
    findWordInWordbookById: vi.fn(async () => WORD_ROW),
    findWordInWordbookBySlug: vi.fn(async () => WORD_ROW),
    listContextsForWord: vi.fn(),
    listContextsForSource: vi.fn(),
    getContextDetail: vi.fn(),
    getWordSpace: vi.fn(),
    getSourceSpace: vi.fn(),
    getGraph: vi.fn(),
    ...overrides,
  } as IL3ContextRepository;
}

function makeRecommendationRepo(overrides: Partial<IL3RecommendationRepository> = {}): IL3RecommendationRepository {
  return {
    createRun: vi.fn(async (input) => ({ ...RUN_ROW, user_id: input.user_id, wordbook_id: input.wordbook_id ?? null, mode: input.mode as never })),
    createItem: vi.fn(async (input) => recItem({
      run_id: input.run_id,
      user_id: input.user_id,
      wordbook_id: input.wordbook_id ?? null,
      recommendation_type: input.recommendation_type as never,
      title: input.title,
      summary: input.summary,
      priority_score: input.priority_score,
      confidence: input.confidence,
      reason_codes: input.reason_codes,
      evidence: input.evidence,
      payload: input.payload,
    })),
    listItems: vi.fn(async () => ({ items: [recItem()], limit: 20, cursor: null, nextCursor: null })),
    findItemByIdForUser: vi.fn(async () => recItem()),
    lockItemByIdForUser: vi.fn(async () => recItem()),
    markItemStatus: vi.fn(async (itemId, userId, status, acceptedProposalId) => recItem({ id: itemId, user_id: userId, status: status as never, accepted_proposal_id: acceptedProposalId ?? null })),
    findSignals: vi.fn(async () => [signal({ l1_weak_signal: true }), signal({ word_id: "w2", slug: "lucid", due_at: null, state: null })]),
    findLinkGapCandidates: vi.fn(async () => [{
      context_id: "ctx-1",
      source_id: "src-1",
      word_id: "w1",
      word_slug: "vivid",
      target_word_id: "w2",
      target_word_slug: "lucid",
      cooccurrence_count: 2,
    }]),
    ...overrides,
  };
}

function makeProposalRepo(): IL3ProposalRepository {
  return {
    createProposal: vi.fn(async (input): Promise<L3ProposalRow> => ({
      id: "prop-1",
      user_id: input.user_id,
      wordbook_id: input.wordbook_id ?? null,
      source_type: input.source_type as never,
      status: "pending",
      title: input.title ?? null,
      summary: input.summary ?? null,
      input_hash: input.input_hash ?? null,
      proposed_by: input.proposed_by ?? null,
      provenance: input.provenance ?? {},
      review_note: null,
      confirmed_at: null,
      rejected_at: null,
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z",
    })),
    createProposalItem: vi.fn(async (input): Promise<L3ProposalItemRow> => ({
      id: "item-1",
      proposal_id: input.proposal_id,
      user_id: input.user_id,
      item_type: input.item_type as never,
      ordinal: input.ordinal,
      payload: input.payload,
      status: "pending",
      validation_errors: [],
      active_entity_type: null,
      active_entity_id: null,
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z",
    })),
    findProposalByIdForUser: vi.fn(),
    findProposalByInputHash: vi.fn(async () => null),
    lockProposalByIdForUser: vi.fn(),
    findProposalItems: vi.fn(),
    getProposalBundle: vi.fn(),
    listProposals: vi.fn(),
    updateProposalItemValidation: vi.fn(),
    markProposalItemConfirmed: vi.fn(),
    markProposalItemsRejected: vi.fn(),
    markProposalConfirmed: vi.fn(),
    markProposalRejected: vi.fn(),
  };
}

let recommendationRepo: IL3RecommendationRepository;
let contextRepo: IL3ContextRepository;
let proposalRepo: IL3ProposalRepository;
let service: L3RecommendationService;

beforeEach(() => {
  recommendationRepo = makeRecommendationRepo();
  contextRepo = makeContextRepo();
  proposalRepo = makeProposalRepo();
  service = new L3RecommendationService(
    recommendationRepo,
    contextRepo,
    async (cb) => cb({} as never),
    () => ({
      l3Recommendation: recommendationRepo,
      l3Context: contextRepo,
      l3Proposal: proposalRepo,
    } as unknown as IRepositories),
  );
});

describe("L3RecommendationService", () => {
  it("generates deterministic review_pack recommendations with evidence", async () => {
    const result = await service.generateRecommendations({ userId: "u1", wordbookId: "wb-1", mode: "review_pack", limit: 5 });

    expect(contextRepo.findWordbookByIdForUser).toHaveBeenCalledWith("u1", "wb-1");
    expect(recommendationRepo.findSignals).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", wordbookId: "wb-1", horizonDays: 7, limit: 5 }));
    expect(recommendationRepo.createRun).toHaveBeenCalled();
    expect(recommendationRepo.createItem).toHaveBeenCalledWith(expect.objectContaining({
      recommendation_type: "review_pack",
      reason_codes: expect.arrayContaining(["fsrs_due", "fsrs_weak"]),
    }));
    expect(result.items[0].evidence as Json[]).not.toHaveLength(0);
  });

  it("generates learn_next recommendations using graph evidence", async () => {
    const result = await service.generateRecommendations({ userId: "u1", mode: "learn_next", seedSlug: "vivid" });

    expect(contextRepo.findWordBySlug).toHaveBeenCalledWith("vivid");
    expect(result.items.some((item) => item.recommendation_type === "learn_next")).toBe(true);
    expect(JSON.stringify(result.items)).toContain("graph_edge");
  });

  it("generates link_gap recommendations without active link writes", async () => {
    const result = await service.generateRecommendations({ userId: "u1", mode: "link_suggestions" });

    expect(recommendationRepo.findLinkGapCandidates).toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({ recommendation_type: "link_gap", status: "pending" });
    expect(contextRepo.createContextLink).not.toHaveBeenCalled();
  });

  it("dryRun returns candidates without creating run or items", async () => {
    const result = await service.generateRecommendations({ userId: "u1", mode: "gap_scan", dryRun: true });

    expect(result.run.id).toBe("dry-run");
    expect(recommendationRepo.createRun).not.toHaveBeenCalled();
    expect(recommendationRepo.createItem).not.toHaveBeenCalled();
  });

  it("rejects missing wordbook before signal reads", async () => {
    contextRepo = makeContextRepo({ findWordbookByIdForUser: vi.fn(async () => null) });
    service = new L3RecommendationService(recommendationRepo, contextRepo);

    await expect(service.generateRecommendations({ userId: "u1", wordbookId: "foreign", mode: "review_pack" })).rejects.toBeInstanceOf(NotFoundError);
    expect(recommendationRepo.findSignals).not.toHaveBeenCalled();
  });

  it("accepts link_gap by creating a proposal bridge only", async () => {
    recommendationRepo = makeRecommendationRepo({
      lockItemByIdForUser: vi.fn(async () => recItem({
        recommendation_type: "link_gap",
        payload: { contextId: "ctx-1", wordId: "w1", targetWordId: "w2", targetSlug: "lucid", linkType: "collocates_with" },
      })),
    });
    service = new L3RecommendationService(
      recommendationRepo,
      contextRepo,
      async (cb) => cb({} as never),
      () => ({
        l3Recommendation: recommendationRepo,
        l3Context: contextRepo,
        l3Proposal: proposalRepo,
      } as unknown as IRepositories),
    );

    const result = await service.acceptRecommendation({ userId: "u1", recommendationId: "rec-1" });

    expect(proposalRepo.createProposal).toHaveBeenCalledWith(expect.objectContaining({ source_type: "agent", proposed_by: "l3_recommendation_builder" }));
    expect(proposalRepo.createProposalItem).toHaveBeenCalledWith(expect.objectContaining({ item_type: "context_link" }));
    expect(contextRepo.createContextLink).not.toHaveBeenCalled();
    expect(result.proposal?.proposal.id).toBe("prop-1");
  });

  it("accepts context/l2 gaps as future action payloads only", async () => {
    recommendationRepo = makeRecommendationRepo({
      lockItemByIdForUser: vi.fn(async () => recItem({ recommendation_type: "context_gap", payload: { suggestedAction: "import_or_search_context" } })),
    });
    service = new L3RecommendationService(
      recommendationRepo,
      contextRepo,
      async (cb) => cb({} as never),
      () => ({ l3Recommendation: recommendationRepo, l3Context: contextRepo, l3Proposal: proposalRepo } as unknown as IRepositories),
    );

    const result = await service.acceptRecommendation({ userId: "u1", recommendationId: "rec-1" });

    expect(proposalRepo.createProposal).not.toHaveBeenCalled();
    expect(result.actionPayload).toMatchObject({ action: "future_consumer" });
  });

  it("rejects non-pending accept/reject transitions", async () => {
    recommendationRepo = makeRecommendationRepo({
      lockItemByIdForUser: vi.fn(async () => recItem({ status: "accepted" })),
    });
    service = new L3RecommendationService(
      recommendationRepo,
      contextRepo,
      async (cb) => cb({} as never),
      () => ({ l3Recommendation: recommendationRepo, l3Context: contextRepo, l3Proposal: proposalRepo } as unknown as IRepositories),
    );

    await expect(service.acceptRecommendation({ userId: "u1", recommendationId: "rec-1" })).rejects.toBeInstanceOf(ConflictError);
    await expect(service.rejectRecommendation({ userId: "u1", recommendationId: "rec-1" })).rejects.toBeInstanceOf(ConflictError);
  });
});
