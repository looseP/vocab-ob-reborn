import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, ValidationError } from "@/errors";
import type { Json, L3ImportJobRow, L3ProposalBundle, L3ProposalRow, WordbookRow, WordRow } from "@/domain";
import type { IL3ContextRepository } from "@/repositories/interfaces";
import type { CreateL3ProposalInput } from "@/schemas/service";
import { L3ImportService } from "@/services/l3-import.service";
import type { L3ProposalService } from "@/services/l3-proposal.service";

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
  id: "00000000-0000-4000-8000-000000000111",
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

const STORM_ROW: WordRow = {
  ...WORD_ROW,
  id: "00000000-0000-4000-8000-000000000222",
  slug: "storm",
  title: "storm",
  lemma: "storm",
  source_path: "words/storm.md",
  content_hash: "b".repeat(64),
};

const IMPORT_JOB_ROW: L3ImportJobRow = {
  id: "job-1",
  user_id: "u1",
  source_id: null,
  status: "processing",
  input_hash: "hash",
  input_summary: null,
  stats: {},
  error: null,
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
};

const PROPOSAL_ROW: L3ProposalRow = {
  id: "prop-1",
  user_id: "u1",
  wordbook_id: "wb-1",
  source_type: "import",
  status: "pending",
  title: "Import: Essay",
  summary: null,
  input_hash: "hash",
  proposed_by: "l3_import_builder",
  provenance: {},
  review_note: null,
  confirmed_at: null,
  rejected_at: null,
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
};

function makeContextRepo(overrides: Partial<IL3ContextRepository> = {}): IL3ContextRepository {
  return {
    createSource: vi.fn(),
    createContext: vi.fn(),
    createOccurrence: vi.fn(),
    createContextLink: vi.fn(),
    createImportJob: vi.fn(async (input) => ({
      ...IMPORT_JOB_ROW,
      user_id: input.user_id,
      status: input.status as never,
      input_hash: input.input_hash,
      input_summary: input.input_summary ?? null,
      stats: input.stats ?? {},
    })),
    updateImportJobStatus: vi.fn(async (_jobId, userId, status, stats = {}, error = null) => ({
      ...IMPORT_JOB_ROW,
      user_id: userId,
      status: status as never,
      stats,
      error,
    })),
    findWordbookByIdForUser: vi.fn(async () => WORDBOOK_ROW),
    findSourceById: vi.fn(),
    findContextById: vi.fn(),
    findContextWithSourceById: vi.fn(),
    findWordById: vi.fn(async (wordId) => wordId === WORD_ROW.id ? WORD_ROW : null),
    findWordBySlug: vi.fn(async (slug) => slug === "vivid" ? WORD_ROW : slug === "storm" ? STORM_ROW : null),
    findWordInWordbookById: vi.fn(async (_wordbookId, wordId) => wordId === WORD_ROW.id ? WORD_ROW : null),
    findWordInWordbookBySlug: vi.fn(async (_wordbookId, slug) => slug === "vivid" ? WORD_ROW : slug === "storm" ? STORM_ROW : null),
    listContextsForWord: vi.fn(),
    listContextsForSource: vi.fn(),
    getContextDetail: vi.fn(),
    getWordSpace: vi.fn(),
    getSourceSpace: vi.fn(),
    getGraph: vi.fn(),
    ...overrides,
  } as IL3ContextRepository;
}

function makeProposalService(overrides: Partial<L3ProposalService> = {}): L3ProposalService {
  return {
    createProposal: vi.fn(async (input: CreateL3ProposalInput): Promise<L3ProposalBundle> => ({
      proposal: {
        ...PROPOSAL_ROW,
        user_id: input.userId,
        wordbook_id: input.wordbookId ?? null,
        input_hash: input.inputHash ?? null,
        title: input.title ?? null,
        summary: input.summary ?? null,
        provenance: input.provenance ?? {},
      },
      items: input.items.map((item, index) => ({
        id: `item-${index + 1}`,
        proposal_id: "prop-1",
        user_id: input.userId,
        item_type: item.itemType,
        ordinal: index + 1,
        payload: {
          ...(item.payload as Record<string, unknown>),
          ...(item.clientRef ? { clientRef: item.clientRef } : {}),
        } as Json,
        status: "pending",
        validation_errors: [],
        active_entity_type: null,
        active_entity_id: null,
        created_at: "2026-07-08T00:00:00Z",
        updated_at: "2026-07-08T00:00:00Z",
      })),
    })),
    validateProposal: vi.fn(),
    ...overrides,
  } as unknown as L3ProposalService;
}

let contextRepo: IL3ContextRepository;
let proposalService: L3ProposalService;
let service: L3ImportService;

beforeEach(() => {
  contextRepo = makeContextRepo();
  proposalService = makeProposalService();
  service = new L3ImportService(contextRepo, proposalService);
});

describe("L3ImportService", () => {
  it("raw text import creates import job and proposal items without active L3 writes", async () => {
    const result = await service.createRawTextImportProposal({
      userId: "u1",
      wordbookId: "wb-1",
      source: { sourceType: "article", title: "Essay", language: "en" },
      text: "She gave a vivid account. The storm grew vivid.",
      targetWords: [{ slug: "vivid" }, { slug: "storm" }],
      options: { contextType: "sentence" },
      provenance: { source: "manual_import" },
    });

    expect(contextRepo.createImportJob).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "u1",
      status: "processing",
      input_summary: "Essay: 2 parsed contexts",
    }));
    expect(contextRepo.updateImportJobStatus).toHaveBeenCalledWith(
      "job-1",
      "u1",
      "completed",
      expect.objectContaining({ contextCount: 2, occurrenceCount: 3, linkCount: 0 }),
      null,
    );
    expect(result.importJob.status).toBe("completed");
    expect(proposalService.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      sourceType: "import",
      proposedBy: "l3_import_builder",
    }));
    expect(result.parseStats).toMatchObject({ contextCount: 2, occurrenceCount: 3, linkCount: 0 });
    expect(result.items.map((item) => item.item_type)).toEqual(["source", "context", "occurrence", "context", "occurrence", "occurrence"]);
    expect(result.items[2].payload).toMatchObject({
      contextRef: "context-1",
      slug: "vivid",
      surface: "vivid",
      evidence: expect.objectContaining({ importJobId: "job-1", method: "deterministic_text_match" }),
    });
    expect(contextRepo.createSource).not.toHaveBeenCalled();
    expect(contextRepo.createContext).not.toHaveBeenCalled();
    expect(contextRepo.createOccurrence).not.toHaveBeenCalled();
    expect(contextRepo.createContextLink).not.toHaveBeenCalled();
  });

  it("structured import creates source/context/occurrence/link proposal items", async () => {
    const result = await service.createStructuredImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Collected examples", language: "en" },
      contexts: [
        {
          clientRef: "ctx-a",
          contextType: "sentence",
          text: "She gave a vivid account.",
          occurrences: [{ slug: "vivid", surface: "vivid", startOffset: 11, endOffset: 16 }],
          links: [{ linkType: "illustrates", targetType: "external", targetRef: { url: "https://example.com" } }],
        },
      ],
      provenance: { source: "external_agent" },
    });

    expect(result.parseStats).toMatchObject({ contextCount: 1, occurrenceCount: 1, linkCount: 1 });
    expect(contextRepo.createImportJob).toHaveBeenCalledWith(expect.objectContaining({ status: "processing" }));
    expect(contextRepo.updateImportJobStatus).toHaveBeenCalledWith(
      "job-1",
      "u1",
      "completed",
      expect.objectContaining({ contextCount: 1, occurrenceCount: 1, linkCount: 1 }),
      null,
    );
    expect(result.importJob.status).toBe("completed");
    expect(result.items.map((item) => item.item_type)).toEqual(["source", "context", "occurrence", "context_link"]);
    expect(result.items[1].payload).toMatchObject({ clientRef: "ctx-a", sourceRef: "source-1" });
    expect(result.items[3].payload).toMatchObject({
      contextRef: "ctx-a",
      linkType: "illustrates",
      targetType: "external",
      provenance: expect.objectContaining({ importJobId: "job-1", source: "structured_import" }),
    });
  });

  it("does not generate occurrence items when raw target words are absent", async () => {
    const result = await service.createRawTextImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Note" },
      text: "A vivid account.",
    });

    expect(result.parseStats.occurrenceCount).toBe(0);
    expect(result.items.map((item) => item.item_type)).toEqual(["source", "context"]);
  });

  it("deduplicates repeated raw target slugs before matching and hashing", async () => {
    const result = await service.createRawTextImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Note" },
      text: "A vivid account.",
      targetWords: [{ slug: "vivid" }, { slug: "vivid" }],
    });

    const occurrenceItems = result.items.filter((item) => item.item_type === "occurrence");
    expect(occurrenceItems).toHaveLength(1);
    expect(result.parseStats.occurrenceCount).toBe(1);
    expect(proposalService.createProposal).toHaveBeenCalledWith(expect.objectContaining({
      inputHash: expect.any(String),
    }));
    expect(contextRepo.findWordBySlug).toHaveBeenCalledTimes(2);
  });

  it("keeps raw inputHash stable when duplicate targetWords are supplied", async () => {
    const singleton = await service.createRawTextImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Note" },
      text: "A vivid account.",
      targetWords: [{ slug: "vivid" }],
    });
    const singletonHash = singleton.proposal.input_hash;

    contextRepo = makeContextRepo();
    proposalService = makeProposalService();
    service = new L3ImportService(contextRepo, proposalService);
    const duplicated = await service.createRawTextImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Note" },
      text: "A vivid account.",
      targetWords: [{ slug: "vivid" }, { slug: "vivid" }],
    });

    expect(duplicated.proposal.input_hash).toBe(singletonHash);
  });

  it("deduplicates repeated raw target wordIds before matching", async () => {
    const result = await service.createRawTextImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Note" },
      text: "A vivid account.",
      targetWords: [{ wordId: WORD_ROW.id }, { wordId: WORD_ROW.id }],
    });

    const occurrenceItems = result.items.filter((item) => item.item_type === "occurrence");
    expect(occurrenceItems).toHaveLength(1);
    expect(occurrenceItems[0].payload).toMatchObject({ wordId: WORD_ROW.id, slug: "vivid" });
    expect(result.parseStats.occurrenceCount).toBe(1);
    expect(contextRepo.findWordById).toHaveBeenCalledTimes(2);
  });

  it("rejects foreign wordbook before creating import job", async () => {
    contextRepo = makeContextRepo({ findWordbookByIdForUser: vi.fn(async () => null) });
    service = new L3ImportService(contextRepo, proposalService);

    await expect(service.createRawTextImportProposal({
      userId: "u1",
      wordbookId: "foreign-wb",
      source: { sourceType: "manual", title: "Note" },
      text: "A vivid account.",
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(contextRepo.createImportJob).not.toHaveBeenCalled();
  });

  it("rejects empty or too-large text before creating import job", async () => {
    await expect(service.createRawTextImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Note" },
      text: "",
    })).rejects.toBeInstanceOf(ValidationError);

    await expect(service.createRawTextImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Note" },
      text: "x".repeat(500_001),
    })).rejects.toBeInstanceOf(ValidationError);
    expect(contextRepo.createImportJob).not.toHaveBeenCalled();
  });

  it("rejects structured proposal amplification when called outside HTTP", async () => {
    const occurrences = Array.from({ length: 1_000 }, (_, index) => ({
      slug: "vivid",
      surface: `vivid-${index}`,
    }));

    await expect(service.createStructuredImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Examples" },
      contexts: [{ contextType: "sentence", text: "A vivid account.", occurrences }],
    })).rejects.toMatchObject({ field: "contexts" });

    expect(contextRepo.createImportJob).not.toHaveBeenCalled();
    expect(proposalService.createProposal).not.toHaveBeenCalled();
  });

  it("rejects structured context/source link proposal refs before creating import job", async () => {
    await expect(service.createStructuredImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Examples" },
      contexts: [{
        clientRef: "ctx-a",
        contextType: "sentence",
        text: "A vivid account.",
        links: [{
          linkType: "illustrates",
          targetType: "context",
          targetRef: { contextRef: "ctx-a" },
        }],
      }],
    })).rejects.toBeInstanceOf(ValidationError);

    await expect(service.createStructuredImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Examples" },
      contexts: [{
        contextType: "sentence",
        text: "A vivid account.",
        links: [{
          linkType: "illustrates",
          targetType: "source",
          targetRef: { sourceRef: "source-1" },
        }],
      }],
    })).rejects.toBeInstanceOf(ValidationError);

    expect(contextRepo.createImportJob).not.toHaveBeenCalled();
  });

  it("marks import job failed if proposal creation fails after parsing", async () => {
    proposalService = makeProposalService({
      createProposal: vi.fn(async () => {
        throw new Error("proposal insert failed");
      }),
    } as Partial<L3ProposalService>);
    service = new L3ImportService(contextRepo, proposalService);

    await expect(service.createRawTextImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Note" },
      text: "A vivid account.",
      targetWords: [{ slug: "vivid" }],
    })).rejects.toThrow("proposal insert failed");

    expect(contextRepo.updateImportJobStatus).toHaveBeenCalledWith(
      "job-1",
      "u1",
      "failed",
      expect.objectContaining({ contextCount: 1, occurrenceCount: 1 }),
      "proposal insert failed",
    );
  });

  it("marks structured import job failed if proposal creation fails after parsing", async () => {
    proposalService = makeProposalService({
      createProposal: vi.fn(async () => {
        throw new Error("structured proposal insert failed");
      }),
    } as Partial<L3ProposalService>);
    service = new L3ImportService(contextRepo, proposalService);

    await expect(service.createStructuredImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Examples" },
      contexts: [{ contextType: "sentence", text: "A vivid account." }],
    })).rejects.toThrow("structured proposal insert failed");

    expect(contextRepo.createImportJob).toHaveBeenCalledWith(expect.objectContaining({ status: "processing" }));
    expect(contextRepo.updateImportJobStatus).toHaveBeenCalledWith(
      "job-1",
      "u1",
      "failed",
      expect.objectContaining({ contextCount: 1, occurrenceCount: 0, linkCount: 0 }),
      "structured proposal insert failed",
    );
  });

  it("generated raw proposal can be passed to validateProposal", async () => {
    const result = await service.createRawTextImportProposal({
      userId: "u1",
      source: { sourceType: "manual", title: "Note" },
      text: "A vivid account.",
      targetWords: [{ slug: "vivid" }],
    });

    await proposalService.validateProposal({ userId: "u1", proposalId: result.proposal.id });

    expect(proposalService.validateProposal).toHaveBeenCalledWith({ userId: "u1", proposalId: "prop-1" });
  });
});
