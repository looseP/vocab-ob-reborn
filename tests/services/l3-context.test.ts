import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundError, ValidationError } from "@/errors";
import type { L3ContextRow, L3SourceRow, WordbookRow, WordRow } from "@/domain";
import type { IL3ContextRepository } from "@/repositories/interfaces";
import { L3ContextService } from "@/services/l3-context.service";

const SOURCE_ROW: L3SourceRow = {
  id: "src-1",
  user_id: "u1",
  wordbook_id: null,
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
  text: "A vivid context.",
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

const MISSING_WORD_ID = "00000000-0000-4000-8000-000000000101";
const MISSING_SOURCE_ID = "00000000-0000-4000-8000-000000000102";
const WORD_ID = "00000000-0000-4000-8000-000000000103";

function makeRepo(overrides: Partial<IL3ContextRepository> = {}): IL3ContextRepository {
  return {
    createSource: vi.fn(async (input) => ({
      id: "src-1",
      user_id: input.user_id,
      wordbook_id: input.wordbook_id ?? null,
      source_type: input.source_type as never,
      title: input.title,
      author: input.author ?? null,
      url: input.url ?? null,
      language: input.language ?? null,
      metadata: input.metadata ?? {},
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z",
    })),
    createContext: vi.fn(async (input) => ({
      id: "ctx-1",
      source_id: input.source_id,
      user_id: input.user_id,
      context_type: input.context_type as never,
      text: input.text,
      normalized_text: input.normalized_text ?? null,
      language: input.language ?? null,
      position: input.position ?? {},
      metadata: input.metadata ?? {},
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z",
    })),
    createOccurrence: vi.fn(async (input) => ({
      id: "occ-1",
      context_id: input.context_id,
      word_id: input.word_id,
      user_id: input.user_id,
      surface: input.surface,
      lemma: input.lemma ?? null,
      start_offset: input.start_offset ?? null,
      end_offset: input.end_offset ?? null,
      confidence: input.confidence ?? null,
      evidence: input.evidence ?? {},
      created_at: "2026-07-08T00:00:00Z",
    })),
    createContextLink: vi.fn(async (input) => ({
      id: "link-1",
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
    createImportJob: vi.fn(async (input) => ({
      id: "job-1",
      user_id: input.user_id,
      source_id: input.source_id ?? null,
      status: input.status as never,
      input_hash: input.input_hash,
      input_summary: input.input_summary ?? null,
      stats: input.stats ?? {},
      error: input.error ?? null,
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z",
    })),
    updateImportJobStatus: vi.fn(async (_importJobId, userId, status, stats = {}, error = null) => ({
      id: "job-1",
      user_id: userId,
      source_id: null,
      status: status as never,
      input_hash: "hash",
      input_summary: null,
      stats,
      error,
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:01Z",
    })),
    findWordbookByIdForUser: vi.fn(async () => WORDBOOK_ROW),
    findSourceById: vi.fn(async () => SOURCE_ROW),
    findContextById: vi.fn(async () => CONTEXT_ROW),
    findContextWithSourceById: vi.fn(async () => ({ context: CONTEXT_ROW, source: SOURCE_ROW })),
    findWordById: vi.fn(async () => WORD_ROW),
    findWordBySlug: vi.fn(async () => WORD_ROW),
    findWordInWordbookById: vi.fn(async () => WORD_ROW),
    findWordInWordbookBySlug: vi.fn(async () => WORD_ROW),
    listContextsForWord: vi.fn(async () => ({ items: [], limit: 10, cursor: null, nextCursor: null })),
    listContextsForSource: vi.fn(async () => ({ items: [], limit: 10, cursor: null, nextCursor: null })),
    getContextDetail: vi.fn(),
    getWordSpace: vi.fn(),
    getSourceSpace: vi.fn(),
    getGraph: vi.fn(),
    ...overrides,
  };
}

let repo: IL3ContextRepository;
let service: L3ContextService;

beforeEach(() => {
  repo = makeRepo();
  service = new L3ContextService(repo);
});

describe("L3ContextService", () => {
  it("rejects createContext when source does not exist for the user", async () => {
    repo = makeRepo({ findSourceById: vi.fn(async () => null) });
    service = new L3ContextService(repo);

    await expect(service.createContext({
      userId: "u1",
      sourceId: "missing",
      contextType: "sentence",
      text: "A vivid context.",
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.createContext).not.toHaveBeenCalled();
  });

  it("rejects createOccurrence when context does not exist", async () => {
    repo = makeRepo({ findContextWithSourceById: vi.fn(async () => null) });
    service = new L3ContextService(repo);

    await expect(service.createOccurrence({
      userId: "u1",
      contextId: "missing",
      wordId: "w1",
      surface: "vivid",
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.createOccurrence).not.toHaveBeenCalled();
  });

  it("rejects createSource when wordbook is outside the user scope", async () => {
    repo = makeRepo({ findWordbookByIdForUser: vi.fn(async () => null) });
    service = new L3ContextService(repo);

    await expect(service.createSource({
      userId: "u1",
      wordbookId: "foreign-wb",
      sourceType: "manual",
      title: "Scoped note",
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.createSource).not.toHaveBeenCalled();
  });

  it("requires occurrences under a wordbook source to use words from that wordbook", async () => {
    repo = makeRepo({
      findContextWithSourceById: vi.fn(async () => ({
        context: CONTEXT_ROW,
        source: { ...SOURCE_ROW, wordbook_id: "wb-1" },
      })),
      findWordInWordbookById: vi.fn(async () => null),
    });
    service = new L3ContextService(repo);

    await expect(service.createOccurrence({
      userId: "u1",
      contextId: "ctx-1",
      wordId: "outside-word",
      surface: "vivid",
      startOffset: 2,
      endOffset: 7,
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.findWordInWordbookById).toHaveBeenCalledWith("wb-1", "outside-word");
    expect(repo.createOccurrence).not.toHaveBeenCalled();
  });

  it("rejects createOccurrence when word does not exist", async () => {
    repo = makeRepo({ findWordById: vi.fn(async () => null) });
    service = new L3ContextService(repo);

    await expect(service.createOccurrence({
      userId: "u1",
      contextId: "ctx-1",
      wordId: "missing",
      surface: "vivid",
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.createOccurrence).not.toHaveBeenCalled();
  });

  it("rejects offsets whose exact slice does not match surface", async () => {
    await expect(service.createOccurrence({
      userId: "u1",
      contextId: "ctx-1",
      wordId: "w1",
      surface: "VIVID",
      startOffset: 2,
      endOffset: 7,
    })).rejects.toBeInstanceOf(ValidationError);
    expect(repo.createOccurrence).not.toHaveBeenCalled();
  });

  it("rejects out-of-bounds occurrence offsets with ValidationError", async () => {
    await expect(service.createOccurrence({
      userId: "u1",
      contextId: "ctx-1",
      wordId: "w1",
      surface: "vivid",
      startOffset: 2,
      endOffset: 99,
    })).rejects.toBeInstanceOf(ValidationError);
    expect(repo.createOccurrence).not.toHaveBeenCalled();
  });

  it("validates word link targets exist", async () => {
    repo = makeRepo({ findWordById: vi.fn(async (wordId) => wordId === "w1" ? WORD_ROW : null) });
    service = new L3ContextService(repo);

    await expect(service.createContextLink({
      userId: "u1",
      contextId: "ctx-1",
      linkType: "illustrates",
      targetType: "word",
      targetId: MISSING_WORD_ID,
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.createContextLink).not.toHaveBeenCalled();
  });

  it("requires word link targets under a wordbook source to use words from that wordbook", async () => {
    repo = makeRepo({
      findContextWithSourceById: vi.fn(async () => ({
        context: CONTEXT_ROW,
        source: { ...SOURCE_ROW, wordbook_id: "wb-1" },
      })),
      findWordInWordbookById: vi.fn(async (wordbookId, wordId) =>
        wordbookId === "wb-1" && wordId === "w1" ? WORD_ROW : null,
      ),
      findWordById: vi.fn(async () => WORD_ROW),
    });
    service = new L3ContextService(repo);

    await expect(service.createContextLink({
      userId: "u1",
      contextId: "ctx-1",
      linkType: "illustrates",
      targetType: "word",
      targetId: MISSING_WORD_ID,
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.findWordInWordbookById).toHaveBeenCalledWith("wb-1", MISSING_WORD_ID);
    expect(repo.findWordById).not.toHaveBeenCalledWith(MISSING_WORD_ID);
    expect(repo.createContextLink).not.toHaveBeenCalled();
  });

  it("allows word link targets from the context source wordbook", async () => {
    repo = makeRepo({
      findContextWithSourceById: vi.fn(async () => ({
        context: CONTEXT_ROW,
        source: { ...SOURCE_ROW, wordbook_id: "wb-1" },
      })),
      findWordInWordbookById: vi.fn(async (wordbookId, wordId) =>
        wordbookId === "wb-1" && wordId === WORD_ID ? WORD_ROW : null,
      ),
    });
    service = new L3ContextService(repo);

    await service.createContextLink({
      userId: "u1",
      contextId: "ctx-1",
      linkType: "illustrates",
      targetType: "word",
      targetId: WORD_ID,
    });

    expect(repo.findWordInWordbookById).toHaveBeenCalledWith("wb-1", WORD_ID);
    expect(repo.createContextLink).toHaveBeenCalled();
  });

  it("requires link anchor words under a wordbook source to use words from that wordbook", async () => {
    repo = makeRepo({
      findContextWithSourceById: vi.fn(async () => ({
        context: CONTEXT_ROW,
        source: { ...SOURCE_ROW, wordbook_id: "wb-1" },
      })),
      findWordInWordbookById: vi.fn(async () => null),
    });
    service = new L3ContextService(repo);

    await expect(service.createContextLink({
      userId: "u1",
      contextId: "ctx-1",
      wordId: "outside-word",
      linkType: "illustrates",
      targetType: "external",
      targetRef: { url: "https://example.com" },
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.findWordInWordbookById).toHaveBeenCalledWith("wb-1", "outside-word");
    expect(repo.findWordById).not.toHaveBeenCalledWith("outside-word");
    expect(repo.createContextLink).not.toHaveBeenCalled();
  });

  it("allows link anchor words from the context source wordbook", async () => {
    repo = makeRepo({
      findContextWithSourceById: vi.fn(async () => ({
        context: CONTEXT_ROW,
        source: { ...SOURCE_ROW, wordbook_id: "wb-1" },
      })),
      findWordInWordbookById: vi.fn(async () => WORD_ROW),
    });
    service = new L3ContextService(repo);

    await service.createContextLink({
      userId: "u1",
      contextId: "ctx-1",
      wordId: "w1",
      linkType: "illustrates",
      targetType: "external",
      targetRef: { url: "https://example.com" },
    });

    expect(repo.findWordInWordbookById).toHaveBeenCalledWith("wb-1", "w1");
    expect(repo.createContextLink).toHaveBeenCalled();
  });

  it("validates source and context link targets are user scoped", async () => {
    repo = makeRepo({
      findContextWithSourceById: vi.fn(async (userId, contextId) => contextId === "ctx-1" ? { context: CONTEXT_ROW, source: SOURCE_ROW } : null),
      findSourceById: vi.fn(async () => null),
    });
    service = new L3ContextService(repo);

    await expect(service.createContextLink({
      userId: "u1",
      contextId: "ctx-1",
      linkType: "illustrates",
      targetType: "source",
      targetId: MISSING_SOURCE_ID,
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.createContextLink).not.toHaveBeenCalled();
  });

  it("requires l2_item soft references to include field and stable locator", async () => {
    await expect(service.createContextLink({
      userId: "u1",
      contextId: "ctx-1",
      linkType: "illustrates",
      targetType: "l2_item",
      targetRef: { field: "corpus" },
    })).rejects.toBeInstanceOf(ValidationError);
    expect(repo.createContextLink).not.toHaveBeenCalled();
  });

  it("lists contexts by slug through repository lookup", async () => {
    await service.listContextsForWord({
      userId: "u1",
      slug: "vivid",
      limit: 10,
      cursor: null,
    });

    expect(repo.findWordBySlug).toHaveBeenCalledWith("vivid");
    expect(repo.listContextsForWord).toHaveBeenCalledWith({
      userId: "u1",
      slug: "vivid",
      limit: 10,
      cursor: null,
    });
  });
});
