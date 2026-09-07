// tests/l3-trio.test.ts
import { describe, it, expect } from "vitest";
import { buildL3TrioInputs, CONTEXT_TYPE_BY_LENGTH } from "@/services/l3-trio";

describe("buildL3TrioInputs", () => {
  const base = { userId: "u1", wordId: "w-1", lemma: "ephemeral" };

  it("builds web source + short sentence context with offsets", () => {
    const trio = buildL3TrioInputs({
      ...base,
      sentence: "The ephemeral beauty of cherry blossoms.",
      sourceUrl: "https://example.com/a",
    });
    expect(trio.source).toEqual({
      user_id: "u1",
      wordbook_id: null,
      source_type: "web",
      title: "https://example.com/a",
      author: null,
      url: "https://example.com/a",
      language: null,
      metadata: {},
      content_text: null,
      content_hash: null,
    });
    expect(trio.context.context_type).toBe("sentence");
    expect(trio.context.text).toBe("The ephemeral beauty of cherry blossoms.");
    expect(trio.occurrence.start_offset).toBe(4);
    expect(trio.occurrence.end_offset).toBe(13);
    expect(trio.occurrence.surface).toBe("ephemeral");
  });

  it("uses manual source with obsidianRef metadata when no url", () => {
    const trio = buildL3TrioInputs({ ...base, sentence: "句子", obsidianRef: "D:/Notes/阅读.md" });
    expect(trio.source.source_type).toBe("manual");
    expect(trio.source.title).toBe("手动记录");
    expect(trio.source.metadata).toEqual({ obsidianRef: "D:/Notes/阅读.md" });
  });

  it("classifies context_type by length boundary (<=200 sentence)", () => {
    expect(CONTEXT_TYPE_BY_LENGTH("a".repeat(200))).toBe("sentence");
    expect(CONTEXT_TYPE_BY_LENGTH("a".repeat(201))).toBe("paragraph");
  });

  it("falls back to null offsets when lemma not found in sentence", () => {
    const trio = buildL3TrioInputs({ ...base, sentence: "no match here" });
    expect(trio.occurrence.start_offset).toBeNull();
    expect(trio.occurrence.end_offset).toBeNull();
  });
});
