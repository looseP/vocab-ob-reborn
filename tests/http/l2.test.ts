import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createApp } from "@/http/server";
import type { Services } from "@/services";
import { L2ContentService } from "@/services/l2-content.service";
import type { DictionaryCandidate, DictionaryProvider } from "@/dictionary/provider";
import { NotFoundError, ValidationError } from "@/errors";
import {
  l2ConfirmResponseSchema,
  l2DraftResponseSchema,
  l2ExternalPromptResponseSchema,
} from "@/http/l2-response-contract";

// ── Auth env setup ──────────────────────────────────────────────────────
const ORIGINAL_OWNER_TOKEN = process.env.OWNER_API_TOKEN;
const ORIGINAL_LOCAL_OWNER = process.env.LOCAL_OWNER_ID;

beforeAll(() => {
  process.env.OWNER_API_TOKEN = "test-owner";
  process.env.LOCAL_OWNER_ID = "user-123";
});

afterAll(() => {
  process.env.OWNER_API_TOKEN = ORIGINAL_OWNER_TOKEN;
  process.env.LOCAL_OWNER_ID = ORIGINAL_LOCAL_OWNER;
});

const AUTH_HEADERS = {
  Authorization: "Bearer test-owner",
  "Content-Type": "application/json",
};

/** Build a Word-like object exposing the getters the route reads. */
function makeWord(overrides: Record<string, unknown> = {}) {
  return {
    id: "word-1",
    lemma: "abandon",
    pos: "v.",
    semanticField: "情感",
    shortDefinition: "抛弃；放弃",
    cefr: "雅思",
    ...overrides,
  };
}

// ── Valid L2 content fixtures (one per field, matching prompt templates) ──
const VALID_CONTENT: Record<string, unknown> = {
  collocation: [
    {
      phrase: "abandon ship",
      gloss: "弃船",
      tone: "neutral",
      example: "The captain ordered to abandon ship.",
      exampleTranslation: "船长下令弃船。",
    },
  ],
  corpus: [
    {
      text: "They had to abandon the project.",
      translation: "他们不得不放弃这个项目。",
      source: "generated",
    },
  ],
  synonym: [
    {
      word: "desert",
      semanticDiff: "强调违背义务",
      tone: "formal",
      usage: "多用于人离开职责",
      delta: "abandon 更通用",
      object: "人/地点",
    },
  ],
  antonym: [
    {
      word: "retain",
      semanticDiff: "保留",
      tone: "formal",
      usage: "通用",
      delta: "反义",
      object: "物/抽象",
    },
  ],
};

function makeMockServices(l2content?: unknown): Services {
  const words = {
    getWordBySlug: vi.fn(async () => ({ word: makeWord() })),
  };
  return {
    words,
    reviews: {} as never,
    notes: {} as never,
    wordbooks: {} as never,
    stats: {} as never,
    l2Transition: {} as never,
    l2content,
  } as unknown as Services;
}

/** Sample dictionary candidates for the collocation external-prompt tests. */
const DICT_CANDIDATES: DictionaryCandidate[] = [
  {
    phrase: "abandon hope",
    headword: "hope",
    sourceName: "Datamuse",
    sourceUrl: "https://api.datamuse.com/words?rel_jja=abandon&max=5",
    relation: "rel_jja",
    score: 100,
  },
];

/** Build a DictionaryProvider mock returning the given candidates. */
function makeDictionaryProvider(
  candidates: DictionaryCandidate[] = DICT_CANDIDATES,
): DictionaryProvider {
  return {
    lookupCollocations: vi.fn(async () => ({ candidates })),
  };
}

describe("POST /api/l2/:slug/draft", () => {
  it("returns the generated draft", async () => {
    const l2content = {
      generateDraft: vi.fn(async () => ({
        draft: [{ phrase: "abandon ship" }],
        raw: '[{"phrase":"abandon ship"}]',
      })),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/draft", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "collocation" }),
    });

    expect(res.status).toBe(200);
    const body = l2DraftResponseSchema.parse(await res.json());
    expect(body.draft).toEqual([{ phrase: "abandon ship" }]);
    // word context built from the looked-up word; route now passes an options
    // object (B3) whose source defaults to "manual"
    expect(l2content.generateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        lemma: "abandon",
        pos: "v.",
        semanticField: "情感",
        shortDefinition: "抛弃；放弃",
        cefrTarget: "雅思",
      }),
      "collocation",
      expect.objectContaining({ source: "manual" }),
    );
  });

  it("returns 503 when over budget", async () => {
    const l2content = {
      generateDraft: vi.fn(async () => ({ error: "OVER_BUDGET" })),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/draft", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "corpus" }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("OVER_BUDGET");
  });

  it("returns 500 on LLM_ERROR / PARSE_FAILED", async () => {
    const l2content = {
      generateDraft: vi.fn(async () => ({
        error: "PARSE_FAILED",
        raw: "not json",
      })),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/draft", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "synonym" }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("PARSE_FAILED");
    expect(body.raw).toBeUndefined();
  });

  it("returns 400 for an invalid field", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/draft", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "bogus" }),
    });

    expect(res.status).toBe(400);
    expect(l2content.generateDraft).not.toHaveBeenCalled();
  });

  it("returns 503 when generateDraft reports L2_CONTENT_UNAVAILABLE (no LLM configured)", async () => {
    // The service is always present now; without an LLM provider it returns a
    // structured L2_CONTENT_UNAVAILABLE error, which the route maps to 503.
    const l2content = {
      generateDraft: vi.fn(async () => ({
        error: "L2_CONTENT_UNAVAILABLE",
        message: "LLM provider not configured",
        storageField: "collocation",
      })),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/draft", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "collocation" }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("L2_CONTENT_UNAVAILABLE");
  });

  // ── Composer field mapping: field=example → service called with corpus ──
  it("maps field=example to corpus when generating a draft", async () => {
    const l2content = {
      generateDraft: vi.fn(async () => ({
        draft: [{ text: "They had to abandon the project." }],
        raw: "[]",
      })),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/draft", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example" }),
    });

    expect(res.status).toBe(200);
    // service receives the canonical storage field name, not the composer alias
    expect(l2content.generateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ lemma: "abandon" }),
      "corpus",
      expect.objectContaining({ source: "manual" }),
    );
  });

  it("still accepts field=corpus for backward compatibility (draft)", async () => {
    const l2content = {
      generateDraft: vi.fn(async () => ({ draft: [], raw: "[]" })),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/draft", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "corpus" }),
    });

    expect(res.status).toBe(200);
    expect(l2content.generateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ lemma: "abandon" }),
      "corpus",
      expect.objectContaining({ source: "manual" }),
    );
  });

  // ── B4: styleProfileId in the draft body ──────────────────────────────
  it("passes styleProfileId from the body to generateDraft options", async () => {
    const l2content = {
      generateDraft: vi.fn(async () => ({ draft: [{ text: "x" }], raw: "[]" })),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/draft", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", styleProfileId: "academic" }),
    });

    expect(res.status).toBe(200);
    expect(l2content.generateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ lemma: "abandon" }),
      "corpus",
      expect.objectContaining({ source: "manual", styleProfileId: "academic" }),
    );
  });

  it("maps a mismatched styleProfileId to 400 (collocation profile for example)", async () => {
    // The service throws ValidationError on scope mismatch; the route catches
    // it and returns 400. Here the mock simulates that throw so the route's
    // error mapping is exercised end-to-end.
    const l2content = {
      generateDraft: vi.fn(async () => {
        const err = Object.assign(new Error("Style profile \"core_collocation\" is invalid for field \"corpus\""), {
          name: "ValidationError",
          code: "VALIDATION_ERROR",
          field: "corpus",
        });
        throw err;
      }),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/draft", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", styleProfileId: "core_collocation" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 422 when generateDraft reports NO_DICTIONARY_CANDIDATES (no dictionary source)", async () => {
    const l2content = {
      generateDraft: vi.fn(async () => ({
        error: "NO_DICTIONARY_CANDIDATES",
        warning: "Dictionary provider not configured",
        storageField: "collocation",
      })),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/draft", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "collocation" }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("NO_DICTIONARY_CANDIDATES");
    expect(body.warning).toBe("Dictionary provider not configured");
  });

  it("surfaces sourceMode in the draft response (dictionary_llm_refined)", async () => {
    const l2content = {
      generateDraft: vi.fn(async () => ({
        draft: [{ phrase: "abundant rainfall" }],
        raw: "[]",
        sourceMode: "dictionary_llm_refined",
      })),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/draft", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "collocation" }),
    });

    expect(res.status).toBe(200);
    const body = l2DraftResponseSchema.parse(await res.json());
    expect(body.sourceMode).toBe("dictionary_llm_refined");
  });
});

describe("POST /api/l2/:slug/confirm", () => {
  it("persists a confirmed draft and returns 200", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const content = VALID_CONTENT.collocation;
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        field: "collocation",
        content,
        source: "llm",
      }),
    });

    expect(res.status).toBe(200);
    const body = l2ConfirmResponseSchema.parse(await res.json());
    expect(body.ok).toBe(true);
    expect(l2content.confirmDraft).toHaveBeenCalledWith(
      "word-1",
      "collocation",
      content,
      expect.objectContaining({ source: "llm" }),
    );
  });

  it("defaults source to 'manual' when omitted", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const content = VALID_CONTENT.synonym;
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "synonym", content }),
    });

    expect(res.status).toBe(200);
    expect(l2content.confirmDraft).toHaveBeenCalledWith(
      "word-1",
      "synonym",
      content,
      expect.objectContaining({ source: "manual" }),
    );
  });

  it("returns 400 for an invalid field", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "nope", content: {} }),
    });

    expect(res.status).toBe(400);
    expect(l2content.confirmDraft).not.toHaveBeenCalled();
  });

  it("works without LLM service deps — confirm never 503s (no LLM required)", async () => {
    // confirm is a pure DB cascade and must succeed even when the
    // L2ContentService was constructed without an LLM provider. The service is
    // always present, so the route must NOT short-circuit to 503.
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const content = VALID_CONTENT.collocation;
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "collocation", content }),
    });

    expect(res.status).toBe(200);
    expect(l2content.confirmDraft).toHaveBeenCalledWith("word-1", "collocation", content, expect.objectContaining({ source: "manual" }));
  });

  // ── Field-specific content validation (400 on malformed content) ───────
  it.each(["collocation", "corpus", "synonym", "antonym"] as const)(
    "accepts valid %s content and calls confirmDraft",
    async (field) => {
      const l2content = {
        generateDraft: vi.fn(),
        confirmDraft: vi.fn(async () => {}),
      };
      const services = makeMockServices(l2content);
      const app = createApp(services);

      const content = VALID_CONTENT[field];
      const res = await app.request("/api/l2/abandon/confirm", {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({ field, content }),
      });

      expect(res.status).toBe(200);
      expect(l2content.confirmDraft).toHaveBeenCalledWith("word-1", field, content, expect.objectContaining({ source: "manual" }));
    },
  );

  it.each([
    // missing required keys
    ["collocation", [{ phrase: "abandon ship" }]],
    // not an array
    ["collocation", { phrase: "abandon ship" }],
    // missing translation
    ["corpus", [{ text: "hi" }]],
    // wrong type for text
    ["corpus", [{ text: 123, translation: "x", source: "y" }]],
    // missing delta/object/etc.
    ["synonym", [{ word: "desert" }]],
    // bad tone enum
    ["synonym", [{ word: "desert", semanticDiff: "x", tone: "casual", usage: "x", delta: "x", object: "x" }]],
    // not an array
    ["antonym", "retain"],
    // empty-string word fails min(1)
    ["antonym", [{ word: "" }]],
  ] as const)("returns 400 for invalid %s content and does not call confirmDraft", async (field, content) => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field, content }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(l2content.confirmDraft).not.toHaveBeenCalled();
  });

  // ── Composer field mapping: field=example → service called with corpus ──
  it("maps field=example to corpus when confirming a draft", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    // example content uses the corpus shape (text/translation/source)
    const content = VALID_CONTENT.corpus;
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", content }),
    });

    expect(res.status).toBe(200);
    expect(l2content.confirmDraft).toHaveBeenCalledWith(
      "word-1",
      "corpus",
      content,
      expect.objectContaining({ source: "manual" }),
    );
  });

  it("still accepts field=corpus for backward compatibility (confirm)", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const content = VALID_CONTENT.corpus;
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "corpus", content }),
    });

    expect(res.status).toBe(200);
    expect(l2content.confirmDraft).toHaveBeenCalledWith(
      "word-1",
      "corpus",
      content,
      expect.objectContaining({ source: "manual" }),
    );
  });
});

// ── B5: External Prompt API ──────────────────────────────────────────────
//
// POST /api/l2/:slug/external-prompt assembles a prompt for an external chat
// tool WITHOUT calling the LLM or consuming the usage budget. It must work
// even when no LLM provider is configured.
describe("POST /api/l2/:slug/external-prompt", () => {
  it("returns a prompt without calling the LLM", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(),
      buildExternalPrompt: vi.fn(() => ({
        storageField: "corpus",
        styleProfileId: "academic",
        promptVersion: "l2-example-external-v1",
        promptHash: "deadbeef".repeat(8),
        prompt: "## system\nYou are...\n\n## user\n单词：abandon",
        expectedJsonSchema: {
          type: "object",
          required: ["schemaVersion", "field", "items"],
          properties: {
            schemaVersion: { type: "string", const: "l2-content-v1" },
            field: { type: "string", enum: ["example"] },
            items: { type: "array" },
          },
        },
      })),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/external-prompt", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", styleProfileId: "academic" }),
    });

    expect(res.status).toBe(200);
    const body = l2ExternalPromptResponseSchema.parse(await res.json());
    expect(body.field).toBe("example");
    expect(body.storageField).toBe("corpus");
    expect(body.styleProfileId).toBe("academic");
    expect(body.promptVersion).toBe("l2-example-external-v1");
    expect(body.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.prompt).toBe("string");
    expect(body.expectedJsonSchema).toEqual({
      type: "object",
      required: ["schemaVersion", "field", "items"],
      properties: {
        schemaVersion: { type: "string", const: "l2-content-v1" },
        field: { type: "string", enum: ["example"] },
        items: { type: "array" },
      },
    });
    // The LLM was never called and no draft was generated.
    expect(l2content.generateDraft).not.toHaveBeenCalled();
    expect(l2content.buildExternalPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ lemma: "abandon" }),
      "corpus",
      expect.objectContaining({ styleProfileId: "academic" }),
    );
  });

  it("works without an LLM provider configured (real service, empty deps)", async () => {
    // A real L2ContentService constructed with no llmProvider/usageTracker must
    // still build an external prompt — proving the endpoint doesn't need the
    // LLM. No usage tracker is consulted, so no budget is consumed.
    const l2content = new L2ContentService({});
    const generateSpy = vi.spyOn(l2content, "generateDraft");
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/external-prompt", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.storageField).toBe("corpus");
    expect(body.promptVersion).toBe("l2-example-external-v1");
    expect(body.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.prompt).toBe("string");
    expect((body.prompt as string).length).toBeGreaterThan(0);
    // generateDraft (the LLM entry point) was never invoked.
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid field", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(),
      buildExternalPrompt: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/external-prompt", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "bogus" }),
    });

    expect(res.status).toBe(400);
    expect(l2content.buildExternalPrompt).not.toHaveBeenCalled();
  });

  it("returns 400 for a mismatched styleProfileId (collocation profile for example)", async () => {
    // The real service throws ValidationError when the profile's fieldScope
    // doesn't include the requested field. core_collocation only scopes to
    // collocation, so using it with field=example must 400.
    const l2content = new L2ContentService({});
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/external-prompt", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", styleProfileId: "core_collocation" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("maps field=example to corpus in the response", async () => {
    const l2content = new L2ContentService({});
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/external-prompt", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // composer-facing field echoed back; storage field is the canonical name.
    expect(body.field).toBe("example");
    expect(body.storageField).toBe("corpus");
    expect(body.promptVersion).toBe("l2-example-external-v1");
  });

  // ── B3/P1: collocation external-prompt is dictionary-grounded ───────────
  //
  // The service looks up candidates before composing the prompt. No provider →
  // 422 NO_DICTIONARY_CANDIDATES; candidates present → 200 with the candidate
  // phrases embedded in the prompt text. The LLM is never consulted either
  // way (buildExternalPrompt is a pure prompt-assembly path).
  it("returns 422 for field=collocation when no dictionary provider is configured", async () => {
    // Real service with no dictionaryProvider → the buildExternalPrompt result
    // carries NO_DICTIONARY_CANDIDATES, which the route maps to 422.
    const l2content = new L2ContentService({});
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/external-prompt", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "collocation" }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("NO_DICTIONARY_CANDIDATES");
    expect(body.warning).toBe("Dictionary provider not configured");
  });

  it("returns 200 with candidates embedded in the prompt for field=collocation", async () => {
    const dictionaryProvider = makeDictionaryProvider();
    const l2content = new L2ContentService({ dictionaryProvider });
    const generateSpy = vi.spyOn(l2content, "generateDraft");
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const res = await app.request("/api/l2/abandon/external-prompt", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "collocation" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.storageField).toBe("collocation");
    expect(body.promptVersion).toBe("l2-collocation-external-v1");
    expect(body.promptHash).toMatch(/^[0-9a-f]{64}$/);
    // The dictionary candidate phrases surface in the assembled prompt text.
    expect(body.prompt as string).toContain("abandon hope");
    // buildExternalPrompt must not call the LLM/generateDraft path.
    expect(generateSpy).not.toHaveBeenCalled();
    expect(dictionaryProvider.lookupCollocations).toHaveBeenCalledWith(
      expect.objectContaining({ lemma: "abandon" }),
    );
  });
});

// ── B6: Confirm Body Compatibility ───────────────────────────────────────
//
// The confirm route accepts three body shapes:
//   1. legacy  { field, content, source }            — bare JSON array
//   2. items   { field, items, source, sourceRef? }  — wrapped into v1 doc
//   3. document { field, document, source, sourceRef? } — v1 wrapper passed through
// `document` wins over `items` wins over `content`. `sourceRef` reaches the
// repository insert as `source_ref`.
describe("POST /api/l2/:slug/confirm — body compatibility (B6)", () => {
  it("legacy { field, content, source } still works", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const content = VALID_CONTENT.collocation;
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "collocation", content, source: "llm" }),
    });

    expect(res.status).toBe(200);
    // content is passed through unchanged; source carried via options object.
    expect(l2content.confirmDraft).toHaveBeenCalledWith(
      "word-1",
      "collocation",
      content,
      expect.objectContaining({ source: "llm" }),
    );
  });

  it("{ field, items, source } wraps into a v1 document and confirms", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    // v1 corpus items require provenance; use a complete v1 item shape.
    const items = [
      {
        text: "They had to abandon the project.",
        translation: "他们不得不放弃这个项目。",
        provenance: { source: "external_chat" },
      },
    ];
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", items, source: "external_chat" }),
    });

    expect(res.status).toBe(200);
    expect(l2content.confirmDraft).toHaveBeenCalledWith(
      "word-1",
      "corpus",
      expect.objectContaining({
        schemaVersion: "l2-content-v1",
        field: "example",
        items,
      }),
      expect.objectContaining({ source: "external_chat" }),
    );
  });

  it("{ field, document, source } confirms", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const document = {
      schemaVersion: "l2-content-v1",
      field: "example",
      items: [
        {
          text: "They had to abandon the project.",
          translation: "他们不得不放弃这个项目。",
          provenance: { source: "external_chat" },
        },
      ],
    };
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", document, source: "external_chat" }),
    });

    expect(res.status).toBe(200);
    // document is passed through verbatim (the service parses/validates it).
    expect(l2content.confirmDraft).toHaveBeenCalledWith(
      "word-1",
      "corpus",
      document,
      expect.objectContaining({ source: "external_chat" }),
    );
  });

  it("document wins over items when both are present", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const document = {
      schemaVersion: "l2-content-v1",
      field: "example",
      items: [
        {
          text: "doc sentence",
          translation: "文档句",
          provenance: { source: "external_chat" },
        },
      ],
    };
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        field: "example",
        document,
        items: [{ text: "items sentence", provenance: { source: "manual" } }],
        source: "external_chat",
      }),
    });

    expect(res.status).toBe(200);
    // document was used, items ignored.
    expect(l2content.confirmDraft).toHaveBeenCalledWith(
      "word-1",
      "corpus",
      document,
      expect.objectContaining({ source: "external_chat" }),
    );
  });

  it("sourceRef reaches the service confirmDraft options", async () => {
    // The route forwards sourceRef into the confirm options object; the
    // service then writes it to word_l2_content.source_ref. Here we assert the
    // route→service handoff (the service→repository handoff is covered in
    // tests/services/l2-content.test.ts).
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const content = VALID_CONTENT.collocation;
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        field: "collocation",
        content,
        source: "external_chat",
        sourceRef: "chatgpt://conv/abc-123",
      }),
    });

    expect(res.status).toBe(200);
    expect(l2content.confirmDraft).toHaveBeenCalledWith(
      "word-1",
      "collocation",
      content,
      expect.objectContaining({
        source: "external_chat",
        sourceRef: "chatgpt://conv/abc-123",
      }),
    );
  });

  it("field=example confirms with storage field corpus", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const content = VALID_CONTENT.corpus;
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", content, source: "manual" }),
    });

    expect(res.status).toBe(200);
    expect(l2content.confirmDraft).toHaveBeenCalledWith(
      "word-1",
      "corpus",
      content,
      expect.objectContaining({ source: "manual" }),
    );
  });

  it("rejects invalid items body with 400 (does not call confirmDraft)", async () => {
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    // items with a missing required provenance → invalid v1 wrapper.
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({
        field: "example",
        items: [{ text: "no provenance", translation: "x" }],
        source: "external_chat",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(l2content.confirmDraft).not.toHaveBeenCalled();
  });
});

// ── P4: confirm route/service error semantics ────────────────────────────
//
// The confirm route relies on three error paths:
//   1. route pre-check (isValidL2Content) failure → 400
//   2. service parseL2Content failure (ValidationError) → handleError → 422
//   3. word not found (getWordBySlug throws NotFoundError) → handleError → 404
// And the service's parseL2Content runs BEFORE the DB transaction opens, so a
// validation failure performs no partial DB write. The route's getWordBySlug /
// confirmDraft calls are NOT wrapped in a try/catch, so thrown AppErrors fall
// through to the global handleError (app.onError) which maps AppError
// subclasses to their declared HTTP status.
describe("POST /api/l2/:slug/confirm — P4 error semantics", () => {
  it("confirm invalid v1 content → 400 (route pre-check, confirmDraft not called)", async () => {
    // A v1 document whose items lack required fields fails isValidL2Content at
    // the route layer (before the service is consulted), so the response is 400
    // and confirmDraft is never called.
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    // v1 wrapper with an empty items array (min(1) violated) → invalid.
    const document = {
      schemaVersion: "l2-content-v1",
      field: "example",
      items: [],
    };
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "example", document }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("VALIDATION_ERROR");
    // No DB write path was entered.
    expect(l2content.confirmDraft).not.toHaveBeenCalled();
  });

  it("confirm word not found → 404 (NotFoundError via handleError)", async () => {
    // getWordBySlug throws NotFoundError (an AppError subclass → httpStatus 404).
    // The route does not wrap the call in a try/catch, so it propagates to the
    // global handleError, which maps it to 404. confirmDraft must never run.
    const words = {
      getWordBySlug: vi.fn(async () => {
        throw new NotFoundError("Word", "abandon");
      }),
    };
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {}),
    };
    const services = {
      words,
      reviews: {} as never,
      notes: {} as never,
      wordbooks: {} as never,
      stats: {} as never,
      l2Transition: {} as never,
      l2content,
    } as unknown as Services;
    const app = createApp(services);

    const content = VALID_CONTENT.collocation;
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "collocation", content }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("NOT_FOUND");
    // The word lookup ran; the service write never did.
    expect(words.getWordBySlug).toHaveBeenCalledWith("abandon");
    expect(l2content.confirmDraft).not.toHaveBeenCalled();
  });

  it("confirm service validation failure → 422 (ValidationError via handleError), no DB write", async () => {
    // confirmDraft throws a ValidationError (parseL2Content fails inside the
    // service). The route does not catch it, so handleError maps it to 422.
    // The service's parseL2Content runs BEFORE withTransaction, so no DB write
    // occurs — here we assert the route-level outcome (422) and that the mock's
    // throw happened (proving the service was reached but failed validation).
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft: vi.fn(async () => {
        throw new ValidationError(
          'Invalid L2 content for field "collocation"',
          "collocation",
        );
      }),
    };
    const services = makeMockServices(l2content);
    const app = createApp(services);

    const content = VALID_CONTENT.collocation;
    const res = await app.request("/api/l2/abandon/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "collocation", content }),
    });

    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("VALIDATION_ERROR");
    // The service was reached (route pre-check passed) but its validation threw.
    expect(l2content.confirmDraft).toHaveBeenCalledTimes(1);
  });

  it("confirm word-not-found short-circuits before confirmDraft (no DB write)", async () => {
    // Confirm the ordering: getWordBySlug runs first, and when it throws, the
    // service's confirmDraft is never invoked — guaranteeing no partial write.
    const words = {
      getWordBySlug: vi.fn(async () => {
        throw new NotFoundError("Word", "missing-word");
      }),
    };
    const confirmDraft = vi.fn(async () => {});
    const l2content = {
      generateDraft: vi.fn(),
      confirmDraft,
    };
    const services = {
      words,
      reviews: {} as never,
      notes: {} as never,
      wordbooks: {} as never,
      stats: {} as never,
      l2Transition: {} as never,
      l2content,
    } as unknown as Services;
    const app = createApp(services);

    const content = VALID_CONTENT.synonym;
    const res = await app.request("/api/l2/missing-word/confirm", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ field: "synonym", content }),
    });

    expect(res.status).toBe(404);
    expect(confirmDraft).not.toHaveBeenCalled();
  });
});
