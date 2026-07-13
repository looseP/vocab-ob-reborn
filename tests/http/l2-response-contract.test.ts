import { describe, expect, it } from "vitest";
import {
  l2ConfirmResponseSchema,
  l2DraftResponseSchema,
  l2ExternalPromptResponseSchema,
} from "../../src/http/l2-response-contract";

describe("L2 response contracts", () => {
  it("parses the exact draft response", () => {
    const response = { draft: [{ phrase: "abound in", gloss: "to have in large numbers" }] };
    expect(l2DraftResponseSchema.parse(response)).toEqual(response);

    const withSourceMode = { ...response, sourceMode: "dictionary_llm_refined" } as const;
    expect(l2DraftResponseSchema.parse(withSourceMode)).toEqual(withSourceMode);

    expect(() => l2DraftResponseSchema.parse({ ...response, sourceMode: "llm" })).toThrow();
    expect(() => l2DraftResponseSchema.parse({ ...response, extra: true })).toThrow();
    const { draft: _d, ...missing } = response;
    expect(() => l2DraftResponseSchema.parse(missing)).toThrow();
  });

  it("parses the exact external-prompt response", () => {
    const response = {
      field: "example",
      storageField: "corpus",
      styleProfileId: "default",
      promptVersion: "l2-example-external-v1",
      promptHash: "a".repeat(64),
      prompt: "Generate corpus examples for 'abound'",
      expectedJsonSchema: { type: "array", items: { type: "object" } },
    } as const;
    expect(l2ExternalPromptResponseSchema.parse(response)).toEqual(response);

    const withStyle = { ...response, styleProfileId: "style-1" };
    expect(l2ExternalPromptResponseSchema.parse(withStyle)).toEqual(withStyle);

    expect(() => l2ExternalPromptResponseSchema.parse({ ...response, field: "bogus" })).toThrow();
    expect(() => l2ExternalPromptResponseSchema.parse({ ...response, storageField: "example" })).toThrow();
    expect(() => l2ExternalPromptResponseSchema.parse({ ...response, styleProfileId: null })).toThrow();
    expect(() => l2ExternalPromptResponseSchema.parse({ ...response, promptVersion: "v1" })).toThrow();
    expect(() => l2ExternalPromptResponseSchema.parse({ ...response, promptHash: "sha256:abc" })).toThrow();
    expect(() => l2ExternalPromptResponseSchema.parse({ ...response, extra: true })).toThrow();
    const { prompt: _p, ...missing } = response;
    expect(() => l2ExternalPromptResponseSchema.parse(missing)).toThrow();
  });

  it("parses the exact confirm response", () => {
    expect(l2ConfirmResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(() => l2ConfirmResponseSchema.parse({ ok: false })).toThrow();
    expect(() => l2ConfirmResponseSchema.parse({ ok: "true" })).toThrow();
    expect(() => l2ConfirmResponseSchema.parse({ ok: true, extra: true })).toThrow();
  });
});
