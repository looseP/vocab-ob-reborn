import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, ValidationError } from "@/errors";
import type {
  Json,
  L3ContextLinkRow,
  L3ContextRow,
  L3GraphReadModel,
  L3OccurrenceRow,
  L3SourceRow,
  WordRow,
  WordbookRow,
} from "@/domain";
import type { IL3ContextRepository } from "@/repositories/interfaces";
import { L3ReadService } from "@/services/l3-read.service";

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
  text: "A vivid context.",
  normalized_text: null,
  language: "en",
  position: {},
  metadata: {},
  created_at: "2026-07-08T00:00:00Z",
  updated_at: "2026-07-08T00:00:00Z",
};

const OCCURRENCE_ROW: L3OccurrenceRow = {
  id: "occ-1",
  context_id: "ctx-1",
  word_id: "w1",
  user_id: "u1",
  surface: "vivid",
  lemma: null,
  start_offset: 2,
  end_offset: 7,
  confidence: "0.9000",
  evidence: { method: "manual" },
  created_at: "2026-07-08T00:00:00Z",
};

function makeLink(overrides: Partial<L3ContextLinkRow>): L3ContextLinkRow {
  return {
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
    ...overrides,
  };
}

function makeGraphSeed(links: L3ContextLinkRow[] = []): L3GraphReadModel {
  return makeGraphSeedWith({ links });
}

function makeGraphSeedWith(overrides: {
  sources?: L3SourceRow[];
  contexts?: L3ContextRow[];
  occurrences?: L3OccurrenceRow[];
  links?: L3ContextLinkRow[];
} = {}): L3GraphReadModel {
  const sources = overrides.sources ?? [SOURCE_ROW];
  const contexts = overrides.contexts ?? [CONTEXT_ROW];
  const occurrences = overrides.occurrences ?? [OCCURRENCE_ROW];
  const links = overrides.links ?? [];
  return {
    nodes: [],
    edges: [],
    stats: {
      sourceCount: sources.length,
      contextCount: contexts.length,
      occurrenceCount: occurrences.length,
      linkCount: links.length,
      nodeCount: 0,
      edgeCount: 0,
    },
    limit: 100,
    cursor: null,
    nextCursor: null,
    metadata: {
      sources,
      contexts,
      occurrences,
      links,
    } as unknown as Json,
  };
}

function makeRepo(overrides: Partial<IL3ContextRepository> = {}): IL3ContextRepository {
  return {
    createSource: vi.fn(),
    createContext: vi.fn(),
    createOccurrence: vi.fn(),
    createContextLink: vi.fn(),
    createImportJob: vi.fn(),
    updateImportJobStatus: vi.fn(),
    findWordbookByIdForUser: vi.fn(async () => WORDBOOK_ROW),
    findSourceById: vi.fn(async () => SOURCE_ROW),
    findContextById: vi.fn(async () => CONTEXT_ROW),
    findContextWithSourceById: vi.fn(),
    findWordById: vi.fn(async () => WORD_ROW),
    findWordBySlug: vi.fn(async () => WORD_ROW),
    findWordInWordbookById: vi.fn(async () => WORD_ROW),
    findWordInWordbookBySlug: vi.fn(async () => WORD_ROW),
    listContextsForWord: vi.fn(),
    listContextsForSource: vi.fn(),
    getContextDetail: vi.fn(async () => ({
      context: CONTEXT_ROW,
      source: SOURCE_ROW,
      occurrences: [OCCURRENCE_ROW],
      links: [],
    })),
    getWordSpace: vi.fn(async () => ({
      word: WORD_ROW,
      contexts: [CONTEXT_ROW],
      sources: [SOURCE_ROW],
      occurrences: [OCCURRENCE_ROW],
      links: [],
      stats: { sourceCount: 1, contextCount: 1, occurrenceCount: 1, linkCount: 0 },
      limit: 50,
      cursor: null,
      nextCursor: null,
    })),
    getSourceSpace: vi.fn(async () => ({
      source: SOURCE_ROW,
      contexts: [CONTEXT_ROW],
      occurrences: [OCCURRENCE_ROW],
      links: [],
      stats: { sourceCount: 1, contextCount: 1, occurrenceCount: 1, linkCount: 0 },
      limit: 50,
      cursor: null,
      nextCursor: null,
    })),
    getGraph: vi.fn(async () => makeGraphSeed()),
    ...overrides,
  } as IL3ContextRepository;
}

let repo: IL3ContextRepository;
let service: L3ReadService;

beforeEach(() => {
  repo = makeRepo();
  service = new L3ReadService(repo);
});

describe("L3ReadService", () => {
  it("maps missing context detail to NotFoundError", async () => {
    repo = makeRepo({ getContextDetail: vi.fn(async () => null) });
    service = new L3ReadService(repo);

    await expect(service.getContextDetail({ userId: "u1", contextId: "missing" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("respects wordbook scope for word space reads", async () => {
    await service.getWordSpace({ userId: "u1", slug: "vivid", wordbookId: "wb-1", limit: 25 });

    expect(repo.findWordbookByIdForUser).toHaveBeenCalledWith("u1", "wb-1");
    expect(repo.getWordSpace).toHaveBeenCalledWith({
      userId: "u1",
      slug: "vivid",
      wordbookId: "wb-1",
      limit: 25,
      cursor: null,
    });
  });

  it("rejects missing wordbook before word space repository read", async () => {
    repo = makeRepo({ findWordbookByIdForUser: vi.fn(async () => null) });
    service = new L3ReadService(repo);

    await expect(service.getWordSpace({ userId: "u1", slug: "vivid", wordbookId: "foreign" })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.getWordSpace).not.toHaveBeenCalled();
  });

  it("validates graph bounds in service", async () => {
    await expect(service.getGraph({ userId: "u1", depth: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.getGraph({ userId: "u1", depth: -1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.getGraph({ userId: "u1", limit: 301 })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.getGraph({ userId: "u1", depth: 3 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects wordbook-scoped graph when slug is not in that wordbook before repository graph read", async () => {
    repo = makeRepo({ findWordInWordbookBySlug: vi.fn(async () => null) });
    service = new L3ReadService(repo);

    await expect(service.getGraph({ userId: "u1", wordbookId: "wb-1", slug: "foreign" })).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.findWordbookByIdForUser).toHaveBeenCalledWith("u1", "wb-1");
    expect(repo.findWordInWordbookBySlug).toHaveBeenCalledWith("wb-1", "foreign");
    expect(repo.getGraph).not.toHaveBeenCalled();
  });

  it("assembles stable graph nodes and edges with soft targets", async () => {
    const links = [
      makeLink({ id: "link-word", target_type: "word", target_id: "w2" }),
      makeLink({ id: "link-context", target_type: "context", target_id: "ctx-2" }),
      makeLink({ id: "link-source", target_type: "source", target_id: "src-2" }),
      makeLink({ id: "link-l2", target_type: "l2_item", target_ref: { field: "corpus", contentId: "l2-1" } }),
      makeLink({ id: "link-topic", target_type: "topic", target_ref: { label: "weather" } }),
      makeLink({ id: "link-external", target_type: "external", target_ref: { url: "https://example.com" } }),
    ];
    repo = makeRepo({ getGraph: vi.fn(async () => makeGraphSeed(links)) });
    service = new L3ReadService(repo);

    const result = await service.getGraph({ userId: "u1", wordbookId: "wb-1", slug: "vivid", sourceId: "src-1" });

    expect(result.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "word:w1",
      "word:w2",
      "context:ctx-1",
      "context:ctx-2",
      "source:src-1",
      "source:src-2",
      "l2_item:l2-1",
      expect.stringMatching(/^topic:/),
      expect.stringMatching(/^external:/),
    ]));
    expect(result.edges.map((edge) => edge.id)).toEqual(expect.arrayContaining([
      "belongs_to:ctx-1:src-1",
      expect.stringMatching(/^occurs_in:/),
      expect.stringMatching(/^context_link:/),
    ]));
    expect(result.stats).toMatchObject({ sourceCount: 1, contextCount: 1, occurrenceCount: 1, linkCount: 6 });
    expect(repo.getGraph).toHaveBeenCalledWith(expect.objectContaining({
      userId: "u1",
      wordbookId: "wb-1",
      slug: "vivid",
      sourceId: "src-1",
      depth: 1,
      limit: 100,
    }));
  });

  it("deduplicates semantic occurrence and context-link edges", async () => {
    const duplicateOccurrences = [
      OCCURRENCE_ROW,
      { ...OCCURRENCE_ROW, id: "occ-duplicate-row" },
    ];
    const duplicateLinks = [
      makeLink({ id: "link-a", link_type: "illustrates", target_type: "external", target_ref: { url: "https://example.com" } }),
      makeLink({ id: "link-b", link_type: "illustrates", target_type: "external", target_ref: { url: "https://example.com" } }),
    ];
    repo = makeRepo({ getGraph: vi.fn(async () => makeGraphSeedWith({ occurrences: duplicateOccurrences, links: duplicateLinks })) });
    service = new L3ReadService(repo);

    const result = await service.getGraph({ userId: "u1" });

    expect(result.edges.filter((edge) => edge.type === "occurs_in")).toHaveLength(1);
    expect(result.edges.filter((edge) => edge.type === "illustrates")).toHaveLength(1);
    expect(result.stats).toMatchObject({ occurrenceCount: 2, linkCount: 2, edgeCount: 3 });
  });

  it("orders graph output deterministically independent of seed ordering", async () => {
    const sourceTwo: L3SourceRow = { ...SOURCE_ROW, id: "src-2", title: "Archive", source_type: "manual" };
    const contextTwo: L3ContextRow = {
      ...CONTEXT_ROW,
      id: "ctx-2",
      source_id: "src-2",
      text: "Another vivid context.",
    };
    const occurrenceTwo: L3OccurrenceRow = {
      ...OCCURRENCE_ROW,
      id: "occ-2",
      context_id: "ctx-2",
      surface: "another",
      start_offset: 0,
      end_offset: 7,
    };
    const linkTopic = makeLink({ id: "link-topic", context_id: "ctx-2", target_type: "topic", target_ref: { label: "weather" } });
    const linkExternal = makeLink({ id: "link-external", target_type: "external", target_ref: { url: "https://example.com" } });
    const seedA = makeGraphSeedWith({
      sources: [sourceTwo, SOURCE_ROW],
      contexts: [contextTwo, CONTEXT_ROW],
      occurrences: [occurrenceTwo, OCCURRENCE_ROW],
      links: [linkTopic, linkExternal],
    });
    const seedB = makeGraphSeedWith({
      sources: [SOURCE_ROW, sourceTwo],
      contexts: [CONTEXT_ROW, contextTwo],
      occurrences: [OCCURRENCE_ROW, occurrenceTwo],
      links: [linkExternal, linkTopic],
    });
    repo = makeRepo({ getGraph: vi.fn().mockResolvedValueOnce(seedA).mockResolvedValueOnce(seedB) });
    service = new L3ReadService(repo);

    const first = await service.getGraph({ userId: "u1" });
    const second = await service.getGraph({ userId: "u1" });

    expect(first.nodes.map((node) => node.id)).toEqual(second.nodes.map((node) => node.id));
    expect(first.edges.map((edge) => edge.id)).toEqual(second.edges.map((edge) => edge.id));
    expect(first.nodes.map((node) => node.type)).toEqual(["word", "context", "context", "source", "source", "topic", "external"]);
  });
});
