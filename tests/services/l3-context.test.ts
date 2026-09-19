import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@/errors";
import type { L3ContextRow, L3SourceRow, L3SubSpace, WordbookRow, WordRow } from "@/domain";
import type { IL3ContextRepository, IRepositories, IWordRepository } from "@/repositories/interfaces";
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
      content_text: input.content_text ?? null,
      content_hash: input.content_hash ?? null,
      created_at: "2026-07-08T00:00:00Z",
      updated_at: "2026-07-08T00:00:00Z",
    })),
    replaceSourceSpaces: vi.fn(async () => undefined),
    ensureSourceSpaces: vi.fn(async () => undefined),
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
      bound_sense: input.bound_sense ?? null,
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
    deleteOccurrence: vi.fn(async (userId, occurrenceId) => ({
      id: occurrenceId,
      context_id: "ctx-1",
      word_id: "w1",
      user_id: userId,
      surface: "vivid",
      lemma: null,
      start_offset: null,
      end_offset: null,
      confidence: null,
      evidence: {},
      bound_sense: null,
      created_at: "2026-07-08T00:00:00Z",
    })),
    deleteContextLink: vi.fn(async (userId, contextLinkId) => ({
      id: contextLinkId,
      user_id: userId,
      context_id: "ctx-1",
      word_id: null,
      link_type: "manual_link" as never,
      target_type: "external" as never,
      target_id: null,
      target_ref: {},
      confidence: null,
      provenance: {},
      created_at: "2026-07-08T00:00:00Z",
    })),
    lockActiveL3TargetReference: vi.fn(async () => undefined),
    lockSourceByIdForUser: vi.fn(async (userId, sourceId) => ({
      ...SOURCE_ROW,
      id: sourceId,
      user_id: userId,
    })),
    lockContextByIdForUser: vi.fn(async (userId, contextId) => ({
      ...CONTEXT_ROW,
      id: contextId,
      user_id: userId,
    })),
    getSourceDeleteBlockers: vi.fn(async () => ({
      contextCount: 0,
      inboundContextLinkCount: 0,
      importJobCount: 0,
    })),
    getContextDeleteBlockers: vi.fn(async () => ({
      occurrenceCount: 0,
      contextLinkCount: 0,
      inboundContextLinkCount: 0,
    })),
    deleteSource: vi.fn(async (userId, sourceId) => ({
      ...SOURCE_ROW,
      id: sourceId,
      user_id: userId,
    })),
    deleteContext: vi.fn(async (userId, contextId) => ({
      ...CONTEXT_ROW,
      id: contextId,
      user_id: userId,
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
    findImportJobByInputHash: vi.fn(async () => null),
    findWordbookByIdForUser: vi.fn(async () => WORDBOOK_ROW),
    findSourceById: vi.fn(async () => SOURCE_ROW),
    findSourceByContentHash: vi.fn(async () => null),
    listSources: vi.fn(async () => ({ items: [], total: 0, limit: 20, offset: 0 })),
    findContextById: vi.fn(async () => CONTEXT_ROW),
    findContextByAnchor: vi.fn(async () => null),
    listOccurrencesForContext: vi.fn(async () => []),
    findContextWithSourceById: vi.fn(async () => ({ context: CONTEXT_ROW, source: SOURCE_ROW })),
    findWordById: vi.fn(async () => WORD_ROW),
    findWordBySlug: vi.fn(async () => WORD_ROW),
    findWordInWordbookById: vi.fn(async () => WORD_ROW),
    findWordInWordbookBySlug: vi.fn(async () => WORD_ROW),
    listContextsForWord: vi.fn(async () => ({ items: [], limit: 10, cursor: null, nextCursor: null })),
    listContextsForSource: vi.fn(async () => ({ items: [], limit: 10, cursor: null, nextCursor: null })),
    listOccurrences: vi.fn(async () => ({ items: [], limit: 10, cursor: null, nextCursor: null })),
    listContextLinks: vi.fn(async () => ({ items: [], limit: 10, cursor: null, nextCursor: null })),
    getContextDetail: vi.fn(),
    getWordSpace: vi.fn(),
    getSourceSpace: vi.fn(),
    getGraph: vi.fn(),
    getSpaceSummaryCounts: vi.fn(async () => ({ sourceCount: 0, contextCount: 0, occurrenceCount: 0, linkCount: 0 })),
    getSpaceGrowth: vi.fn(async () => []),
    ...overrides,
  };
}

/** 学习笔记引用向的窄 fake（N1）：默认无 blocker。 */
function makeStudyRefRepo(overrides: Record<string, unknown> = {}) {
  return {
    getSourceDeleteBlockers: vi.fn(async () => []),
    ...overrides,
  };
}

/** F1：deleteSource 的 FK 兜底需要事务连接可用（SAVEPOINT/ROLLBACK TO/RELEASE）。 */
function makeTx() {
  return { query: vi.fn(async () => ({})) } as never;
}

function makeService(
  repository: IL3ContextRepository,
  txRepository = repository,
  txRunner: typeof import("@/db/transaction").withTransaction = async (callback) => callback(makeTx()),
  words?: IWordRepository,
  studyRefRepo: Record<string, unknown> = makeStudyRefRepo(),
): L3ContextService {
  return new L3ContextService(
    repository,
    words,
    txRunner,
    () => ({ l3Context: txRepository, studyReferences: studyRefRepo } as unknown as IRepositories),
  );
}

let repo: IL3ContextRepository;
let service: L3ContextService;

beforeEach(() => {
  repo = makeRepo();
  service = makeService(repo);
});

describe("L3ContextService", () => {
  it("passes the authenticated actor into transactional source operations", async () => {
    const txRunner = vi.fn(async (callback: (tx: never) => Promise<never>) => callback(makeTx())) as unknown as typeof import("@/db/transaction").withTransaction;
    service = makeService(repo, repo, txRunner);

    await service.deleteSource({ userId: "u1", sourceId: "src-1" });

    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
  });

  it("rejects createContext when source does not exist for the user", async () => {
    repo = makeRepo({ findSourceById: vi.fn(async () => null) });
    service = makeService(repo);

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
    service = makeService(repo);

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
    service = makeService(repo);

    await expect(service.createSource({
      userId: "u1",
      wordbookId: "foreign-wb",
      sourceType: "manual",
      title: "Scoped note",
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.createSource).not.toHaveBeenCalled();
  });

  // V0 子空间接通：能力域标签的归一化与写透（ADR-0019 / l3_source_spaces）。
  it("defaults createSource spaces to 通用 and passes them to the repository", async () => {
    await service.createSource({ userId: "u1", sourceType: "manual", title: "plain note" });
    expect(repo.createSource).toHaveBeenCalledWith(expect.any(Object), ["通用"]);
  });

  it("normalizes createSource spaces: trims, dedups while preserving order, empty falls back to 通用", async () => {
    await service.createSource({
      userId: "u1", sourceType: "article", title: "真题",
      // 运行时归一化面向内部调用方，故意给带空格/重复的原始串（类型上收窄断言）。
      spaces: [" 阅读 ", "阅读", "作文", "作文"] as unknown as L3SubSpace[],
    });
    expect(repo.createSource).toHaveBeenCalledWith(expect.any(Object), ["阅读", "作文"]);

    await service.createSource({ userId: "u1", sourceType: "manual", title: "无标签", spaces: [] });
    expect(repo.createSource).toHaveBeenLastCalledWith(expect.any(Object), ["通用"]);
  });

  it("rejects createSource spaces containing values outside the five-value enum", async () => {
    await expect(service.createSource({
      userId: "u1", sourceType: "manual", title: "bad",
      spaces: ["火星"] as unknown as L3SubSpace[],
    })).rejects.toBeInstanceOf(ValidationError);
    expect(repo.createSource).not.toHaveBeenCalled();
  });

  it("replaceSourceSpaces normalizes input and writes through after the ownership check", async () => {
    const result = await service.replaceSourceSpaces({
      userId: "u1", sourceId: "src-1",
      spaces: ["翻译", "翻译", " 阅读 "] as unknown as L3SubSpace[],
    });
    expect(repo.findSourceById).toHaveBeenCalledWith("u1", "src-1");
    expect(repo.replaceSourceSpaces).toHaveBeenCalledWith("u1", "src-1", ["翻译", "阅读"]);
    expect(result).toEqual({ sourceId: "src-1", spaces: ["翻译", "阅读"] });
  });

  it("replaceSourceSpaces rejects when the source is not owned by the user", async () => {
    repo = makeRepo({ findSourceById: vi.fn(async () => null) });
    service = makeService(repo);
    await expect(service.replaceSourceSpaces({
      userId: "u1", sourceId: "src-other", spaces: ["阅读"],
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.replaceSourceSpaces).not.toHaveBeenCalled();
  });

  it("requires occurrences under a wordbook source to use words from that wordbook", async () => {
    repo = makeRepo({
      findContextWithSourceById: vi.fn(async () => ({
        context: CONTEXT_ROW,
        source: { ...SOURCE_ROW, wordbook_id: "wb-1" },
      })),
      findWordInWordbookById: vi.fn(async () => null),
    });
    service = makeService(repo);

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
    service = makeService(repo);

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
    service = makeService(repo);

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
    service = makeService(repo);

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
    service = makeService(repo);

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
    service = makeService(repo);

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
    service = makeService(repo);

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
    service = makeService(repo);

    await expect(service.createContextLink({
      userId: "u1",
      contextId: "ctx-1",
      linkType: "illustrates",
      targetType: "source",
      targetId: MISSING_SOURCE_ID,
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.lockActiveL3TargetReference).toHaveBeenCalledWith("u1", "source", MISSING_SOURCE_ID);
    expect(repo.createContextLink).not.toHaveBeenCalled();
  });

  it("serializes source and context soft-target link creation with parent deletes", async () => {
    const outerRepo = makeRepo({
      findSourceById: vi.fn(async () => {
        throw new Error("outer repo should not validate source soft target");
      }),
      findContextById: vi.fn(async () => {
        throw new Error("outer repo should not validate context soft target");
      }),
      createContextLink: vi.fn(async () => {
        throw new Error("outer repo should not create source/context soft target links");
      }),
    });
    const txRepo = makeRepo();
    service = makeService(outerRepo, txRepo);

    await service.createContextLink({
      userId: "u1",
      contextId: "ctx-1",
      linkType: "illustrates",
      targetType: "source",
      targetId: MISSING_SOURCE_ID,
    });
    await service.createContextLink({
      userId: "u1",
      contextId: "ctx-1",
      linkType: "illustrates",
      targetType: "context",
      targetId: MISSING_WORD_ID,
    });

    expect(txRepo.lockActiveL3TargetReference).toHaveBeenNthCalledWith(1, "u1", "source", MISSING_SOURCE_ID);
    expect(txRepo.lockActiveL3TargetReference).toHaveBeenNthCalledWith(2, "u1", "context", MISSING_WORD_ID);
    expect(txRepo.findSourceById).toHaveBeenCalledWith("u1", MISSING_SOURCE_ID);
    expect(txRepo.findContextById).toHaveBeenCalledWith("u1", MISSING_WORD_ID);
    expect(txRepo.createContextLink).toHaveBeenCalledTimes(2);
    expect(outerRepo.findSourceById).not.toHaveBeenCalled();
    expect(outerRepo.findContextById).not.toHaveBeenCalled();
    expect(outerRepo.createContextLink).not.toHaveBeenCalled();
  });

  it("canonicalizes source and context soft-target UUIDs before locking and writing", async () => {
    const uppercaseSourceId = "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF";
    const uppercaseContextId = "FEDCBAFE-DCBA-4FED-8CBA-FEDCBAFEDCBA";
    const sourceId = uppercaseSourceId.toLowerCase();
    const contextId = uppercaseContextId.toLowerCase();
    const txRepo = makeRepo();
    service = makeService(makeRepo(), txRepo);

    await service.createContextLink({
      userId: "u1",
      contextId: "ctx-1",
      linkType: "illustrates",
      targetType: "source",
      targetId: uppercaseSourceId,
    });
    await service.createContextLink({
      userId: "u1",
      contextId: "ctx-1",
      linkType: "illustrates",
      targetType: "context",
      targetId: uppercaseContextId,
    });

    expect(txRepo.lockActiveL3TargetReference).toHaveBeenNthCalledWith(1, "u1", "source", sourceId);
    expect(txRepo.lockActiveL3TargetReference).toHaveBeenNthCalledWith(2, "u1", "context", contextId);
    expect(txRepo.findSourceById).toHaveBeenCalledWith("u1", sourceId);
    expect(txRepo.findContextById).toHaveBeenCalledWith("u1", contextId);
    expect(txRepo.createContextLink).toHaveBeenNthCalledWith(1, expect.objectContaining({ target_id: sourceId }));
    expect(txRepo.createContextLink).toHaveBeenNthCalledWith(2, expect.objectContaining({ target_id: contextId }));
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

  it("deletes occurrence by explicit owner-scoped id", async () => {
    await expect(service.deleteOccurrence({ userId: "u1", occurrenceId: "occ-1" })).resolves.toEqual({
      deleted: { entityType: "occurrence", id: "occ-1" },
      activeReadInvalidation: true,
    });

    expect(repo.deleteOccurrence).toHaveBeenCalledWith("u1", "occ-1");
  });

  it("deletes context link by explicit owner-scoped id", async () => {
    await expect(service.deleteContextLink({ userId: "u1", contextLinkId: "link-1" })).resolves.toEqual({
      deleted: { entityType: "context_link", id: "link-1" },
      activeReadInvalidation: true,
    });

    expect(repo.deleteContextLink).toHaveBeenCalledWith("u1", "link-1");
  });

  it("maps missing or out-of-scope delete rows to NotFoundError", async () => {
    repo = makeRepo({
      deleteOccurrence: vi.fn(async () => null),
      deleteContextLink: vi.fn(async () => null),
    });
    service = makeService(repo);

    await expect(service.deleteOccurrence({ userId: "u1", occurrenceId: "missing-occ" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.deleteContextLink({ userId: "u1", contextLinkId: "missing-link" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(repo.deleteOccurrence).toHaveBeenCalledWith("u1", "missing-occ");
    expect(repo.deleteContextLink).toHaveBeenCalledWith("u1", "missing-link");
  });

  it("deletes empty source and context parents with active-read invalidation", async () => {
    await expect(service.deleteSource({ userId: "u1", sourceId: "src-1" })).resolves.toEqual({
      deleted: { entityType: "source", id: "src-1" },
      activeReadInvalidation: true,
    });
    await expect(service.deleteContext({ userId: "u1", contextId: "ctx-1" })).resolves.toEqual({
      deleted: { entityType: "context", id: "ctx-1" },
      activeReadInvalidation: true,
    });

    expect(repo.lockSourceByIdForUser).toHaveBeenCalledWith("u1", "src-1");
    expect(repo.lockActiveL3TargetReference).toHaveBeenCalledWith("u1", "source", "src-1");
    expect(repo.findSourceById).not.toHaveBeenCalledWith("u1", "src-1");
    expect(repo.getSourceDeleteBlockers).toHaveBeenCalledWith("u1", "src-1");
    expect(repo.deleteSource).toHaveBeenCalledWith("u1", "src-1");
    expect(repo.lockContextByIdForUser).toHaveBeenCalledWith("u1", "ctx-1");
    expect(repo.lockActiveL3TargetReference).toHaveBeenCalledWith("u1", "context", "ctx-1");
    expect(repo.findContextById).not.toHaveBeenCalledWith("u1", "ctx-1");
    expect(repo.getContextDeleteBlockers).toHaveBeenCalledWith("u1", "ctx-1");
    expect(repo.deleteContext).toHaveBeenCalledWith("u1", "ctx-1");
  });

  it("blocks source deletion when referenced by learning notes (N1，含归档笔记)", async () => {
    repo = makeRepo();
    const studyRefRepo = makeStudyRefRepo({
      getSourceDeleteBlockers: vi.fn(async () => [
        { note_id: "note-1", title: "受保护笔记", status: "archived", reference_count: 2 },
      ]),
    });
    service = makeService(repo, repo, undefined, undefined, studyRefRepo);

    await expect(service.deleteSource({ userId: "u1", sourceId: "src-1" })).rejects.toMatchObject({
      httpStatus: 409,
      meta: {
        blockers: {
          studyNotes: [{ id: "note-1", title: "受保护笔记", status: "archived", referenceCount: 2 }],
        },
      },
    });
    expect(repo.deleteSource).not.toHaveBeenCalled();
  });

  it("FK RESTRICT 并发兜底：DELETE 报 23503 → 重查 blocker 转 409（不落 500）", async () => {
    repo = makeRepo({
      deleteSource: vi.fn(async () => {
        throw Object.assign(new Error("fk violation"), { code: "23503" });
      }),
    });
    const studyRefRepo = makeStudyRefRepo({
      getSourceDeleteBlockers: vi.fn(async () => [
        { note_id: "note-9", title: "并发笔记", status: "active", reference_count: 1 },
      ]),
    });
    service = makeService(repo, repo, undefined, undefined, studyRefRepo);
    await expect(service.deleteSource({ userId: "u1", sourceId: "src-1" })).rejects.toMatchObject({
      httpStatus: 409,
      meta: { blockers: { studyNotes: [expect.objectContaining({ id: "note-9" })] } },
    });
  });

  it("F1：DELETE 报 23503 后先回滚保存点再重查 blocker（不落 25P02；顺序留证）", async () => {
    let poisoned = false;
    let blockerCalls = 0;
    const events: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        const text = String(sql);
        events.push(`tx:${text}`);
        if (text.trim().toUpperCase().startsWith("ROLLBACK TO SAVEPOINT")) poisoned = false;
        return {};
      }),
    };
    const txRunner = (async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)) as never;
    const studyRefRepo = makeStudyRefRepo({
      getSourceDeleteBlockers: vi.fn(async () => {
        events.push("blocker-query");
        if (poisoned) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        blockerCalls += 1;
        // 预检查（第 1 次）：并发引用尚不可见 → 空；恢复后重查（第 2 次）：命中真实 blocker
        return blockerCalls === 1
          ? []
          : [{ note_id: "note-9", title: "并发笔记", status: "active", reference_count: 1 }];
      }),
    });
    repo = makeRepo({
      deleteSource: vi.fn(async () => {
        poisoned = true; // 模拟真实 PG：FK 异常中止当前事务
        throw Object.assign(new Error("fk violation"), { code: "23503" });
      }),
    });
    service = makeService(repo, repo, txRunner, undefined, studyRefRepo);

    await expect(service.deleteSource({ userId: "u1", sourceId: "src-1" })).rejects.toMatchObject({
      httpStatus: 409,
      meta: { blockers: { studyNotes: [expect.objectContaining({ id: "note-9" })] } },
    });

    expect(events).toContain("tx:SAVEPOINT study_note_delete");
    expect(events).toContain("tx:ROLLBACK TO SAVEPOINT study_note_delete");
    expect(events).toContain("tx:RELEASE SAVEPOINT study_note_delete");
    // 恢复动作先于 blocker 重查（失败事务内查询会 25P02）
    expect(events.indexOf("tx:ROLLBACK TO SAVEPOINT study_note_delete"))
      .toBeLessThan(events.lastIndexOf("blocker-query"));
  });

  it("F1：FK 失败但无笔记 blocker → 保持原错误语义（不伪造笔记阻塞）", async () => {
    let poisoned = false;
    const tx = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).trim().toUpperCase().startsWith("ROLLBACK TO SAVEPOINT")) poisoned = false;
        return {};
      }),
    };
    const txRunner = (async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)) as never;
    const studyRefRepo = makeStudyRefRepo({
      getSourceDeleteBlockers: vi.fn(async () => {
        if (poisoned) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
        return [];
      }),
    });
    repo = makeRepo({
      deleteSource: vi.fn(async () => {
        poisoned = true;
        throw Object.assign(new Error("fk violation"), { code: "23503" });
      }),
    });
    service = makeService(repo, repo, txRunner, undefined, studyRefRepo);

    await expect(service.deleteSource({ userId: "u1", sourceId: "src-1" }))
      .rejects.toMatchObject({ code: "23503" });
  });

  it("删除未命中重查：source 仍在而删除未生效时优先重查笔记 blocker", async () => {
    repo = makeRepo({ deleteSource: vi.fn(async () => null) });
    const studyRefRepo = makeStudyRefRepo({
      getSourceDeleteBlockers: vi.fn(async () => [
        { note_id: "note-2", title: "重查笔记", status: "active", reference_count: 1 },
      ]),
    });
    service = makeService(repo, repo, undefined, undefined, studyRefRepo);
    await expect(service.deleteSource({ userId: "u1", sourceId: "src-1" })).rejects.toMatchObject({
      httpStatus: 409,
      meta: { blockers: { studyNotes: [expect.objectContaining({ id: "note-2" })] } },
    });
  });

  it("maps missing or out-of-scope source and context parent deletes to NotFoundError", async () => {
    repo = makeRepo({
      lockSourceByIdForUser: vi.fn(async () => null),
      lockContextByIdForUser: vi.fn(async () => null),
    });
    service = makeService(repo);

    await expect(service.deleteSource({ userId: "u1", sourceId: "missing-src" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.deleteContext({ userId: "u1", contextId: "missing-ctx" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(repo.getSourceDeleteBlockers).not.toHaveBeenCalled();
    expect(repo.getContextDeleteBlockers).not.toHaveBeenCalled();
    expect(repo.deleteSource).not.toHaveBeenCalled();
    expect(repo.deleteContext).not.toHaveBeenCalled();
  });

  it("rejects source and context parent deletes when active blockers remain", async () => {
    repo = makeRepo({
      getSourceDeleteBlockers: vi.fn(async () => ({
        contextCount: 1,
        inboundContextLinkCount: 2,
        importJobCount: 3,
      })),
      getContextDeleteBlockers: vi.fn(async () => ({
        occurrenceCount: 4,
        contextLinkCount: 5,
        inboundContextLinkCount: 6,
      })),
    });
    service = makeService(repo);

    await expect(service.deleteSource({ userId: "u1", sourceId: "src-1" }))
      .rejects.toMatchObject({
        code: "CONFLICT",
        meta: {
          entityType: "source",
          id: "src-1",
          blockers: {
            contextCount: 1,
            inboundContextLinkCount: 2,
            importJobCount: 3,
          },
        },
      });
    await expect(service.deleteContext({ userId: "u1", contextId: "ctx-1" }))
      .rejects.toMatchObject({
        code: "CONFLICT",
        meta: {
          entityType: "context",
          id: "ctx-1",
          blockers: {
            occurrenceCount: 4,
            contextLinkCount: 5,
            inboundContextLinkCount: 6,
          },
        },
      });

    await expect(service.deleteSource({ userId: "u1", sourceId: "src-1" }))
      .rejects.toBeInstanceOf(ConflictError);
    await expect(service.deleteContext({ userId: "u1", contextId: "ctx-1" }))
      .rejects.toBeInstanceOf(ConflictError);
    expect(repo.deleteSource).not.toHaveBeenCalled();
    expect(repo.deleteContext).not.toHaveBeenCalled();
  });

  // P0 语境管理出口（2026-09-08）：occurrences 与同 context 的 context_links 的 FK 均
  // ON DELETE CASCADE，不应阻断 context 删除——圈记三件套必带 occurrence，若计入
  // blockers，用户圈记的语境将永远无法删除。真正的 blocker 仅剩软引用 inbound。
  it("allows context delete when only cascaded references exist (no soft inbound links)", async () => {
    repo = makeRepo({
      getContextDeleteBlockers: vi.fn(async () => ({
        occurrenceCount: 3,
        contextLinkCount: 2,
        inboundContextLinkCount: 0,
      })),
    });
    service = makeService(repo);

    await expect(service.deleteContext({ userId: "u1", contextId: "ctx-1" })).resolves.toEqual({
      deleted: { entityType: "context", id: "ctx-1" },
      activeReadInvalidation: true,
    });
    expect(repo.deleteContext).toHaveBeenCalledWith("u1", "ctx-1");
  });

  it("maps concurrent parent delete misses to NotFoundError after blocker checks pass", async () => {
    repo = makeRepo({
      deleteSource: vi.fn(async () => null),
      deleteContext: vi.fn(async () => null),
      findSourceById: vi.fn(async () => null),
      findContextById: vi.fn(async () => null),
    });
    service = makeService(repo);

    await expect(service.deleteSource({ userId: "u1", sourceId: "src-1" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.deleteContext({ userId: "u1", contextId: "ctx-1" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(repo.deleteSource).toHaveBeenCalledWith("u1", "src-1");
    expect(repo.deleteContext).toHaveBeenCalledWith("u1", "ctx-1");
  });

  it("maps atomic guarded parent delete misses with surviving parents to ConflictError", async () => {
    repo = makeRepo({
      deleteSource: vi.fn(async () => null),
      deleteContext: vi.fn(async () => null),
      getSourceDeleteBlockers: vi.fn()
        .mockResolvedValueOnce({ contextCount: 0, inboundContextLinkCount: 0, importJobCount: 0 })
        .mockResolvedValueOnce({ contextCount: 1, inboundContextLinkCount: 0, importJobCount: 0 }),
      getContextDeleteBlockers: vi.fn()
        .mockResolvedValueOnce({ occurrenceCount: 0, contextLinkCount: 0, inboundContextLinkCount: 0 })
        .mockResolvedValueOnce({ occurrenceCount: 1, contextLinkCount: 0, inboundContextLinkCount: 0 }),
    });
    service = makeService(repo);

    await expect(service.deleteSource({ userId: "u1", sourceId: "src-1" }))
      .rejects.toMatchObject({
        code: "CONFLICT",
        meta: {
          entityType: "source",
          blockers: { contextCount: 1 },
        },
      });
    await expect(service.deleteContext({ userId: "u1", contextId: "ctx-1" }))
      .rejects.toMatchObject({
        code: "CONFLICT",
        meta: {
          entityType: "context",
          blockers: { occurrenceCount: 1 },
        },
      });
  });

  it("creates an import job through the actor-scoped repository after source validation", async () => {
    const txRunner = vi.fn(async (callback: (tx: never) => Promise<never>) => callback({} as never)) as unknown as typeof import("@/db/transaction").withTransaction;
    const txRepo = makeRepo();
    service = makeService(makeRepo(), txRepo, txRunner);

    await expect(service.createImportJob({
      userId: "u1",
      sourceId: "src-1",
      status: "pending",
      inputHash: "hash-1",
      inputSummary: "two contexts",
      stats: { parsed: 2 },
    })).resolves.toMatchObject({ importJob: { id: "job-1", user_id: "u1" } });

    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(txRepo.findSourceById).toHaveBeenCalledWith("u1", "src-1");
    expect(txRepo.createImportJob).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "u1",
      source_id: "src-1",
      status: "pending",
      input_hash: "hash-1",
    }));
  });

  it("rejects import jobs and source context reads outside the actor scope", async () => {
    const txRepo = makeRepo({ findSourceById: vi.fn(async () => null) });
    service = makeService(makeRepo(), txRepo);

    await expect(service.createImportJob({
      userId: "u1",
      sourceId: "missing-source",
      status: "pending",
      inputHash: "hash-2",
    })).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.listContextsForSource({
      userId: "u1",
      sourceId: "missing-source",
      limit: 10,
      cursor: null,
    })).rejects.toBeInstanceOf(NotFoundError);

    expect(txRepo.createImportJob).not.toHaveBeenCalled();
    expect(txRepo.listContextsForSource).not.toHaveBeenCalled();
  });

  it("lists contexts by slug and source through actor-scoped repository lookup", async () => {
    await service.listContextsForWord({
      userId: "u1",
      slug: "vivid",
      limit: 10,
      cursor: null,
    });
    await service.listContextsForSource({
      userId: "u1",
      sourceId: "src-1",
      limit: 10,
      cursor: null,
    });

    expect(repo.findWordBySlug).toHaveBeenCalledWith("vivid");
    expect(repo.listContextsForWord).toHaveBeenCalledWith({
      userId: "u1",
      slug: "vivid",
      direction: null,
      space: null,
      limit: 10,
      cursor: null,
    });
    expect(repo.findSourceById).toHaveBeenCalledWith("u1", "src-1");
    expect(repo.listContextsForSource).toHaveBeenCalledWith({
      userId: "u1",
      sourceId: "src-1",
      limit: 10,
      cursor: null,
    });
  });

  it("creates a selection capture with anchored context and occurrence offsets", async () => {
    repo = makeRepo({
      lockSourceByIdForUser: vi.fn(async () => ({
        ...SOURCE_ROW,
        content_text: "A vivid context.",
      })),
    });
    service = makeService(repo);

    await expect(service.createSelectionCapture({
      userId: "u1",
      sourceId: "src-1",
      text: "A vivid context.",
      anchorStart: 0,
      anchorEnd: 16,
      surface: "vivid",
      wordSlug: "vivid",
    })).resolves.toEqual({
      contextId: "ctx-1",
      occurrenceId: "occ-1",
      word: { id: "w1", slug: "vivid", title: "vivid" },
      created: false,
    });

    expect(repo.findWordBySlug).toHaveBeenCalledWith("vivid");
    expect(repo.createContext).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "u1",
      source_id: "src-1",
      context_type: "sentence",
      text: "A vivid context.",
      language: "en",
      position: { start: 0, end: 16 },
    }));
    expect(repo.createOccurrence).toHaveBeenCalledWith(expect.objectContaining({
      context_id: "ctx-1",
      word_id: "w1",
      surface: "vivid",
      lemma: "vivid",
      start_offset: 2,
      end_offset: 7,
      evidence: { via: "selection_capture" },
    }));
  });

  it("records null occurrence offsets when the surface is absent from the context text", async () => {
    repo = makeRepo({
      lockSourceByIdForUser: vi.fn(async () => ({
        ...SOURCE_ROW,
        content_text: "A vivid context.",
      })),
    });
    service = makeService(repo);

    await expect(service.createSelectionCapture({
      userId: "u1",
      sourceId: "src-1",
      text: "A vivid context.",
      anchorStart: 0,
      anchorEnd: 16,
      surface: "missing",
      wordSlug: "vivid",
    })).resolves.toMatchObject({ occurrenceId: "occ-1" });

    expect(repo.createOccurrence).toHaveBeenCalledWith(expect.objectContaining({
      start_offset: null,
      end_offset: null,
    }));
  });

  it("creates a stub word outside the transaction when the capture slug is new", async () => {
    repo = makeRepo({
      findWordBySlug: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(WORD_ROW),
      lockSourceByIdForUser: vi.fn(async () => ({
        ...SOURCE_ROW,
        content_text: "A vivid context.",
      })),
    });
    const insertMany = vi.fn(async () => undefined);
    service = makeService(repo, repo, undefined, { insertMany } as unknown as IWordRepository);

    await expect(service.createSelectionCapture({
      userId: "u1",
      sourceId: "src-1",
      text: "A vivid context.",
      anchorStart: 0,
      anchorEnd: 16,
      surface: "vivid",
      wordSlug: "vivid",
    })).resolves.toMatchObject({ created: true });

    expect(insertMany).toHaveBeenCalledWith([expect.objectContaining({
      slug: "vivid",
      title: "vivid",
      lemma: "vivid",
    })]);
  });

  it("requires a words repository with insertMany before stubbing a new capture word", async () => {
    repo = makeRepo({ findWordBySlug: vi.fn(async () => null) });
    service = makeService(repo);

    await expect(service.createSelectionCapture({
      userId: "u1",
      sourceId: "src-1",
      text: "A vivid context.",
      anchorStart: 0,
      anchorEnd: 16,
      surface: "vivid",
      wordSlug: "vivid",
    })).rejects.toThrow(/words repository with insertMany is required/);
    expect(repo.lockSourceByIdForUser).not.toHaveBeenCalled();
  });

  it("fails the capture when the stubbed word still cannot be found", async () => {
    repo = makeRepo({ findWordBySlug: vi.fn(async () => null) });
    service = makeService(repo, repo, undefined, { insertMany: vi.fn(async () => undefined) } as unknown as IWordRepository);

    await expect(service.createSelectionCapture({
      userId: "u1",
      sourceId: "src-1",
      text: "A vivid context.",
      anchorStart: 0,
      anchorEnd: 16,
      surface: "vivid",
      wordSlug: "vivid",
    })).rejects.toThrow(/capture word upsert failed/);
    expect(repo.findWordBySlug).toHaveBeenCalledTimes(2);
  });

  it("rejects selection captures with a degenerate anchor range", async () => {
    await expect(service.createSelectionCapture({
      userId: "u1",
      sourceId: "src-1",
      text: "A vivid context.",
      anchorStart: 7,
      anchorEnd: 7,
      surface: "vivid",
      wordSlug: "vivid",
    })).rejects.toBeInstanceOf(ValidationError);
    expect(repo.findWordBySlug).not.toHaveBeenCalled();
  });

  it("rejects selection capture anchors outside the source content", async () => {
    repo = makeRepo({
      lockSourceByIdForUser: vi.fn(async () => ({
        ...SOURCE_ROW,
        content_text: "short",
      })),
    });
    service = makeService(repo);

    await expect(service.createSelectionCapture({
      userId: "u1",
      sourceId: "src-1",
      text: "A vivid context.",
      anchorStart: 0,
      anchorEnd: 16,
      surface: "vivid",
      wordSlug: "vivid",
    })).rejects.toThrow(/anchor range out of content bounds/);
    expect(repo.createContext).not.toHaveBeenCalled();
  });

  it("creates the quick-capture word context trio in one transaction", async () => {
    const txRunner = vi.fn(async (callback: (tx: never) => Promise<never>) => callback({} as never)) as unknown as typeof import("@/db/transaction").withTransaction;
    const txRepo = makeRepo();
    service = makeService(makeRepo(), txRepo, txRunner);

    await expect(service.createWordContextTrio({
      userId: "u1",
      slug: "vivid",
      text: "A vivid context.",
    })).resolves.toEqual({ sourceId: "src-1", contextId: "ctx-1", occurrenceId: "occ-1" });

    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(txRepo.findWordBySlug).toHaveBeenCalledWith("vivid");
    expect(txRepo.createSource).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "u1",
      wordbook_id: null,
      source_type: "manual",
      title: "手动记录",
      content_text: null,
    }), ["通用"]);
    expect(txRepo.createContext).toHaveBeenCalledWith(expect.objectContaining({
      source_id: "src-1",
      text: "A vivid context.",
      context_type: "sentence",
      position: {},
    }));
    expect(txRepo.createOccurrence).toHaveBeenCalledWith(expect.objectContaining({
      context_id: "ctx-1",
      word_id: "w1",
      surface: "vivid",
      start_offset: 2,
      end_offset: 7,
    }));
  });

  it("rejects the quick-capture trio for an unknown word slug", async () => {
    repo = makeRepo({ findWordBySlug: vi.fn(async () => null) });
    service = makeService(repo);

    await expect(service.createWordContextTrio({
      userId: "u1",
      slug: "missing",
      text: "A vivid context.",
    })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.createSource).not.toHaveBeenCalled();
  });

  it("lists sources through the actor-scoped repository with clamped paging", async () => {
    const txRepo = makeRepo({
      listSources: vi.fn(async () => ({ items: [], total: 0, limit: 50, offset: 0 })),
    });
    service = makeService(makeRepo(), txRepo);

    await expect(service.listSources({
      userId: "u1",
      sort: "recent",
      limit: 100,
      offset: -5,
    })).resolves.toEqual({ items: [], total: 0, limit: 50, offset: 0 });

    expect(txRepo.listSources).toHaveBeenCalledWith({
      userId: "u1",
      sourceType: undefined,
      q: undefined,
      sort: "recent",
      direction: null,
      space: null,
      limit: 50,
      offset: 0,
    });
  });

  it("lists occurrences and links through actor-scoped repositories with resolved filters", async () => {
    await service.listOccurrences({
      userId: "u1",
      slug: "vivid",
      direction: "雅思",
      space: "阅读",
      limit: 10,
    });
    expect(repo.findWordBySlug).toHaveBeenCalledWith("vivid");
    expect(repo.listOccurrences).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      slug: "vivid",
      direction: "雅思",
      space: "阅读",
    }));

    await service.listContextLinks({
      userId: "u1",
      wordId: "w1",
      linkType: "supports",
      limit: 10,
    });
    expect(repo.findWordById).toHaveBeenCalledWith("w1");
    expect(repo.listContextLinks).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      wordId: "w1",
      linkType: "supports",
    }));
  });

  it("rejects evidence list reads that point at missing words or contexts", async () => {
    service = makeService(makeRepo({ findWordBySlug: vi.fn(async () => null) }));
    await expect(service.listOccurrences({ userId: "u1", slug: "missing", limit: 10 }))
      .rejects.toBeInstanceOf(NotFoundError);

    service = makeService(makeRepo({ findWordById: vi.fn(async () => null) }));
    await expect(service.listContextLinks({ userId: "u1", wordId: "missing", limit: 10 }))
      .rejects.toBeInstanceOf(NotFoundError);

    service = makeService(makeRepo({ findContextById: vi.fn(async () => null) }));
    await expect(service.listOccurrences({ userId: "u1", contextId: "missing", limit: 10 }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects unknown two-axis values before any repository call", async () => {
    await expect(service.listOccurrences({ userId: "u1", space: "no-such" as never, limit: 10 }))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(service.listContextLinks({ userId: "u1", direction: "no-such" as never, limit: 10 }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(repo.listOccurrences).not.toHaveBeenCalled();
    expect(repo.listContextLinks).not.toHaveBeenCalled();
  });

  it("assembles the space summary and clamps the growth window to [1, 90]", async () => {
    repo = makeRepo({
      getSpaceSummaryCounts: vi.fn(async () => ({ sourceCount: 2, contextCount: 5, occurrenceCount: 7, linkCount: 1 })),
      getSpaceGrowth: vi.fn(async () => [{ day: "2026-09-08", sourceCount: 2, contextCount: 5, occurrenceCount: 7, linkCount: 1 }]),
    });
    service = makeService(repo);

    const summary = await service.getSpaceSummary({ userId: "u1", windowDays: 30 });
    expect(summary).toEqual({
      counts: { sourceCount: 2, contextCount: 5, occurrenceCount: 7, linkCount: 1 },
      growth: {
        windowDays: 30,
        byDay: [{ day: "2026-09-08", sourceCount: 2, contextCount: 5, occurrenceCount: 7, linkCount: 1 }],
      },
    });
    expect(repo.getSpaceGrowth).toHaveBeenCalledWith("u1", 30);

    await service.getSpaceSummary({ userId: "u1", windowDays: 200 });
    expect(repo.getSpaceGrowth).toHaveBeenLastCalledWith("u1", 90);

    await service.getSpaceSummary({ userId: "u1", windowDays: -5 });
    expect(repo.getSpaceGrowth).toHaveBeenLastCalledWith("u1", 1);
  });

  it("runs the space summary read under the actor and never writes", async () => {
    const txRunner = vi.fn(async (callback: (tx: never) => Promise<never>) => callback({} as never)) as unknown as typeof import("@/db/transaction").withTransaction;
    service = makeService(repo, repo, txRunner);

    await service.getSpaceSummary({ userId: "u1", windowDays: 30 });

    expect(txRunner).toHaveBeenCalledWith(expect.any(Function), { actorId: "u1" });
    expect(repo.getSpaceSummaryCounts).toHaveBeenCalledWith("u1");
    expect(repo.createSource).not.toHaveBeenCalled();
    expect(repo.createContext).not.toHaveBeenCalled();
    expect(repo.createOccurrence).not.toHaveBeenCalled();
    expect(repo.createContextLink).not.toHaveBeenCalled();
  });

  it("rejects an empty userId for the space summary read", async () => {
    await expect(service.getSpaceSummary({ userId: " ", windowDays: 30 }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(repo.getSpaceSummaryCounts).not.toHaveBeenCalled();
  });
});
