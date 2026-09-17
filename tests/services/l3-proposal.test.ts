import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@/errors";
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

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async () => {
    throw new Error("default L3 transaction should not be used by proposal confirm");
  }),
}));

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
  content_text: null,
  content_hash: null,
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
      prototype_text: null,
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
  description: null,
  is_default: true,
  settings: {},
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
};

const TARGET_SOURCE_ID = "00000000-0000-4000-8000-000000000201";
const TARGET_CONTEXT_ID = "00000000-0000-4000-8000-000000000202";

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
    lockActiveL3TargetReference: vi.fn(async () => undefined),
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

function makeProposalRepo(
  items = proposalItems(),
  proposal = PROPOSAL_ROW,
  overrides: Partial<IL3ProposalRepository> = {},
): IL3ProposalRepository {
  return {
    createProposal: vi.fn(async (input) => ({ ...proposal, user_id: input.user_id, wordbook_id: input.wordbook_id ?? null, source_type: input.source_type as never })),
    createProposalItem: vi.fn(async (input) => makeItem(input.ordinal, input.item_type as never, input.payload as never)),
    findProposalByIdForUser: vi.fn(async () => proposal),
    findProposalByInputHash: vi.fn(async () => null),
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
    ...overrides,
  } as IL3ProposalRepository;
}

/** ADR-0029 §7 幂等用例：以 overrides 重建 tx 侧 proposal repo 并据此重建 service。 */
function useTxProposalRepo(overrides: Partial<IL3ProposalRepository>): void {
  txProposalRepo = makeProposalRepo(proposalItems(), PROPOSAL_ROW, overrides);
  service = new L3ProposalService(
    proposalRepo,
    contextRepo,
    txRunner,
    () => ({ l3Context: txContextRepo, l3Proposal: txProposalRepo } as unknown as IRepositories),
  );
}

let proposalRepo: IL3ProposalRepository;
let contextRepo: IL3ContextRepository;
let service: L3ProposalService;
let txContextRepo: IL3ContextRepository;
let txProposalRepo: IL3ProposalRepository;
let txRunner: typeof import("@/db/transaction").withTransaction;

beforeEach(() => {
  proposalRepo = makeProposalRepo();
  contextRepo = makeContextRepo();
  txContextRepo = makeContextRepo();
  txProposalRepo = makeProposalRepo();
  txRunner = vi.fn(async <T>(callback: (tx: never) => Promise<T>): Promise<T> => callback({} as never)) as unknown as typeof import("@/db/transaction").withTransaction;
  service = new L3ProposalService(
    proposalRepo,
    contextRepo,
    txRunner,
    () => ({
      l3Context: txContextRepo,
      l3Proposal: txProposalRepo,
    } as unknown as IRepositories),
  );
});

describe("L3ProposalService", () => {
  it("reads proposal lists through the authenticated actor transaction", async () => {
    await service.listProposals({ userId: "u1", limit: 10, cursor: null });

    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(txProposalRepo.listProposals).toHaveBeenCalledWith({ userId: "u1", limit: 10, cursor: null });
    expect(proposalRepo.listProposals).not.toHaveBeenCalled();
  });

  it("reads proposal details through the authenticated actor transaction", async () => {
    await service.getProposal({ userId: "u1", proposalId: "prop-1" });

    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(txProposalRepo.getProposalBundle).toHaveBeenCalledWith("u1", "prop-1");
    expect(proposalRepo.getProposalBundle).not.toHaveBeenCalled();
  });

  it("creates proposal and items without writing active L3 tables", async () => {
    await service.createProposal({
      userId: "u1",
      wordbookId: "wb-1",
      sourceType: "agent",
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    });

    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(txContextRepo.findWordbookByIdForUser).toHaveBeenCalledWith("u1", "wb-1");
    expect(contextRepo.findWordbookByIdForUser).not.toHaveBeenCalled();
    expect(txProposalRepo.createProposal).toHaveBeenCalled();
    expect(txProposalRepo.createProposalItem).toHaveBeenCalled();
    expect(txContextRepo.createSource).not.toHaveBeenCalled();
    expect(txContextRepo.createContext).not.toHaveBeenCalled();
  });

  it("rejects proposal resource amplification at the service boundary", async () => {
    await expect(service.createProposal({
      userId: "u1",
      sourceType: "agent",
      items: Array.from({ length: 1_001 }, (_, index) => ({
        itemType: "source" as const,
        clientRef: `source-${index}`,
        payload: { sourceType: "article", title: "Essay" },
      })),
    })).rejects.toMatchObject({ field: "items" });

    await expect(service.createProposal({
      userId: "u1",
      sourceType: "agent",
      items: [{
        itemType: "source",
        payload: { sourceType: "article", title: "x".repeat(300_000) },
      }],
    })).rejects.toMatchObject({ field: "payload" });

    expect(txProposalRepo.createProposal).not.toHaveBeenCalled();
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
    txProposalRepo = makeProposalRepo(items);
    service = new L3ProposalService(proposalRepo, contextRepo, async (cb) => cb({} as never), () => ({ l3Proposal: txProposalRepo, l3Context: txContextRepo } as unknown as IRepositories));

    const result = await service.validateProposal({ userId: "u1", proposalId: "prop-1" });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "surface")).toBe(true);
    expect(contextRepo.createOccurrence).not.toHaveBeenCalled();
  });

  it("validateProposal catches wordbook-scoped words outside the source wordbook", async () => {
    txContextRepo = makeContextRepo({ findWordInWordbookBySlug: vi.fn(async () => null) });
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
    txProposalRepo = makeProposalRepo(items);
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

  it("confirmProposal keeps source/context-target context links inside the proposal transaction", async () => {
    const items = proposalItems();
    items[3] = makeItem(4, "context_link", {
      contextRef: "ctx-a",
      linkType: "illustrates",
      targetType: "source",
      targetId: TARGET_SOURCE_ID,
    });
    items.push(makeItem(5, "context_link", {
      contextRef: "ctx-a",
      linkType: "illustrates",
      targetType: "context",
      targetId: TARGET_CONTEXT_ID,
    }));
    proposalRepo = makeProposalRepo(items);
    txProposalRepo = makeProposalRepo(items);
    contextRepo = makeContextRepo({
      lockActiveL3TargetReference: vi.fn(async () => {
        throw new Error("outer context repo should not lock context-link soft targets");
      }),
      createContextLink: vi.fn(async () => {
        throw new Error("outer context repo should not create active context links");
      }),
    });
    txContextRepo = makeContextRepo({
      findSourceById: vi.fn(async (userId, sourceId) => ({
        ...SOURCE_ROW,
        id: sourceId,
        user_id: userId,
      })),
      findContextById: vi.fn(async (userId, contextId) => ({
        ...CONTEXT_ROW,
        id: contextId,
        user_id: userId,
      })),
      createContextLink: vi.fn(async (input) => ({
        id: `link-${input.target_type}`,
        user_id: input.user_id,
        context_id: input.context_id ?? null,
        word_id: input.word_id ?? null,
        link_type: input.link_type as never,
        target_type: input.target_type as never,
        target_id: input.target_id ?? null,
        target_ref: input.target_ref ?? {},
        confidence: input.confidence ?? null,
        provenance: input.provenance ?? {},
        created_at: "2026-07-08T00:00:00Z",
      })),
    });
    service = new L3ProposalService(
      proposalRepo,
      contextRepo,
      async (cb) => cb({} as never),
      () => ({
        l3Context: txContextRepo,
        l3Proposal: txProposalRepo,
      } as unknown as IRepositories),
    );

    await service.confirmProposal({ userId: "u1", proposalId: "prop-1" });

    expect(txContextRepo.lockActiveL3TargetReference).toHaveBeenNthCalledWith(1, "u1", "source", TARGET_SOURCE_ID);
    expect(txContextRepo.lockActiveL3TargetReference).toHaveBeenNthCalledWith(2, "u1", "context", TARGET_CONTEXT_ID);
    expect(txContextRepo.createContextLink).toHaveBeenCalledWith(expect.objectContaining({
      context_id: "ctx-1",
      target_type: "source",
      target_id: TARGET_SOURCE_ID,
    }));
    expect(txContextRepo.createContextLink).toHaveBeenCalledWith(expect.objectContaining({
      context_id: "ctx-1",
      target_type: "context",
      target_id: TARGET_CONTEXT_ID,
    }));
    expect(contextRepo.lockActiveL3TargetReference).not.toHaveBeenCalled();
    expect(contextRepo.createContextLink).not.toHaveBeenCalled();
  });

  it("confirmProposal rolls back source-target context links with later proposal failures", async () => {
    let rolledBack = false;
    const items = proposalItems();
    items[3] = makeItem(4, "context_link", {
      contextRef: "ctx-a",
      linkType: "illustrates",
      targetType: "source",
      targetId: TARGET_SOURCE_ID,
    });
    proposalRepo = makeProposalRepo(items);
    txProposalRepo = {
      ...makeProposalRepo(items),
      markProposalConfirmed: vi.fn(async () => {
        throw new ValidationError("boom", "proposal");
      }),
    };
    contextRepo = makeContextRepo({
      createContextLink: vi.fn(async () => {
        throw new Error("outer context repo should not create active context links");
      }),
    });
    txContextRepo = makeContextRepo({
      findSourceById: vi.fn(async (userId, sourceId) => ({
        ...SOURCE_ROW,
        id: sourceId,
        user_id: userId,
      })),
      createContextLink: vi.fn(async (input) => ({
        id: "link-source",
        user_id: input.user_id,
        context_id: input.context_id ?? null,
        word_id: input.word_id ?? null,
        link_type: input.link_type as never,
        target_type: input.target_type as never,
        target_id: input.target_id ?? null,
        target_ref: input.target_ref ?? {},
        confidence: input.confidence ?? null,
        provenance: input.provenance ?? {},
        created_at: "2026-07-08T00:00:00Z",
      })),
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
      () => ({
        l3Context: txContextRepo,
        l3Proposal: txProposalRepo,
      } as unknown as IRepositories),
    );

    await expect(service.confirmProposal({ userId: "u1", proposalId: "prop-1" })).rejects.toBeInstanceOf(ValidationError);

    expect(rolledBack).toBe(true);
    expect(txContextRepo.lockActiveL3TargetReference).toHaveBeenCalledWith("u1", "source", TARGET_SOURCE_ID);
    expect(txContextRepo.createContextLink).toHaveBeenCalledWith(expect.objectContaining({
      target_type: "source",
      target_id: TARGET_SOURCE_ID,
    }));
    expect(contextRepo.createContextLink).not.toHaveBeenCalled();
  });

  it("confirmProposal rejects non-pending proposals", async () => {
    const confirmed = { ...PROPOSAL_ROW, status: "confirmed" as const };
    txProposalRepo = makeProposalRepo(proposalItems(), confirmed);
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
    txProposalRepo = makeProposalRepo(proposalItems(), rejected);
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

  // ── ADR-0029 §7：createProposal 幂等（input_hash 命中即返回既有 bundle，不重复插入） ──

  it("returns the existing bundle without a duplicate insert when input_hash already exists", async () => {
    const existing: L3ProposalRow = { ...PROPOSAL_ROW, id: "prop-existing", input_hash: "hash-locked" };
    useTxProposalRepo({
      findProposalByInputHash: vi.fn(async () => existing),
      getProposalBundle: vi.fn(async () => ({ proposal: existing, items: [] })),
    });

    const result = await service.createProposal({
      userId: "u1",
      sourceType: "agent",
      inputHash: "hash-locked",
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    });

    expect(result.proposal.id).toBe("prop-existing");
    expect(txProposalRepo.findProposalByInputHash).toHaveBeenCalledWith("u1", "hash-locked");
    expect(txProposalRepo.createProposal).not.toHaveBeenCalled();
    expect(txProposalRepo.createProposalItem).not.toHaveBeenCalled();
  });

  it("creates on first sight of an input_hash and passes it through to storage", async () => {
    await service.createProposal({
      userId: "u1",
      sourceType: "agent",
      inputHash: "hash-fresh",
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    });

    expect(txProposalRepo.findProposalByInputHash).toHaveBeenCalledWith("u1", "hash-fresh");
    expect(txProposalRepo.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({ input_hash: "hash-fresh" }),
    );
  });

  it("recovers a unique-violation race by re-reading the existing bundle", async () => {
    const existing: L3ProposalRow = { ...PROPOSAL_ROW, id: "prop-raced", input_hash: "hash-race" };
    useTxProposalRepo({
      findProposalByInputHash: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existing),
      getProposalBundle: vi.fn(async () => ({ proposal: existing, items: [] })),
      createProposal: vi.fn(async () => {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
      }),
    });

    const result = await service.createProposal({
      userId: "u1",
      sourceType: "agent",
      inputHash: "hash-race",
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    });

    expect(result.proposal.id).toBe("prop-raced");
    expect(txProposalRepo.findProposalByInputHash).toHaveBeenCalledTimes(2);
  });

  it("rethrows a 23505 collision that cannot be re-read", async () => {
    useTxProposalRepo({
      createProposal: vi.fn(async () => {
        throw Object.assign(new Error("duplicate key value"), { code: "23505" });
      }),
    });

    await expect(service.createProposal({
      userId: "u1",
      sourceType: "agent",
      inputHash: "hash-lost",
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    })).rejects.toThrow("duplicate key value");
    expect(txProposalRepo.findProposalByInputHash).toHaveBeenCalledTimes(2);
  });

  it("skips the dedup lookup when no input_hash is given", async () => {
    await service.createProposal({
      userId: "u1",
      sourceType: "agent",
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    });

    expect(txProposalRepo.findProposalByInputHash).not.toHaveBeenCalled();
    expect(txProposalRepo.createProposal).toHaveBeenCalled();
  });

  it("does not swallow unrelated creation errors", async () => {
    useTxProposalRepo({
      createProposal: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await expect(service.createProposal({
      userId: "u1",
      sourceType: "agent",
      inputHash: "hash-boom",
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    })).rejects.toThrow("boom");
    expect(txProposalRepo.findProposalByInputHash).toHaveBeenCalledTimes(1);
  });

  it("passes provenance through to storage verbatim", async () => {
    await service.createProposal({
      userId: "u1",
      sourceType: "agent",
      provenance: { agentId: "probe-agent", note: "from-route" },
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    });

    expect(txProposalRepo.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: { agentId: "probe-agent", note: "from-route" } }),
    );
  });

  // ── ADR-0029 §5：服务端身份锚合并（agentId 非空才注入，且覆盖客户端自述） ──

  it("stamps the server-asserted agentId over a self-declared provenance.agentId", async () => {
    await service.createProposal({
      userId: "u1",
      sourceType: "agent",
      agentId: "server-asserted",
      provenance: { agentId: "self-declared-lie", note: "from-agent" },
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    });

    expect(txProposalRepo.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: { agentId: "server-asserted", note: "from-agent" } }),
    );
  });

  it("injects the server-asserted agentId when provenance carries none", async () => {
    await service.createProposal({
      userId: "u1",
      sourceType: "agent",
      agentId: "server-asserted",
      provenance: { note: "from-agent" },
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    });

    expect(txProposalRepo.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: { agentId: "server-asserted", note: "from-agent" } }),
    );
  });

  it("leaves provenance untouched when no server agentId is present (owner/import)", async () => {
    await service.createProposal({
      userId: "u1",
      sourceType: "agent",
      agentId: null,
      provenance: { agentId: "self-declared-lie", note: "from-owner" },
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    });

    expect(txProposalRepo.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({ provenance: { agentId: "self-declared-lie", note: "from-owner" } }),
    );
  });

  // ── 边界校验/窄分支护栏（维持 l3-proposal.service.ts 逐文件 85/75 义务） ──

  it("rejects malformed create inputs across the validation boundary", async () => {
    const goodItem = { itemType: "source" as const, clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } };
    await expect(service.createProposal({ userId: "   ", sourceType: "agent", items: [goodItem] }))
      .rejects.toMatchObject({ field: "userId" });
    await expect(service.createProposal({ userId: "u1", sourceType: "bogus" as never, items: [goodItem] }))
      .rejects.toMatchObject({ field: "sourceType" });
    await expect(service.createProposal({ userId: "u1", sourceType: "agent", items: [] }))
      .rejects.toMatchObject({ field: "items" });
    await expect(service.createProposal({
      userId: "u1",
      sourceType: "agent",
      items: [{ itemType: "source", clientRef: null, payload: "not-an-object" as never }],
    })).rejects.toMatchObject({ field: "payload" });
    await expect(service.createProposal({
      userId: "u1",
      sourceType: "agent",
      items: Array.from({ length: 5 }, (_, i) => ({ itemType: "source" as const, clientRef: `s-${i}`, payload: { blob: "x".repeat(250_000) } })),
    })).rejects.toMatchObject({ field: "items" });
    expect(txProposalRepo.createProposal).not.toHaveBeenCalled();
  });

  it("rejects when the target wordbook does not exist", async () => {
    txContextRepo = makeContextRepo({ findWordbookByIdForUser: vi.fn(async () => null) });
    service = new L3ProposalService(proposalRepo, contextRepo, txRunner, () => ({ l3Context: txContextRepo, l3Proposal: txProposalRepo } as unknown as IRepositories));

    await expect(service.createProposal({
      userId: "u1",
      wordbookId: "wb-missing",
      sourceType: "agent",
      items: [{ itemType: "source", clientRef: "src-a", payload: { sourceType: "article", title: "Essay" } }],
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects an invalid status filter on listProposals", async () => {
    await expect(service.listProposals({ userId: "u1", status: "bogus" as never, limit: 10, cursor: null }))
      .rejects.toMatchObject({ field: "status" });
  });

  it("maps a missing proposal bundle to NotFoundError on getProposal", async () => {
    txProposalRepo = makeProposalRepo(proposalItems(), PROPOSAL_ROW, {
      getProposalBundle: vi.fn(async () => null),
    });
    service = new L3ProposalService(proposalRepo, contextRepo, txRunner, () => ({ l3Context: txContextRepo, l3Proposal: txProposalRepo } as unknown as IRepositories));

    await expect(service.getProposal({ userId: "u1", proposalId: "prop-1" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports invalid link targets for missing and malformed target ids", async () => {
    const cases = [
      { contextRef: "ctx-a", linkType: "illustrates", targetType: "word" },
      { contextRef: "ctx-a", linkType: "illustrates", targetType: "word", targetId: "not-a-uuid" },
      { contextRef: "ctx-a", linkType: "illustrates", targetType: "l2_item", targetRef: "not-an-object" },
    ] as const;
    for (const [index, payload] of cases.entries()) {
      const items = proposalItems();
      items[3] = makeItem(4, "context_link", payload as unknown as Record<string, unknown>);
      txProposalRepo = makeProposalRepo(items);
      service = new L3ProposalService(proposalRepo, contextRepo, txRunner, () => ({ l3Context: txContextRepo, l3Proposal: txProposalRepo } as unknown as IRepositories));

      const result = await service.validateProposal({ userId: "u1", proposalId: "prop-1" });
      expect(result.valid, `case ${index}`).toBe(false);
      expect(result.errors.some((error) => error.field === "targetId" || error.field === "targetRef"), `case ${index}`).toBe(true);
    }
  });

  it("accepts l2_item soft target refs via contentId, hash, or sourceRef", async () => {
    const refs = [
      { field: "corpus", contentId: "c-1" },
      { field: "corpus", hash: "abc" },
      { field: "corpus", sourceRef: "src-x" },
    ];
    for (const [index, targetRef] of refs.entries()) {
      const items = proposalItems();
      items[3] = makeItem(4, "context_link", { contextRef: "ctx-a", linkType: "illustrates", targetType: "l2_item", targetRef });
      txProposalRepo = makeProposalRepo(items);
      service = new L3ProposalService(proposalRepo, contextRepo, txRunner, () => ({ l3Context: txContextRepo, l3Proposal: txProposalRepo } as unknown as IRepositories));

      const result = await service.validateProposal({ userId: "u1", proposalId: "prop-1" });
      expect(result.valid, `ref ${index}`).toBe(true);
    }
  });

  it("rejects confirming when the locked proposal is missing or no longer pending", async () => {
    txProposalRepo = makeProposalRepo(proposalItems(), PROPOSAL_ROW, {
      lockProposalByIdForUser: vi.fn(async () => null),
    });
    service = new L3ProposalService(proposalRepo, contextRepo, txRunner, () => ({ l3Context: txContextRepo, l3Proposal: txProposalRepo } as unknown as IRepositories));
    await expect(service.confirmProposal({ userId: "u1", proposalId: "prop-1" })).rejects.toBeInstanceOf(NotFoundError);

    txProposalRepo = makeProposalRepo(proposalItems(), PROPOSAL_ROW, {
      lockProposalByIdForUser: vi.fn(async () => ({ ...PROPOSAL_ROW, status: "confirmed" as const })),
    });
    service = new L3ProposalService(proposalRepo, contextRepo, txRunner, () => ({ l3Context: txContextRepo, l3Proposal: txProposalRepo } as unknown as IRepositories));
    await expect(service.confirmProposal({ userId: "u1", proposalId: "prop-1" })).rejects.toBeInstanceOf(ConflictError);
  });
});
