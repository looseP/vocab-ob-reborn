import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "@/errors";
import type {
  IL3ContextRepository,
  IL3ProposalRepository,
  IRepositories,
} from "@/repositories/interfaces";
import type {
  L3ContextRow,
  L3ProposalItemRow,
  L3ProposalRow,
  L3SourceRow,
  Json,
  WordbookRow,
  WordRow,
} from "@/domain";
import { L3ProposalService } from "@/services/l3-proposal.service";

const PROPOSAL_ROW: L3ProposalRow = {
  id: "prop-1",
  user_id: "u1",
  wordbook_id: "wb-1",
  source_type: "agent",
  status: "pending",
  title: "Candidate contexts",
  summary: null,
  input_hash: null,
  proposed_by: "agent",
  provenance: {},
  review_note: null,
  confirmed_at: null,
  rejected_at: null,
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
};

const SOURCE_ROW: L3SourceRow = {
  id: "src-1",
  user_id: "u1",
  wordbook_id: "wb-1",
  source_type: "article",
  title: "Essay",
  author: null,
  url: null,
  language: "en",
  metadata: {},
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
};

const CONTEXT_ROW: L3ContextRow = {
  id: "ctx-1",
  source_id: "src-1",
  user_id: "u1",
  context_type: "sentence",
  text: "She gave a vivid account.",
  normalized_text: null,
  language: "en",
  position: {},
  metadata: {},
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
};

const WORD_ROW: WordRow = {
  id: "w1",
  slug: "vivid",
  title: "vivid",
  lemma: "vivid",
  pos: "adj.",
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

const WORDBOOK_ROW: WordbookRow = {
  id: "wb-1",
  user_id: "u1",
  name: "Default",
  is_default: true,
  settings: {},
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
};

function makeItem(
  ordinal: number,
  itemType: L3ProposalItemRow["item_type"],
  payload: Record<string, unknown>,
): L3ProposalItemRow {
  return {
    id: `item-${ordinal}`,
    proposal_id: "prop-1",
    user_id: "u1",
    item_type: itemType,
    ordinal,
    payload: payload as Json,
    status: "pending",
    validation_errors: [],
    active_entity_type: null,
    active_entity_id: null,
    created_at: "2026-07-08T00:00:00Z",
    updated_at: "2026-07-08T00:00:00Z",
  };
}

function proposalItems(): L3ProposalItemRow[] {
  return [
    makeItem(1, "source", { clientRef: "src-a", sourceType: "article", title: "Essay", language: "en" }),
    makeItem(2, "context", { clientRef: "ctx-a", sourceRef: "src-a", contextType: "sentence", text: "She gave a vivid account.", language: "en" }),
    makeItem(3, "occurrence", { contextRef: "ctx-a", slug: "vivid", surface: "vivid", startOffset: 11, endOffset: 16 }),
    makeItem(4, "context_link", { contextRef: "ctx-a", linkType: "illustrates", targetType: "external", targetRef: { url: "https://example.com" } }),
  ];
}

function makeContextRepo(overrides: Partial<IL3ContextRepository> = {}): IL3ContextRepository {
  return {
    createSource: vi.fn(async () => SOURCE_ROW),
    createContext: vi.fn(async () => CONTEXT_ROW),
    createOccurrence: vi.fn(async () => ({
      id: "occ-1",
      context_id: "ctx-1",
      word_id: "w1",
      user_id: "u1",
      surface: "vivid",
      lemma: null,
      start_offset: 11,
      end_offset: 16,
      confidence: null,
      evidence: {},
      created_at: "2026-07-08T00:00:00Z",
    })),
    createContextLink: vi.fn(async () => ({
      id: "link-1",
      user_id: "u1",
      context_id: "ctx-1",
      word_id: null,
      link_type: "illustrates",
      target_type: "external",
      target_id: null,
      target_ref: {},
      confidence: null,
      provenance: {},
      created_at: "2026-07-08T00:00:00Z",
    })),
    createImportJob: vi.fn(),
    updateImportJobStatus: vi.fn(),
    findWordbookByIdForUser: vi.fn(async () => WORDBOOK_ROW),
    findSourceById: vi.fn(async () => SOURCE_ROW),
    findContextById: vi.fn(async () => CONTEXT_ROW),
    findContextWithSourceById: vi.fn(async () => ({ context: CONTEXT_ROW, source: SOURCE_ROW })),
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

function makeProposalRepo(items = proposalItems(), proposal = PROPOSAL_ROW): IL3ProposalRepository {
  return {
    createProposal: vi.fn(async (input) => ({ ...proposal, user_id: input.user_id, wordbook_id: input.wordbook_id ?? null, source_type: input.source_type as never })),
    createProposalItem: vi.fn(async (input) => makeItem(input.ordinal, input.item_type as never, input.payload as never)),
    findProposalByIdForUser: vi.fn(async () => proposal),
    lockProposalByIdForUser: vi.fn(async () => proposal),
    findProposalItems: vi.fn(async () => items),
    getProposalBundle: vi.fn(async () => ({ proposal, items })),
    listProposals: vi.fn(async () => ({ items: [proposal], limit: 10, cursor: null, nextCursor: null })),
    updateProposalItemValidation: vi.fn(async (itemId, userId, errors) => ({
      ...(items.find((item) => item.id === itemId) ?? items[0]),
      validation_errors: errors,
    })),
    markProposalItemConfirmed: vi.fn(async (itemId, userId, activeEntityType, activeEntityId) => ({
      ...(items.find((item) => item.id === itemId) ?? items[0]),
      status: "confirmed" as const,
      active_entity_type: activeEntityType as never,
      active_entity_id: activeEntityId,
    })),
    markProposalItemsRejected: vi.fn(async () => undefined),
    markProposalConfirmed: vi.fn(async () => ({ ...proposal, status: "confirmed" as const, confirmed_at: "2026-07-08T00:00:01Z" })),
    markProposalRejected: vi.fn(async () => ({ ...proposal, status: "rejected" as const, rejected_at: "2026-07-08T00:00:01Z" })),
  };
}

let proposalRepo: IL3ProposalRepository;
let contextRepo: IL3ContextRepository;
let service: L3ProposalService;
let txContextRepo: IL3ContextRepository;
let txProposalRepo: IL3ProposalRepository;

beforeEach(() => {
  proposalRepo = makeProposalRepo();
  contextRepo = makeContextRepo();
  txContextRepo = makeContextRepo();
  txProposalRepo = makeProposalRepo();
  service = new L3ProposalService(
    proposalRepo,
    contextRepo,
    async (cb) => cb({} as never),
    () => ({
      l3Context: txContextRepo,
      l3Proposal: txProposalRepo,
    } as unknown as IRepositories),
  );
});

describe("L3ProposalService", () => {
  it("creates proposal and items without writing active L3 tables", async () => {
    await service.createProposal({
      userId: "u1",
      wordbookId: "wb-1",
      sourceType: "agent",
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    });

    expect(txProposalRepo.createProposal).toHaveBeenCalled();
    expect(txProposalRepo.createProposalItem).toHaveBeenCalled();
    expect(txContextRepo.createSource).not.toHaveBeenCalled();
    expect(txContextRepo.createContext).not.toHaveBeenCalled();
  });

  it("validateProposal catches offset/surface mismatches", async () => {
    const items = proposalItems();
    items[2] = makeItem(3, "occurrence", {
      contextRef: "ctx-a",
      slug: "vivid",
      surface: "VIVID",
      startOffset: 11,
      endOffset: 16,
    });
    proposalRepo = makeProposalRepo(items);
    service = new L3ProposalService(proposalRepo, contextRepo, async (cb) => cb({} as never), () => ({ l3Proposal: txProposalRepo, l3Context: txContextRepo } as unknown as IRepositories));

    const result = await service.validateProposal({ userId: "u1", proposalId: "prop-1" });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "surface")).toBe(true);
    expect(contextRepo.createOccurrence).not.toHaveBeenCalled();
  });

  it("validateProposal catches wordbook-scoped words outside the source wordbook", async () => {
    contextRepo = makeContextRepo({ findWordInWordbookBySlug: vi.fn(async () => null) });
    service = new L3ProposalService(proposalRepo, contextRepo, async (cb) => cb({} as never), () => ({ l3Proposal: txProposalRepo, l3Context: txContextRepo } as unknown as IRepositories));

    const result = await service.validateProposal({ userId: "u1", proposalId: "prop-1" });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "wordId")).toBe(true);
  });

  it("validateProposal catches invalid link targets", async () => {
    const items = proposalItems();
    items[3] = makeItem(4, "context_link", {
      contextRef: "ctx-a",
      linkType: "illustrates",
      targetType: "l2_item",
      targetRef: { field: "corpus" },
    });
    proposalRepo = makeProposalRepo(items);
    service = new L3ProposalService(proposalRepo, contextRepo, async (cb) => cb({} as never), () => ({ l3Proposal: txProposalRepo, l3Context: txContextRepo } as unknown as IRepositories));

    const result = await service.validateProposal({ userId: "u1", proposalId: "prop-1" });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "targetRef")).toBe(true);
  });

  it("confirmProposal writes active source/context/occurrence/link and resolves client refs", async () => {
    const result = await service.confirmProposal({ userId: "u1", proposalId: "prop-1" });

    expect(txContextRepo.createSource).toHaveBeenCalled();
    expect(txContextRepo.createContext).toHaveBeenCalledWith(expect.objectContaining({ source_id: "src-1" }));
    expect(txContextRepo.createOccurrence).toHaveBeenCalledWith(expect.objectContaining({ context_id: "ctx-1" }));
    expect(txContextRepo.createContextLink).toHaveBeenCalledWith(expect.objectContaining({ context_id: "ctx-1" }));
    expect(txProposalRepo.markProposalConfirmed).toHaveBeenCalledWith("prop-1", "u1");
    expect(result.activeEntities).toHaveLength(4);
  });

  it("confirmProposal rejects non-pending proposals", async () => {
    const confirmed = { ...PROPOSAL_ROW, status: "confirmed" as const };
    proposalRepo = makeProposalRepo(proposalItems(), confirmed);
    service = new L3ProposalService(proposalRepo, contextRepo, async (cb) => cb({} as never), () => ({ l3Proposal: txProposalRepo, l3Context: txContextRepo } as unknown as IRepositories));

    await expect(service.confirmProposal({ userId: "u1", proposalId: "prop-1" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("rejectProposal marks proposal rejected without active L3 writes", async () => {
    const result = await service.rejectProposal({ userId: "u1", proposalId: "prop-1", reviewNote: "not enough evidence" });

    expect(txProposalRepo.markProposalItemsRejected).toHaveBeenCalledWith("prop-1", "u1");
    expect(txProposalRepo.markProposalRejected).toHaveBeenCalledWith("prop-1", "u1", "not enough evidence");
    expect(txContextRepo.createSource).not.toHaveBeenCalled();
    expect(result.proposal.status).toBe("rejected");
  });

  it("rejectProposal prevents later confirm", async () => {
    const rejected = { ...PROPOSAL_ROW, status: "rejected" as const };
    proposalRepo = makeProposalRepo(proposalItems(), rejected);
    service = new L3ProposalService(proposalRepo, contextRepo, async (cb) => cb({} as never), () => ({ l3Proposal: txProposalRepo, l3Context: txContextRepo } as unknown as IRepositories));

    await expect(service.confirmProposal({ userId: "u1", proposalId: "prop-1" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("confirmProposal leaves active writes rolled back when a later item fails", async () => {
    let rolledBack = false;
    txContextRepo = makeContextRepo({
      createOccurrence: vi.fn(async () => {
        throw new ValidationError("boom", "occurrence");
      }),
    });
    service = new L3ProposalService(
      proposalRepo,
      contextRepo,
      async (cb) => {
        try {
          return await cb({} as never);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
      () => ({ l3Proposal: txProposalRepo, l3Context: txContextRepo } as unknown as IRepositories),
    );

    await expect(service.confirmProposal({ userId: "u1", proposalId: "prop-1" })).rejects.toBeInstanceOf(ValidationError);
    expect(rolledBack).toBe(true);
    expect(txProposalRepo.markProposalConfirmed).not.toHaveBeenCalled();
  });
});
