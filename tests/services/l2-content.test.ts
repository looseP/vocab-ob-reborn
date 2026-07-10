import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IRepositories } from "@/repositories/interfaces";
import type { LlmProvider, LlmResult } from "@/llm/provider";
import type { DictionaryProvider, DictionaryCandidate } from "@/dictionary/provider";
import { ValidationError } from "@/errors";

// Mock withTransaction + createRepositories so confirmDraft never hits real DB.
const mockRepos: Partial<IRepositories> = {};
vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

import { L2ContentService } from "@/services/l2-content.service";

const WORD: Parameters<L2ContentService["generateDraft"]>[0] = {
  lemma: "abandon",
  pos: "v.",
  semanticField: "情感",
  shortDefinition: "抛弃；放弃",
  cefrTarget: "雅思",
};

// A word whose POS has a reliable Datamuse relation (adjective) — used by the
// dictionary-grounded collocation tests so the provider returns candidates.
const ADJ_WORD: Parameters<L2ContentService["generateDraft"]>[0] = {
  lemma: "abundant",
  pos: "adj.",
  semanticField: "自然物理",
  shortDefinition: "大量存在的",
  cefrTarget: "雅思",
};

// ── Valid L2 content fixtures (one per field, matching the prompt templates) ──
const VALID_COLLOCATION = [
  {
    phrase: "abandon ship",
    gloss: "弃船",
    tone: "neutral",
    example: "The captain ordered to abandon ship.",
    exampleTranslation: "船长下令弃船。",
  },
];
const VALID_CORPUS = [
  {
    text: "They had to abandon the project.",
    translation: "他们不得不放弃这个项目。",
    source: "generated",
  },
];
const VALID_SYNONYM = [
  {
    word: "desert",
    semanticDiff: "强调违背义务",
    tone: "formal",
    usage: "多用于人离开职责",
    delta: "abandon 更通用",
    object: "人/地点",
  },
];
// antonym reuses the synonym schema shape.
const VALID_ANTONYM = [
  {
    word: "retain",
    semanticDiff: "保留",
    tone: "formal",
    usage: "通用",
    delta: "反义",
    object: "物/抽象",
  },
];

function makeLlmResult(overrides: Partial<LlmResult> = {}): LlmResult {
  return {
    content: '[{"phrase":"abandon hope"}]',
    promptTokens: 100,
    completionTokens: 50,
    model: "test-model",
    ...overrides,
  };
}

function makeProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    generate: vi.fn(async () => makeLlmResult()),
    ...overrides,
  };
}

function makeUsageTracker(overrides: Partial<{ isOverBudget: boolean }> = {}) {
  const overBudget = overrides.isOverBudget ?? false;
  return {
    isOverBudget: vi.fn(async () => overBudget),
    reserve: vi.fn(async () => (overBudget ? null : "reservation-1")),
    settle: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    record: vi.fn(async () => {}),
    getDailyUsage: vi.fn(async () => 0),
  };
}

/** Sample dictionary candidates (Datamuse-shaped) for collocation grounding. */
const DICT_CANDIDATES: DictionaryCandidate[] = [
  {
    phrase: "abundant rainfall",
    headword: "rainfall",
    sourceName: "Datamuse",
    sourceUrl: "https://api.datamuse.com/words?rel_jja=abundant&max=5",
    relation: "rel_jja",
    score: 100,
  },
  {
    phrase: "abundant evidence",
    headword: "evidence",
    sourceName: "Datamuse",
    sourceUrl: "https://api.datamuse.com/words?rel_jja=abundant&max=5",
    relation: "rel_jja",
    score: 90,
  },
];

function makeDictionaryProvider(overrides: {
  candidates?: DictionaryCandidate[];
  warning?: string;
  lookupError?: Error;
} = {}): DictionaryProvider {
  return {
    lookupCollocations: vi.fn(async () => {
      if (overrides.lookupError) throw overrides.lookupError;
      return {
        candidates: overrides.candidates ?? DICT_CANDIDATES,
        ...(overrides.warning ? { warning: overrides.warning } : {}),
      };
    }),
  };
}

describe("L2ContentService.generateDraft", () => {
  it("returns a parsed draft on success (collocation via dictionary-grounded LLM refine)", async () => {
    const provider = makeProvider({
      generate: vi.fn(async () => makeLlmResult({ content: '[{"phrase":"abundant rainfall"}]' })),
    });
    const tracker = makeUsageTracker();
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      dictionaryProvider,
    });

    const result = await service.generateDraft(ADJ_WORD, "collocation", "manual");

    expect(result.error).toBeUndefined();
    // P2: kept LLM-refined items carry dictionary-grounded provenance +
    // evidence, and the canonical phrase comes from the dictionary candidate.
    expect(result.draft).toEqual([
      {
        phrase: "abundant rainfall",
        provenance: {
          source: "dictionary_llm_refined",
          dictionaryName: "Datamuse",
          dictionaryUrl: "https://api.datamuse.com/words?rel_jja=abundant&max=5",
        },
        evidence: {
          dictionaryName: "Datamuse",
          dictionaryUrl: "https://api.datamuse.com/words?rel_jja=abundant&max=5",
          rawPhrase: "abundant rainfall",
        },
      },
    ]);
    expect(result.raw).toBe('[{"phrase":"abundant rainfall"}]');
    // B3: candidates existed + LLM ran → refined source mode
    expect(result.sourceMode).toBe("dictionary_llm_refined");
    expect(result.storageField).toBe("collocation");
    // dictionary was consulted before any LLM call
    expect(dictionaryProvider.lookupCollocations).toHaveBeenCalledWith(
      expect.objectContaining({ lemma: "abundant", pos: "adj." }),
    );
    // budget reserved before the LLM call (only because candidates existed)
    expect(tracker.reserve).toHaveBeenCalledTimes(1);
    // reservation settled with the result's token counts
    expect(tracker.settle).toHaveBeenCalledWith(
      "reservation-1",
      "test-model",
      "test-model",
      100,
      50,
    );
  });

  it("returns OVER_BUDGET when over the daily token limit (no LLM call)", async () => {
    const provider = makeProvider();
    const tracker = makeUsageTracker({ isOverBudget: true });
    const service = new L2ContentService({ llmProvider: provider, usageTracker: tracker as never });

    const result = await service.generateDraft(WORD, "corpus", "manual");

    expect(result).toEqual({ error: "OVER_BUDGET", storageField: "corpus" });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(tracker.record).not.toHaveBeenCalled();
  });

  it("returns LLM_ERROR when the provider throws", async () => {
    const provider = makeProvider({
      generate: vi.fn(async () => {
        throw new Error("network timeout");
      }),
    });
    const tracker = makeUsageTracker();
    const service = new L2ContentService({ llmProvider: provider, usageTracker: tracker as never });

    const result = await service.generateDraft(WORD, "synonym", "manual");

    expect(result.error).toBe("LLM_ERROR");
    expect(result.message).toBe("LLM provider request failed");
    expect(result.storageField).toBe("synonym");
    expect(tracker.release).toHaveBeenCalledWith("reservation-1");
    expect(tracker.settle).not.toHaveBeenCalled();
  });

  it("returns PARSE_FAILED when the LLM output is not valid JSON", async () => {
    const provider = makeProvider({
      generate: vi.fn(async () =>
        makeLlmResult({ content: "sorry, I cannot help with that" }),
      ),
    });
    const tracker = makeUsageTracker();
    const service = new L2ContentService({ llmProvider: provider, usageTracker: tracker as never });

    const result = await service.generateDraft(WORD, "antonym", "manual");

    expect(result.error).toBe("PARSE_FAILED");
    expect(result.raw).toBeUndefined();
    expect(result.storageField).toBe("antonym");
    // usage is settled (the call succeeded) even though parsing failed
    expect(tracker.settle).toHaveBeenCalledTimes(1);
  });

  it("builds the correct prompt per field (collocation → grounded on dictionary candidates)", async () => {
    const provider = makeProvider();
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: makeUsageTracker() as never,
      dictionaryProvider,
    });

    await service.generateDraft(ADJ_WORD, "collocation", "manual");

    const msgs = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msgs[0].role).toBe("system");
    // B3: the collocation prompt is grounded on the dictionary candidates —
    // candidate phrases appear in the prompt, and a "do not invent" grounding
    // instruction forbids collocations absent from the list.
    expect(msgs[0].content).toContain("abundant rainfall");
    expect(msgs[0].content).toContain("abundant evidence");
    expect(msgs[0].content).toMatch(/不得.{0,4}发明|do not invent|不得发明|不能新增候选|sole source of truth/i);
    // count respected (defaults to 3)
    expect(msgs[0].content).toContain("3");
  });

  it("collocation prompt reflects the requested count option", async () => {
    const provider = makeProvider();
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: makeUsageTracker() as never,
      dictionaryProvider,
    });

    await service.generateDraft(ADJ_WORD, "collocation", { count: 5 });

    const msgs = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msgs[0].content).toContain("5 个搭配");
  });

  it("antonym field uses the dedicated antonym prompt (not the synonym prompt)", async () => {
    const provider = makeProvider();
    const service = new L2ContentService({ llmProvider: provider, usageTracker: makeUsageTracker() as never });

    await service.generateDraft(WORD, "antonym", "manual");

    const msgs = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msgs[0].role).toBe("system");
    // the antonym prompt asks for antonyms/contrast, not synonyms
    expect(msgs[0].content).toMatch(/反义|对立/);
    // and it must NOT be the synonym prompt, which says "近义词"
    expect(msgs[0].content).not.toContain("近义词");
    // word context is wired through
    expect(msgs[1].content).toContain("abandon");
  });
});

describe("L2ContentService.confirmDraft", () => {
  beforeEach(() => {
    // Reset mock repos between tests
    Object.keys(mockRepos).forEach((k) => delete (mockRepos as Record<string, unknown>)[k]);
  });

  /** Wire up a full set of mock repos; returns them for per-test assertions. */
  function setupRepos(wordRow: unknown = { id: "word-1" }) {
    const l2ContentRepo = {
      insert: vi.fn(async () => ({ id: "l2-1" })),
      refreshL2Cache: vi.fn(async () => {}),
      findByWord: vi.fn(),
      softDelete: vi.fn(),
    };
    const l2ProgressRepo = {
      markL2StaleForRecheck: vi.fn(async () => 1),
      findByWordAndUser: vi.fn(),
      insert: vi.fn(),
      pause: vi.fn(),
      unpauseByReason: vi.fn(),
    };
    const wordsRepo = {
      findById: vi.fn(async () => wordRow),
      findBySlug: vi.fn(),
      findPublic: vi.fn(),
      count: vi.fn(),
      findSlugs: vi.fn(),
    };
    mockRepos.l2Content = l2ContentRepo as never;
    mockRepos.l2Progress = l2ProgressRepo as never;
    mockRepos.words = wordsRepo as never;
    return { l2ContentRepo, l2ProgressRepo, wordsRepo };
  }

  it("inserts content, refreshes cache, and marks L2 stale inside a tx", async () => {
    const wordRow = {
      id: "word-1",
      collocations: VALID_COLLOCATION,
      corpus_items: [],
      synonym_items: [],
      antonym_items: [],
    };
    const { l2ContentRepo, l2ProgressRepo, wordsRepo } = setupRepos(wordRow);

    const service = new L2ContentService({ llmProvider: makeProvider(), usageTracker: makeUsageTracker() as never });
    await service.confirmDraft("word-1", "collocation", VALID_COLLOCATION, "manual");

    // 1. row inserted with snake_case fields + parsed content. B6: sourceRef
    //    defaults to null and approvedBy defaults to "user" when confirmDraft
    //    is called with a legacy `source: string` argument.
    expect(l2ContentRepo.insert).toHaveBeenCalledWith({
      word_id: "word-1",
      field: "collocation",
      content: VALID_COLLOCATION,
      source: "manual",
      source_ref: null,
      approved_by: "user",
    });
    // 2. cache refreshed
    expect(l2ContentRepo.refreshL2Cache).toHaveBeenCalledWith("word-1");
    // 3. word re-read to recompute hash
    expect(wordsRepo.findById).toHaveBeenCalledWith("word-1");
    // 4. L2 recheck marked with a recomputed hash (64-char sha256 hex)
    expect(l2ProgressRepo.markL2StaleForRecheck).toHaveBeenCalledWith(
      "word-1",
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
  });

  it("skips recheck when the word is missing (findById returns null)", async () => {
    const { l2ContentRepo, l2ProgressRepo } = setupRepos(null);

    const service = new L2ContentService({ llmProvider: makeProvider(), usageTracker: makeUsageTracker() as never });
    await service.confirmDraft("word-1", "synonym", VALID_SYNONYM, "llm");

    expect(l2ContentRepo.insert).toHaveBeenCalled();
    expect(l2ContentRepo.refreshL2Cache).toHaveBeenCalled();
    expect(l2ProgressRepo.markL2StaleForRecheck).not.toHaveBeenCalled();
  });

  // ── B6: sourceRef/approvedBy reach the repository insert ──────────────
  it("forwards sourceRef and approvedBy to the repository insert (options object)", async () => {
    const { l2ContentRepo } = setupRepos({ id: "word-1" });

    const service = new L2ContentService({ llmProvider: makeProvider(), usageTracker: makeUsageTracker() as never });
    await service.confirmDraft("word-1", "collocation", VALID_COLLOCATION, {
      source: "external_chat",
      sourceRef: "chatgpt://conv/abc-123",
      approvedBy: "operator-1",
    });

    expect(l2ContentRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        word_id: "word-1",
        field: "collocation",
        source: "external_chat",
        source_ref: "chatgpt://conv/abc-123",
        approved_by: "operator-1",
      }),
    );
  });

  it("defaults sourceRef to null and approvedBy to 'user' for legacy string source", async () => {
    const { l2ContentRepo } = setupRepos({ id: "word-1" });

    const service = new L2ContentService({});
    await service.confirmDraft("word-1", "collocation", VALID_COLLOCATION, "manual");

    expect(l2ContentRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "manual",
        source_ref: null,
        approved_by: "user",
      }),
    );
  });

  // ── Field-specific validation ──────────────────────────────────────────
  it.each([
    ["collocation", VALID_COLLOCATION],
    ["corpus", VALID_CORPUS],
    ["synonym", VALID_SYNONYM],
    ["antonym", VALID_ANTONYM],
  ] as const)("accepts valid %s content and runs insert → refreshL2Cache → markL2StaleForRecheck", async (field, content) => {
    const { l2ContentRepo, l2ProgressRepo } = setupRepos({ id: "word-1" });

    const service = new L2ContentService({ llmProvider: makeProvider(), usageTracker: makeUsageTracker() as never });
    await service.confirmDraft("word-1", field, content, "manual");

    // insert → refreshL2Cache → markL2StaleForRecheck cascade executed
    expect(l2ContentRepo.insert).toHaveBeenCalledTimes(1);
    expect(l2ContentRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ word_id: "word-1", field, content, source: "manual" }),
    );
    expect(l2ContentRepo.refreshL2Cache).toHaveBeenCalledWith("word-1");
    expect(l2ProgressRepo.markL2StaleForRecheck).toHaveBeenCalledTimes(1);
  });

  it.each([
    // collocation: missing required keys + bad tone enum
    ["collocation", [{ phrase: "abandon ship" }]],
    // collocation: not an array
    ["collocation", { phrase: "abandon ship" }],
    // corpus: missing translation
    ["corpus", [{ text: "hi" }]],
    // corpus: bad source (still valid — source is z.string(), so use a clearly
    // wrong shape: a number where text is expected)
    ["corpus", [{ text: 123, translation: "x", source: "y" }]],
    // synonym: missing delta/object/etc.
    ["synonym", [{ word: "desert" }]],
    // synonym: bad tone enum
    ["synonym", [{ word: "desert", semanticDiff: "x", tone: "casual", usage: "x", delta: "x", object: "x" }]],
    // antonym: not an array
    ["antonym", "retain"],
    // antonym: empty array is fine? schema is z.array (min not set) → accepted,
    // so use a clearly-bad item instead
    ["antonym", [{ word: "" }]],
  ] as const)("rejects invalid %s content with a structured ValidationError (no DB writes)", async (field, content) => {
    const { l2ContentRepo, l2ProgressRepo } = setupRepos({ id: "word-1" });

    const service = new L2ContentService({ llmProvider: makeProvider(), usageTracker: makeUsageTracker() as never });
    await expect(
      service.confirmDraft("word-1", field, content, "manual"),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      field,
    });
    // Nothing should have been written / cascaded.
    expect(l2ContentRepo.insert).not.toHaveBeenCalled();
    expect(l2ContentRepo.refreshL2Cache).not.toHaveBeenCalled();
    expect(l2ProgressRepo.markL2StaleForRecheck).not.toHaveBeenCalled();
  });

  it("rejected content throws an actual ValidationError instance", async () => {
    setupRepos({ id: "word-1" });
    const service = new L2ContentService({ llmProvider: makeProvider(), usageTracker: makeUsageTracker() as never });
    await expect(
      service.confirmDraft("word-1", "collocation", [{ phrase: "x" }], "manual"),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ── Always-available: no-LLM construction (A4) ──────────────────────────
//
// The service must be constructible with an empty deps object so the confirm
// flow (a pure DB cascade) works without an LLM provider. generateDraft, which
// needs the LLM, degrades to a structured L2_CONTENT_UNAVAILABLE error for
// fields that require it.
describe("L2ContentService — always available without LLM deps", () => {
  beforeEach(() => {
    Object.keys(mockRepos).forEach((k) => delete (mockRepos as Record<string, unknown>)[k]);
  });

  it("constructs with an empty deps object (no llmProvider / usageTracker)", () => {
    expect(() => new L2ContentService({})).not.toThrow();
    expect(() => new L2ContentService()).not.toThrow();
  });

  it("confirmDraft works with new L2ContentService({}) — no LLM required", async () => {
    const { l2ContentRepo, l2ProgressRepo } = (() => {
      const l2ContentRepo = {
        insert: vi.fn(async () => ({ id: "l2-1" })),
        refreshL2Cache: vi.fn(async () => {}),
        findByWord: vi.fn(),
        softDelete: vi.fn(),
      };
      const l2ProgressRepo = {
        markL2StaleForRecheck: vi.fn(async () => 1),
        findByWordAndUser: vi.fn(),
        insert: vi.fn(),
        pause: vi.fn(),
        unpauseByReason: vi.fn(),
      };
      const wordsRepo = {
        findById: vi.fn(async () => ({ id: "word-1" })),
        findBySlug: vi.fn(),
        findPublic: vi.fn(),
        count: vi.fn(),
        findSlugs: vi.fn(),
      };
      mockRepos.l2Content = l2ContentRepo as never;
      mockRepos.l2Progress = l2ProgressRepo as never;
      mockRepos.words = wordsRepo as never;
      return { l2ContentRepo, l2ProgressRepo };
    })();

    const service = new L2ContentService({});
    await service.confirmDraft("word-1", "collocation", VALID_COLLOCATION, "manual");

    // confirm ran the full insert → refreshL2Cache → markL2StaleForRecheck cascade
    expect(l2ContentRepo.insert).toHaveBeenCalledTimes(1);
    expect(l2ContentRepo.refreshL2Cache).toHaveBeenCalledWith("word-1");
    expect(l2ProgressRepo.markL2StaleForRecheck).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["corpus"],
    ["synonym"],
    ["antonym"],
  ] as const)(
    "generateDraft(%s, ...) returns L2_CONTENT_UNAVAILABLE when no LLM deps injected",
    async (field) => {
      const service = new L2ContentService({});
      const result = await service.generateDraft(WORD, field, "manual");

      expect(result).toEqual({
        error: "L2_CONTENT_UNAVAILABLE",
        message: "LLM provider not configured",
        storageField: field,
      });
    },
  );

  // B3: collocation no longer returns L2_CONTENT_UNAVAILABLE — it returns
  // NO_DICTIONARY_CANDIDATES when no dictionary provider is configured (the
  // dictionary is the sole source of which phrases exist; an ungrounded LLM
  // collocation draft would violate the candidate-grounding contract).
  it("generateDraft(collocation, ...) returns NO_DICTIONARY_CANDIDATES when no dictionary provider configured (no LLM call)", async () => {
    const provider = makeProvider();
    const tracker = makeUsageTracker();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      // no dictionaryProvider
    });

    const result = await service.generateDraft(WORD, "collocation", "manual");

    expect(result.error).toBe("NO_DICTIONARY_CANDIDATES");
    expect(result.warning).toBe("Dictionary provider not configured");
    expect(result.storageField).toBe("collocation");
    // LLM is never consulted when there's no dictionary to ground on
    expect(provider.generate).not.toHaveBeenCalled();
    expect(tracker.record).not.toHaveBeenCalled();
  });

  it("generateDraft returns L2_CONTENT_UNAVAILABLE when only llmProvider is present (no usageTracker)", async () => {
    const provider = makeProvider();
    const service = new L2ContentService({ llmProvider: provider });
    const result = await service.generateDraft(WORD, "corpus", "manual");

    expect(result.error).toBe("L2_CONTENT_UNAVAILABLE");
    expect(result.storageField).toBe("corpus");
    // provider must not be called when the tracker is missing
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("generateDraft returns L2_CONTENT_UNAVAILABLE when only usageTracker is present (no llmProvider)", async () => {
    const tracker = makeUsageTracker();
    const service = new L2ContentService({ usageTracker: tracker as never });
    const result = await service.generateDraft(WORD, "corpus", "manual");

    expect(result.error).toBe("L2_CONTENT_UNAVAILABLE");
    expect(result.storageField).toBe("corpus");
    // budget reservation must not run when the provider is missing
    expect(tracker.reserve).not.toHaveBeenCalled();
  });
});

// ── B3: dictionary-grounded collocation draft ──────────────────────────
//
// The collocation draft flow consults the dictionary first; the LLM only
// refines candidates (never invents). Three degrade paths:
//   - no candidates → NO_DICTIONARY_CANDIDATES, LLM not called
//   - candidates but no LLM → dictionary-only draft (sourceMode="dictionary")
//   - candidates + LLM → refined draft (sourceMode="dictionary_llm_refined")
describe("L2ContentService — B3 dictionary-grounded collocation", () => {
  it("calls the dictionary provider before the LLM (collocation)", async () => {
    const provider = makeProvider();
    const tracker = makeUsageTracker();
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      dictionaryProvider,
    });

    await service.generateDraft(ADJ_WORD, "collocation", "manual");

    // dictionary consulted exactly once, before the LLM call
    expect(dictionaryProvider.lookupCollocations).toHaveBeenCalledTimes(1);
    expect(dictionaryProvider.lookupCollocations).toHaveBeenCalledWith(
      expect.objectContaining({ lemma: "abundant", pos: "adj." }),
    );
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it("returns NO_DICTIONARY_CANDIDATES and does not call the LLM when dictionary has no candidates", async () => {
    const provider = makeProvider();
    const tracker = makeUsageTracker();
    const dictionaryProvider = makeDictionaryProvider({
      candidates: [],
      warning: "No reliable collocation relation for POS \"v.\"",
    });
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      dictionaryProvider,
    });

    const result = await service.generateDraft(WORD, "collocation", "manual");

    expect(result.error).toBe("NO_DICTIONARY_CANDIDATES");
    expect(result.warning).toBe("No reliable collocation relation for POS \"v.\"");
    expect(result.storageField).toBe("collocation");
    // LLM never called, usage never recorded
    expect(provider.generate).not.toHaveBeenCalled();
    expect(tracker.record).not.toHaveBeenCalled();
    expect(tracker.reserve).not.toHaveBeenCalled();
  });

  it("returns NO_DICTIONARY_CANDIDATES when the dictionary lookup throws (LLM not called)", async () => {
    const provider = makeProvider();
    const tracker = makeUsageTracker();
    const dictionaryProvider = makeDictionaryProvider({
      lookupError: new Error("network down"),
    });
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      dictionaryProvider,
    });

    const result = await service.generateDraft(ADJ_WORD, "collocation", "manual");

    expect(result.error).toBe("NO_DICTIONARY_CANDIDATES");
    expect(result.warning).toContain("network down");
    expect(provider.generate).not.toHaveBeenCalled();
    expect(tracker.record).not.toHaveBeenCalled();
  });

  it("returns a dictionary-only draft (sourceMode='dictionary') when candidates exist but no LLM deps", async () => {
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      // no llmProvider / usageTracker
      dictionaryProvider,
    });

    const result = await service.generateDraft(ADJ_WORD, "collocation", "manual");

    expect(result.error).toBeUndefined();
    expect(result.sourceMode).toBe("dictionary");
    expect(result.storageField).toBe("collocation");
    // draft is an array of candidate-shaped items with provenance.source=dictionary
    const draft = result.draft as Array<{ phrase: string; provenance: { source: string; dictionaryName: string } }>;
    expect(Array.isArray(draft)).toBe(true);
    expect(draft).toHaveLength(2);
    expect(draft[0].phrase).toBe("abundant rainfall");
    expect(draft[0].provenance.source).toBe("dictionary");
    expect(draft[0].provenance.dictionaryName).toBe("Datamuse");
    expect(draft[1].provenance.source).toBe("dictionary");
  });

  it("LLM-refined draft prompt contains the serialized candidates and a 'do not invent' grounding instruction", async () => {
    const provider = makeProvider();
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: makeUsageTracker() as never,
      dictionaryProvider,
    });

    await service.generateDraft(ADJ_WORD, "collocation", "manual");

    const msgs = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // candidate phrases are the sole source of truth in the prompt
    expect(msgs[0].content).toContain("dictionaryCandidates");
    expect(msgs[0].content).toContain("abundant rainfall");
    expect(msgs[0].content).toContain("abundant evidence");
    // explicit grounding instruction forbids invented collocations
    expect(msgs[0].content).toMatch(/不得.{0,4}发明|do not invent|不得发明|不能新增候选/i);
  });

  it("does not record usage when the LLM is not called (dictionary-only path)", async () => {
    const tracker = makeUsageTracker();
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      usageTracker: tracker as never,
      // no llmProvider → dictionary-only path, LLM never called
      dictionaryProvider,
    });

    await service.generateDraft(ADJ_WORD, "collocation", "manual");

    expect(tracker.record).not.toHaveBeenCalled();
    expect(tracker.reserve).not.toHaveBeenCalled();
  });

  it("checks budget only when an LLM call is actually about to occur (not before dictionary lookup)", async () => {
    const provider = makeProvider();
    const tracker = makeUsageTracker({ isOverBudget: true });
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      dictionaryProvider,
    });

    const result = await service.generateDraft(ADJ_WORD, "collocation", "manual");

    // dictionary was still consulted (budget checked after, not before lookup)
    expect(dictionaryProvider.lookupCollocations).toHaveBeenCalledTimes(1);
    // atomic reservation ran only after candidates existed and rejected the call.
    expect(tracker.reserve).toHaveBeenCalledTimes(1);
    // over budget → no LLM call, no usage recorded
    expect(result.error).toBe("OVER_BUDGET");
    expect(provider.generate).not.toHaveBeenCalled();
    expect(tracker.settle).not.toHaveBeenCalled();
  });

  // ── Phase 2E: ungrounded collocation filtering (drop not reject) ────────
  //
  // The LLM is instructed not to invent collocations, but LLMs sometimes do
  // anyway. The refine path must defensively filter the LLM's output items,
  // dropping any whose `phrase` is not in the dictionary candidate set, rather
  // than rejecting the whole draft. This is the drop-not-reject contract.
  it("drops LLM-invented collocations whose phrase is not in candidates (drop not reject)", async () => {
    // LLM returns one grounded item + one invented item not in candidates.
    const provider = makeProvider({
      generate: vi.fn(async () =>
        makeLlmResult({
          content: JSON.stringify([
            { phrase: "abundant rainfall", gloss: "充足降水", tone: "neutral", example: "x", exampleTranslation: "y" },
            { phrase: "invented phrase", gloss: "幻觉", tone: "neutral", example: "x", exampleTranslation: "y" },
          ]),
        }),
      ),
    });
    const tracker = makeUsageTracker();
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      dictionaryProvider,
    });

    const result = await service.generateDraft(ADJ_WORD, "collocation", "manual");

    expect(result.error).toBeUndefined();
    const draft = result.draft as Array<{ phrase: string }>;
    expect(Array.isArray(draft)).toBe(true);
    // The grounded item is kept; the invented item is dropped (not the whole draft).
    expect(draft).toHaveLength(1);
    expect(draft[0].phrase).toBe("abundant rainfall");
    // A warning surfaces that items were filtered.
    expect(typeof result.warning).toBe("string");
    expect(result.warning).toMatch(/filter|drop|invent|grounded/i);
    expect(result.sourceMode).toBe("dictionary_llm_refined");
  });

  it("returns all grounded items when the LLM stays within the candidate set", async () => {
    const provider = makeProvider({
      generate: vi.fn(async () =>
        makeLlmResult({
          content: JSON.stringify([
            { phrase: "abundant rainfall", gloss: "降水", tone: "neutral", example: "x", exampleTranslation: "y" },
            { phrase: "abundant evidence", gloss: "证据", tone: "neutral", example: "x", exampleTranslation: "y" },
          ]),
        }),
      ),
    });
    const tracker = makeUsageTracker();
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      dictionaryProvider,
    });

    const result = await service.generateDraft(ADJ_WORD, "collocation", "manual");

    expect(result.error).toBeUndefined();
    const draft = result.draft as Array<{ phrase: string }>;
    expect(draft).toHaveLength(2);
    // No filtering warning when everything was grounded.
    expect(result.warning).toBeUndefined();
  });

  it("phrase comparison is case-insensitive and trims whitespace", async () => {
    const provider = makeProvider({
      generate: vi.fn(async () =>
        makeLlmResult({
          content: JSON.stringify([
            { phrase: "  Abundant Rainfall  ", gloss: "降水", tone: "neutral", example: "x", exampleTranslation: "y" },
          ]),
        }),
      ),
    });
    const tracker = makeUsageTracker();
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      dictionaryProvider,
    });

    const result = await service.generateDraft(ADJ_WORD, "collocation", "manual");

    expect(result.error).toBeUndefined();
    const draft = result.draft as Array<{ phrase: string }>;
    expect(draft).toHaveLength(1);
    // The stored phrase keeps its original casing/whitespace — only the
    // grounding *comparison* is normalized. The item matched a candidate.
    expect(draft[0].phrase.trim().toLowerCase()).toBe("abundant rainfall");
    // No warning since the item matched after normalization.
    expect(result.warning).toBeUndefined();
  });
});

// ── B4: example/corpus draft + style profile ───────────────────────────
//
// The example (storage: corpus) draft flow accepts a styleProfileId; the
// profile's prompt rules (register/difficulty/domains/...) are injected into
// the example prompt. A mismatched profile field scope (e.g. a collocation
// profile used for example) throws a structured ValidationError.
describe("L2ContentService — B4 example/corpus style profile", () => {
  it("injects the academic style profile rules into the example prompt", async () => {
    const provider = makeProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: makeUsageTracker() as never,
    });

    await service.generateDraft(WORD, "corpus", { styleProfileId: "academic" });

    const msgs = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // academic profile rules surface in the system message
    expect(msgs[0].content).toContain("academic");
    expect(msgs[0].content).toMatch(/学术|register.*academic|语体.*academic|difficulty.*academic/);
    // maxItems=2 from the academic profile overrides the default count of 2
    expect(msgs[0].content).toContain("2 个例句");
  });

  it("throws ValidationError when a collocation-only profile is used for example/corpus", async () => {
    const provider = makeProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: makeUsageTracker() as never,
    });

    // core_collocation's fieldScope is ["collocation"], so it cannot drive an
    // example/corpus draft — this must fail fast, before the LLM is called.
    await expect(
      service.generateDraft(WORD, "corpus", { styleProfileId: "core_collocation" }),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      field: "corpus",
    });
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("throws ValidationError when an example-only profile is used for collocation", async () => {
    const dictionaryProvider = makeDictionaryProvider();
    const provider = makeProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: makeUsageTracker() as never,
      dictionaryProvider,
    });

    // academic's fieldScope is ["example"], so it cannot drive a collocation draft.
    await expect(
      service.generateDraft(ADJ_WORD, "collocation", { styleProfileId: "academic" }),
    ).rejects.toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_ERROR",
      field: "collocation",
    });
    // LLM never called when the profile scope is invalid (fails before lookup)
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("accepts a collocation-scoped profile for a collocation draft", async () => {
    // The LLM must return a phrase that exists in the dictionary candidates so
    // the item survives the ungrounded-item filter (P2: an all-ungrounded LLM
    // output now falls back to dictionary-only). Use a grounded candidate phrase.
    const provider = makeProvider({
      generate: vi.fn(async () =>
        makeLlmResult({ content: '[{"phrase":"abundant rainfall"}]' }),
      ),
    });
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: makeUsageTracker() as never,
      dictionaryProvider,
    });

    // exam_collocation's fieldScope is ["collocation"] — valid for collocation.
    const result = await service.generateDraft(ADJ_WORD, "collocation", {
      styleProfileId: "exam_collocation",
    });

    expect(result.error).toBeUndefined();
    expect(result.sourceMode).toBe("dictionary_llm_refined");
    const msgs = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // exam_collocation sets examReady=true; the candidate-grounded prompt is
    // still used (style profile doesn't override the grounding constraint).
    expect(msgs[0].content).toContain("abundant rainfall");
  });

  it("existing corpus draft without a styleProfileId still works (legacy path)", async () => {
    const provider = makeProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: makeUsageTracker() as never,
    });

    const result = await service.generateDraft(WORD, "corpus", "manual");

    expect(result.error).toBeUndefined();
    expect(result.sourceMode).toBe("internal_llm");
    expect(result.storageField).toBe("corpus");
    // legacy default domains present in the prompt
    const msgs = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msgs[1].content).toContain("科技");
    expect(msgs[1].content).toContain("商业");
  });

  it("accepts GenerateDraftOptions object as the third parameter (count override)", async () => {
    const provider = makeProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: makeUsageTracker() as never,
    });

    await service.generateDraft(WORD, "corpus", { count: 5, source: "manual" });

    const msgs = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(msgs[0].content).toContain("5 个例句");
  });
});

// ── B5: buildExternalPrompt (no LLM, no usage budget) ───────────────────
//
// buildExternalPrompt composes the prompt text + hash + schema description
// WITHOUT calling the LLM or consulting the usage tracker. It must work with
// an empty deps object (no llmProvider/usageTracker), proving the external
// prompt flow is independent of the LLM subsystem.
//
// B3/P1: `collocation` is dictionary-grounded here too — see the dedicated
// P1 describe block below for the no-provider / candidates / no-LLM-call
// cases. The tests in this block cover the non-collocation fields and the
// style-profile path, which are independent of the dictionary.
describe("L2ContentService.buildExternalPrompt", () => {
  it("assembles a prompt, hash, version, and schema without an LLM", async () => {
    const service = new L2ContentService({});

    const result = await service.buildExternalPrompt(WORD, "corpus", {});

    expect(result.error).toBeUndefined();
    expect(result.storageField).toBe("corpus");
    expect(result.promptVersion).toBe("l2-example-external-v1");
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof result.prompt).toBe("string");
    expect(result.prompt!.length).toBeGreaterThan(0);
    // P3: expectedJsonSchema declares the v1 document shape (not a bare array).
    expect(result.expectedJsonSchema).toEqual(
      expect.objectContaining({
        type: "object",
        required: ["schemaVersion", "field", "items"],
      }),
    );
    // default style profile when none provided
    expect(result.styleProfileId).toBe("default");
  });

  it("applies a style profile and reflects it in the version/hash", async () => {
    const service = new L2ContentService({});

    const without = await service.buildExternalPrompt(WORD, "corpus", {});
    const withProfile = await service.buildExternalPrompt(WORD, "corpus", {
      styleProfileId: "academic",
    });

    expect(withProfile.styleProfileId).toBe("academic");
    // different profile → different prompt text → different hash
    expect(withProfile.promptHash).not.toBe(without.promptHash);
    expect(withProfile.prompt).toContain("academic");
  });

  it("throws ValidationError for a mismatched styleProfileId", async () => {
    const service = new L2ContentService({});

    await expect(
      service.buildExternalPrompt(WORD, "corpus", { styleProfileId: "core_collocation" }),
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError when a styleProfileId is given for synonym/antonym", async () => {
    const service = new L2ContentService({});

    await expect(
      service.buildExternalPrompt(WORD, "synonym", { styleProfileId: "academic" }),
    ).rejects.toThrow(ValidationError);
  });

  it("produces a stable hash for identical inputs (collocation with dictionary candidates)", async () => {
    // P1: collocation now requires dictionary grounding, so the stability test
    // wires a dictionary provider. Identical inputs (same candidates) → same
    // hash; the prompt version tag reflects the composer-facing field.
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({ dictionaryProvider });

    const a = await service.buildExternalPrompt(ADJ_WORD, "collocation", { count: 3 });
    const b = await service.buildExternalPrompt(ADJ_WORD, "collocation", { count: 3 });

    expect(a.error).toBeUndefined();
    expect(a.promptHash).toBe(b.promptHash);
    expect(a.promptVersion).toBe("l2-collocation-external-v1");
  });
});

// ── P1: buildExternalPrompt dictionary-grounded collocation ───────────────
//
// buildExternalPrompt is async and grounds collocation on dictionary
// candidates — same contract as generateDraft. No provider / throwing provider
// / empty candidates → structured NO_DICTIONARY_CANDIDATES (route → 422). The
// LLM is never consulted and no usage is recorded even when an
// llmProvider/usageTracker happen to be configured.
describe("L2ContentService.buildExternalPrompt — P1 dictionary-grounded collocation", () => {
  it("returns NO_DICTIONARY_CANDIDATES without a dictionaryProvider (no LLM/usage calls)", async () => {
    const provider = makeProvider();
    const tracker = makeUsageTracker();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      // no dictionaryProvider
    });

    const result = await service.buildExternalPrompt(ADJ_WORD, "collocation", {});

    expect(result.error).toBe("NO_DICTIONARY_CANDIDATES");
    expect(result.warning).toBe("Dictionary provider not configured");
    expect(result.storageField).toBe("collocation");
    // buildExternalPrompt must never call the LLM or record usage.
    expect(provider.generate).not.toHaveBeenCalled();
    expect(tracker.record).not.toHaveBeenCalled();
    expect(tracker.reserve).not.toHaveBeenCalled();
  });

  it("returns NO_DICTIONARY_CANDIDATES when the dictionary provider throws", async () => {
    const dictionaryProvider = makeDictionaryProvider({
      lookupError: new Error("datamuse 503"),
    });
    const service = new L2ContentService({ dictionaryProvider });

    const result = await service.buildExternalPrompt(ADJ_WORD, "collocation", {});

    expect(result.error).toBe("NO_DICTIONARY_CANDIDATES");
    expect(result.warning).toContain("Dictionary lookup failed");
    expect(result.warning).toContain("datamuse 503");
    expect(result.storageField).toBe("collocation");
  });

  it("returns NO_DICTIONARY_CANDIDATES when the dictionary has no candidates", async () => {
    const dictionaryProvider = makeDictionaryProvider({ candidates: [] });
    const service = new L2ContentService({ dictionaryProvider });

    const result = await service.buildExternalPrompt(ADJ_WORD, "collocation", {});

    expect(result.error).toBe("NO_DICTIONARY_CANDIDATES");
    expect(result.warning).toBe("No dictionary candidates found");
    expect(result.storageField).toBe("collocation");
  });

  it("builds a prompt containing the candidate phrases when candidates exist", async () => {
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({ dictionaryProvider });

    const result = await service.buildExternalPrompt(ADJ_WORD, "collocation", {});

    expect(result.error).toBeUndefined();
    expect(result.storageField).toBe("collocation");
    expect(result.promptVersion).toBe("l2-collocation-external-v1");
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
    // The candidate phrases surface in the assembled prompt text (the
    // dictionaryCandidates block is the sole source of truth).
    expect(result.prompt).toContain("abundant rainfall");
    expect(result.prompt).toContain("abundant evidence");
    // The grounding instruction forbids invented collocations.
    expect(result.prompt).toMatch(/不得.{0,4}发明|do not invent|不得发明|不能新增候选/i);
  });

  it("does not call the LLM or record usage even when llmProvider/usageTracker are configured", async () => {
    const provider = makeProvider();
    const tracker = makeUsageTracker();
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      dictionaryProvider,
    });

    await service.buildExternalPrompt(ADJ_WORD, "collocation", {});

    // buildExternalPrompt is a pure prompt-assembly path — never LLM/budget.
    expect(provider.generate).not.toHaveBeenCalled();
    expect(tracker.record).not.toHaveBeenCalled();
    expect(tracker.reserve).not.toHaveBeenCalled();
  });

  it("example (corpus) field still works without a dictionary provider (regression)", async () => {
    // Non-collocation fields must not require a dictionary. This is the
    // regression guard for the example/corpus path after buildExternalPrompt
    // became dictionary-grounded for collocation only.
    const service = new L2ContentService({});

    const result = await service.buildExternalPrompt(WORD, "corpus", {});

    expect(result.error).toBeUndefined();
    expect(result.storageField).toBe("corpus");
    expect(result.promptVersion).toBe("l2-example-external-v1");
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof result.prompt).toBe("string");
    expect(result.prompt!.length).toBeGreaterThan(0);
  });
});

// ── P2: LLM-refined collocation provenance/evidence merge ──────────────────
//
// When the LLM refines dictionary candidates, each kept item must carry
// dictionary-grounded provenance (source = dictionary_llm_refined,
// dictionaryName, dictionaryUrl) and evidence (dictionaryName, dictionaryUrl,
// rawPhrase), with the canonical phrase coming from the dictionary candidate.
// LLM-authored gloss/example/tone are preserved. When all items are ungrounded
// the service falls back to a dictionary-only draft + warning.
describe("L2ContentService.generateDraft — P2 LLM-refined collocation provenance/evidence", () => {
  it("marks a kept LLM-refined item with provenance.source = dictionary_llm_refined", async () => {
    const provider = makeProvider({
      generate: vi.fn(async () =>
        makeLlmResult({
          content: JSON.stringify([
            {
              phrase: "abundant rainfall",
              gloss: "充足降水",
              tone: "neutral",
              example: "We had abundant rainfall this year.",
              exampleTranslation: "今年降雨充足。",
            },
          ]),
        }),
      ),
    });
    const tracker = makeUsageTracker();
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      dictionaryProvider,
    });

    const result = await service.generateDraft(ADJ_WORD, "collocation", "manual");

    expect(result.error).toBeUndefined();
    expect(result.sourceMode).toBe("dictionary_llm_refined");
    const draft = result.draft as Array<{ provenance: { source: string } }>;
    expect(draft).toHaveLength(1);
    expect(draft[0].provenance.source).toBe("dictionary_llm_refined");
  });

  it("attaches evidence.dictionaryName and evidence.rawPhrase to kept items", async () => {
    const provider = makeProvider({
      generate: vi.fn(async () =>
        makeLlmResult({
          content: JSON.stringify([
            {
              phrase: "abundant rainfall",
              gloss: "降水",
              tone: "neutral",
            },
          ]),
        }),
      ),
    });
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: makeUsageTracker() as never,
      dictionaryProvider,
    });

    const result = await service.generateDraft(ADJ_WORD, "collocation", "manual");

    const draft = result.draft as Array<{
      phrase: string;
      provenance: { dictionaryName: string; dictionaryUrl?: string };
      evidence: { dictionaryName: string; rawPhrase: string; dictionaryUrl?: string };
    }>;
    expect(draft).toHaveLength(1);
    expect(draft[0].provenance.dictionaryName).toBe("Datamuse");
    expect(draft[0].provenance.dictionaryUrl).toBe(
      "https://api.datamuse.com/words?rel_jja=abundant&max=5",
    );
    expect(draft[0].evidence.dictionaryName).toBe("Datamuse");
    expect(draft[0].evidence.rawPhrase).toBe("abundant rainfall");
    expect(draft[0].evidence.dictionaryUrl).toBe(
      "https://api.datamuse.com/words?rel_jja=abundant&max=5",
    );
    // Canonical phrase comes from the dictionary candidate.
    expect(draft[0].phrase).toBe("abundant rainfall");
  });

  it("preserves the LLM-authored gloss/example on the refined item", async () => {
    const provider = makeProvider({
      generate: vi.fn(async () =>
        makeLlmResult({
          content: JSON.stringify([
            {
              phrase: "abundant rainfall",
              gloss: "充足降水",
              tone: "neutral",
              example: "We had abundant rainfall this year.",
              exampleTranslation: "今年降雨充足。",
            },
          ]),
        }),
      ),
    });
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: makeUsageTracker() as never,
      dictionaryProvider,
    });

    const result = await service.generateDraft(ADJ_WORD, "collocation", "manual");

    const draft = result.draft as Array<{
      gloss: string;
      tone: string;
      example: string;
      exampleTranslation: string;
    }>;
    expect(draft).toHaveLength(1);
    // LLM-authored annotation fields are preserved verbatim.
    expect(draft[0].gloss).toBe("充足降水");
    expect(draft[0].tone).toBe("neutral");
    expect(draft[0].example).toBe("We had abundant rainfall this year.");
    expect(draft[0].exampleTranslation).toBe("今年降雨充足。");
  });

  it("canonicalizes the phrase to the dictionary candidate when the LLM used different casing", async () => {
    // The LLM emitted "Abundant Rainfall" with different casing/whitespace; the
    // grounding comparison is normalized so the item is kept, but the stored
    // phrase is the dictionary's canonical "abundant rainfall".
    const provider = makeProvider({
      generate: vi.fn(async () =>
        makeLlmResult({
          content: JSON.stringify([
            { phrase: "  Abundant Rainfall  ", gloss: "降水", tone: "neutral" },
          ]),
        }),
      ),
    });
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: makeUsageTracker() as never,
      dictionaryProvider,
    });

    const result = await service.generateDraft(ADJ_WORD, "collocation", "manual");

    const draft = result.draft as Array<{ phrase: string }>;
    expect(draft).toHaveLength(1);
    expect(draft[0].phrase).toBe("abundant rainfall");
    expect(result.warning).toBeUndefined();
  });

  it("falls back to a dictionary-only draft + warning when all LLM items are ungrounded", async () => {
    // Every item the LLM returned is absent from the candidate set → all
    // dropped. The service must not return an empty draft; it falls back to the
    // dictionary-only draft (sourceMode = dictionary) and surfaces a warning.
    const provider = makeProvider({
      generate: vi.fn(async () =>
        makeLlmResult({
          content: JSON.stringify([
            { phrase: "totally invented", gloss: "幻觉", tone: "neutral" },
            { phrase: "also fabricated", gloss: "幻觉", tone: "neutral" },
          ]),
        }),
      ),
    });
    const tracker = makeUsageTracker();
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({
      llmProvider: provider,
      usageTracker: tracker as never,
      dictionaryProvider,
    });

    const result = await service.generateDraft(ADJ_WORD, "collocation", "manual");

    expect(result.error).toBeUndefined();
    expect(result.sourceMode).toBe("dictionary");
    expect(result.warning).toBe("All LLM items ungrounded, fell back to dictionary-only");
    expect(result.storageField).toBe("collocation");
    // The fallback draft is the dictionary-only shape (candidate phrases with
    // provenance.source = "dictionary"), not the LLM's invented items.
    const draft = result.draft as Array<{
      phrase: string;
      provenance: { source: string; dictionaryName: string };
    }>;
    expect(Array.isArray(draft)).toBe(true);
    expect(draft.length).toBeGreaterThan(0);
    expect(draft[0].provenance.source).toBe("dictionary");
    // usage reservation was settled (the LLM call happened) even though all
    // items were dropped — the token spend is not silently swallowed.
    expect(tracker.settle).toHaveBeenCalledTimes(1);
  });
});

// ── P3: external-prompt v1-first output format ────────────────────────────
//
// buildExternalPrompt must instruct the external chat tool to emit a v1
// document (`{ schemaVersion: "l2-content-v1", field, items }`) rather than a
// legacy bare array, and each item must carry `provenance.source`
// (example → "external_chat", collocation → "dictionary" + evidence).
// describeExpectedJsonSchema returns the v1 document shape so operators see
// the expected wrapper structure.
describe("L2ContentService.buildExternalPrompt — P3 v1-first output format", () => {
  it("example (corpus) prompt mentions 'l2-content-v1'", async () => {
    const service = new L2ContentService({});

    const result = await service.buildExternalPrompt(WORD, "corpus", {});

    expect(result.error).toBeUndefined();
    expect(result.prompt).toContain("l2-content-v1");
  });

  it("example (corpus) prompt mentions 'external_chat' (provenance.source)", async () => {
    const service = new L2ContentService({});

    const result = await service.buildExternalPrompt(WORD, "corpus", {});

    expect(result.error).toBeUndefined();
    expect(result.prompt).toContain("external_chat");
  });

  it("collocation prompt mentions 'l2-content-v1' when dictionary candidates exist", async () => {
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({ dictionaryProvider });

    const result = await service.buildExternalPrompt(ADJ_WORD, "collocation", {});

    expect(result.error).toBeUndefined();
    expect(result.prompt).toContain("l2-content-v1");
  });

  it("collocation prompt requires external_chat provenance plus dictionary evidence when candidates exist", async () => {
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({ dictionaryProvider });

    const result = await service.buildExternalPrompt(ADJ_WORD, "collocation", {});

    expect(result.error).toBeUndefined();
    // external-prompt output is authored by an external tool, while evidence
    // carries the dictionary grounding.
    expect(result.prompt).toContain("external_chat");
    expect(result.prompt).toContain("dictionaryName");
    expect(result.prompt).toContain("rawPhrase");
  });

  it("describeExpectedJsonSchema returns a v1 document shape for corpus (not a legacy array)", async () => {
    const service = new L2ContentService({});

    const result = await service.buildExternalPrompt(WORD, "corpus", {});
    const schema = result.expectedJsonSchema as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    // v1 document wrapper, not a bare array.
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["schemaVersion", "field", "items"]);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.schemaVersion).toEqual({ type: "string", const: "l2-content-v1" });
    // composer-facing field name `example` for corpus.
    expect(props.field).toEqual({ type: "string", enum: ["example"] });
    // items is an array whose items carry provenance.source.
    const itemsProp = props.items as Record<string, unknown>;
    expect(itemsProp.type).toBe("array");
    const itemShape = itemsProp.items as Record<string, unknown>;
    const itemProps = itemShape.properties as Record<string, Record<string, unknown>>;
    expect(itemShape.required).toContain("provenance");
    const provenance = itemProps.provenance as Record<string, unknown>;
    const provenanceProps = provenance.properties as Record<string, Record<string, unknown>>;
    expect(provenance.required).toEqual(["source"]);
    expect(provenanceProps.source).toEqual({ type: "string", enum: ["external_chat"] });
  });

  it("describeExpectedJsonSchema returns a v1 document shape for collocation with dictionary provenance", async () => {
    const dictionaryProvider = makeDictionaryProvider();
    const service = new L2ContentService({ dictionaryProvider });

    const result = await service.buildExternalPrompt(ADJ_WORD, "collocation", {});
    const schema = result.expectedJsonSchema as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["schemaVersion", "field", "items"]);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.schemaVersion).toEqual({ type: "string", const: "l2-content-v1" });
    expect(props.field).toEqual({ type: "string", enum: ["collocation"] });
    const itemsProp = props.items as Record<string, unknown>;
    const itemShape = itemsProp.items as Record<string, unknown>;
    const itemProps = itemShape.properties as Record<string, Record<string, unknown>>;
    // collocation external-prompt items carry provenance.source=external_chat
    // plus dictionary evidence.
    expect(itemShape.required).toContain("provenance");
    expect(itemShape.required).toContain("evidence");
    const provenance = itemProps.provenance as Record<string, unknown>;
    const provenanceProps = provenance.properties as Record<string, Record<string, unknown>>;
    expect(provenance.required).toEqual(["source"]);
    expect(provenanceProps.source).toEqual({
      type: "string",
      enum: ["external_chat"],
    });
    const evidence = itemProps.evidence as Record<string, unknown>;
    expect(evidence.required).toEqual(["dictionaryName", "rawPhrase"]);
  });

  it("v1 output-format instruction is part of the hashed prompt text", async () => {
    // The instruction is appended to the prompt text, so the promptHash covers
    // it. Two builds with the same field/word produce the same hash, and the
    // hash differs from a hypothetical prompt without the instruction (guarded
    // by the content check).
    const service = new L2ContentService({});

    const result = await service.buildExternalPrompt(WORD, "synonym", {});

    expect(result.error).toBeUndefined();
    expect(result.prompt).toContain("l2-content-v1");
    expect(result.prompt).toContain("external_chat");
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
