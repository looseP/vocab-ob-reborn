/**
 * Phase 2E contract tests — cross-cutting contracts that span the L2 composer
 * surface (draft → external-prompt → confirm → persistence).
 *
 * These tests pin the contracts that were identified as needing explicit
 * coverage during the Phase 2E review:
 *   - external-prompt output → confirm succeeds with external_chat provenance
 *   - confirm preserves item-level provenance/evidence (v1 wrapper not stripped)
 *
 * The remaining Phase 2E contract items (1–5, 7, 9, 10) are already covered in
 * tests/services/l2-content.test.ts and tests/http/l2.test.ts; this file only
 * adds the two gaps.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IRepositories } from "@/repositories/interfaces";

// Mock withTransaction + createRepositories so confirmDraft never hits real DB.
const mockRepos: Partial<IRepositories> = {};
vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
}));
vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

import { L2ContentService } from "@/services/l2-content.service";
import type { BuildExternalPromptResult } from "@/services/l2-content.service";

const WORD = {
  lemma: "abandon",
  pos: "v.",
  semanticField: "情感",
  shortDefinition: "抛弃；放弃",
  cefrTarget: "雅思",
};

/** Wire up a full set of mock repos; returns the l2Content repo for assertions. */
function setupRepos(wordRow: unknown = { id: "word-1" }) {
  const l2ContentRepo = {
    insert: vi.fn(async () => ({ id: "l2-1" })),
    refreshL2Cache: vi.fn(async () => {}),
    findByWord: vi.fn(),
    softDelete: vi.fn(),
  };
  const l2ProgressRepo = {
    finalizeL2ContentHash: vi.fn(async () => 1),
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

beforeEach(() => {
  Object.keys(mockRepos).forEach((k) => delete (mockRepos as Record<string, unknown>)[k]);
});

describe("Phase 2E contract — external-prompt → confirm roundtrip", () => {
  it("external-prompt output can be confirmed with external_chat provenance and sourceRef", async () => {
    // 1. Build an external prompt with the real service (no LLM deps). This
    //    mirrors the operator workflow: GET the prompt, paste it into an
    //    external chat tool, then confirm the result.
    const service = new L2ContentService({});
    const promptResult: BuildExternalPromptResult = await service.buildExternalPrompt(
      WORD,
      "corpus",
      { styleProfileId: "academic" },
    );

    expect(promptResult.storageField).toBe("corpus");
    expect(promptResult.promptVersion).toBe("l2-example-external-v1");
    expect(promptResult.promptHash).toMatch(/^[0-9a-f]{64}$/);

    // 2. The operator's external chat tool returns a v1 corpus item carrying
    //    external_chat provenance + the prompt hash/version for traceability.
    const externalItem = {
      text: "They had to abandon the project after the funding cut.",
      translation: "资金削减后，他们不得不放弃该项目。",
      usageNote: "abandon a project — formal, common in business writing",
      provenance: {
        source: "external_chat" as const,
        externalTool: "chatgpt",
        promptVersion: promptResult.promptVersion,
        promptHash: promptResult.promptHash,
        styleProfileId: "academic",
      },
    };
    const v1Document = {
      schemaVersion: "l2-content-v1",
      field: "example",
      items: [externalItem],
    };

    // 3. Confirm the external output. confirmDraft is a pure DB cascade — it
    //    parses the v1 wrapper, validates items, and persists inside a tx.
    const { l2ContentRepo } = setupRepos({ id: "word-1" });
    await service.confirmDraft("word-1", "corpus", v1Document, {
      source: "external_chat",
      sourceRef: "chatgpt://conv/abc-123",
      approvedBy: "operator-1",
    });

    // 4. The persisted content is the parsed v1 wrapper — provenance/evidence
    //    are preserved, not stripped. The storage field is the canonical name.
    expect(l2ContentRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = (l2ContentRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      word_id: string;
      field: string;
      content: { schemaVersion: string; field: string; items: unknown[] };
      source: string;
      source_ref: string | null;
      approved_by: string | null;
    };
    expect(inserted.word_id).toBe("word-1");
    expect(inserted.field).toBe("corpus");
    expect(inserted.source).toBe("external_chat");
    expect(inserted.source_ref).toBe("chatgpt://conv/abc-123");
    expect(inserted.approved_by).toBe("operator-1");

    // 5. Item-level provenance survived the parse → insert pipeline.
    expect(inserted.content.schemaVersion).toBe("l2-content-v1");
    expect(inserted.content.field).toBe("corpus");
    expect(Array.isArray(inserted.content.items)).toBe(true);
    const persistedItem = inserted.content.items[0] as {
      text: string;
      provenance: { source: string; externalTool: string; promptHash: string };
    };
    expect(persistedItem.text).toBe(externalItem.text);
    expect(persistedItem.provenance.source).toBe("external_chat");
    expect(persistedItem.provenance.externalTool).toBe("chatgpt");
    expect(persistedItem.provenance.promptHash).toBe(promptResult.promptHash);
  });
});

describe("Phase 2E contract — confirm preserves item provenance/evidence", () => {
  it("collocation v1 wrapper preserves provenance + dictionary evidence through confirm", async () => {
    const service = new L2ContentService({});
    // A dictionary-grounded collocation item carrying full provenance +
    // evidence (the shape buildDictionaryOnlyDraft produces).
    const v1Document = {
      schemaVersion: "l2-content-v1",
      field: "collocation",
      items: [
        {
          phrase: "abundant rainfall",
          gloss: "充足降水",
          tone: "neutral",
          provenance: {
            source: "dictionary_llm_refined",
            dictionaryName: "Datamuse",
            dictionaryEntryId: "entry-42",
            dictionaryUrl: "https://api.datamuse.com/words?rel_jja=abundant",
          },
          evidence: {
            dictionaryName: "Datamuse",
            dictionaryUrl: "https://api.datamuse.com/words?rel_jja=abundant",
            rawPhrase: "rainfall",
            rawExample: "abundant rainfall in the monsoon season",
          },
        },
      ],
    };

    const { l2ContentRepo } = setupRepos({ id: "word-1" });
    await service.confirmDraft("word-1", "collocation", v1Document, {
      source: "dictionary_llm_refined",
      sourceRef: "datamuse://rel_jja/abundant",
      approvedBy: "user",
    });

    expect(l2ContentRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = (l2ContentRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      field: string;
      content: { items: Array<{ provenance: Record<string, unknown>; evidence?: Record<string, unknown> }> };
    };

    // The v1 wrapper round-trips: schemaVersion/field/items intact, and the
    // item's provenance + evidence survive parseL2Content (passthrough).
    expect(inserted.field).toBe("collocation");
    const item = inserted.content.items[0];
    expect(item.provenance.source).toBe("dictionary_llm_refined");
    expect(item.provenance.dictionaryName).toBe("Datamuse");
    expect(item.provenance.dictionaryEntryId).toBe("entry-42");
    // Evidence is NOT stripped — it grounds the dictionary claim.
    expect(item.evidence).toBeDefined();
    expect(item.evidence?.dictionaryName).toBe("Datamuse");
    expect(item.evidence?.rawPhrase).toBe("rainfall");
    expect(item.evidence?.rawExample).toBe("abundant rainfall in the monsoon season");
  });

  it("passthrough keeps unknown provenance fields (forward-compatible)", async () => {
    const service = new L2ContentService({});
    // A future-provenance field the current schema doesn't declare. The v1
    // provenance/evidence schemas use .passthrough() so unknown keys round-trip
    // without a schema bump — this contract must hold so adding provenance
    // metadata later doesn't break existing confirms.
    const v1Document = {
      schemaVersion: "l2-content-v1",
      field: "corpus",
      items: [
        {
          text: "They abandoned the project.",
          translation: "他们放弃了项目。",
          provenance: {
            source: "external_chat",
            futureField: "should-survive",
            nested: { a: 1 },
          },
        },
      ],
    };

    const { l2ContentRepo } = setupRepos({ id: "word-1" });
    await service.confirmDraft("word-1", "corpus", v1Document, { source: "external_chat" });

    const inserted = (l2ContentRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      content: { items: Array<{ provenance: Record<string, unknown> }> };
    };
    expect(inserted.content.items[0].provenance.futureField).toBe("should-survive");
    expect(inserted.content.items[0].provenance.nested).toEqual({ a: 1 });
  });

  it("rejects a dictionary-sourced collocation missing dictionaryName (superRefine)", async () => {
    const service = new L2ContentService({});
    // The v1 collocation item schema superRefines: a dictionary/dictionary_llm_refined
    // source MUST carry dictionaryName (in provenance or evidence). This is the
    // "a dictionary claim without a dictionary name is not actionable" rule.
    const v1Document = {
      schemaVersion: "l2-content-v1",
      field: "collocation",
      items: [
        {
          phrase: "abundant rainfall",
          provenance: { source: "dictionary" }, // no dictionaryName anywhere
        },
      ],
    };

    const { l2ContentRepo } = setupRepos({ id: "word-1" });
    await expect(
      service.confirmDraft("word-1", "collocation", v1Document, { source: "dictionary" }),
    ).rejects.toMatchObject({ name: "ValidationError", code: "VALIDATION_ERROR" });
    // Nothing persisted when validation fails.
    expect(l2ContentRepo.insert).not.toHaveBeenCalled();
  });
});
