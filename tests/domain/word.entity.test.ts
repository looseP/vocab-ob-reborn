// tests/domain/word.entity.test.ts
import { describe, it, expect } from "vitest";
import { Word } from "@/domain/word.entity";
import type { WordRow } from "@/domain";

const makeRow = (over: Record<string, unknown> = {}): WordRow =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "w",
    title: "w",
    lemma: "w",
    pos: "n",
    cefr: "B2",
    ipa: null,
    aliases: [],
    short_definition: "s",
    definition_md: "",
    body_md: null,
    examples: [],
    prototype_text: null,
    metadata: null,
    content_hash: "h",
    is_published: true,
    is_deleted: false,
    ...over,
  }) as unknown as WordRow;

describe("Word.toDetail core_definitions fallback", () => {
  it("falls back to an empty array when the column is absent", () => {
    expect(new Word(makeRow()).toDetail().core_definitions).toEqual([]);
  });

  it("falls back to an empty array when the column holds a dirty non-array value", () => {
    expect(new Word(makeRow({ core_definitions: null })).toDetail().core_definitions).toEqual([]);
    expect(new Word(makeRow({ core_definitions: "not-an-array" })).toDetail().core_definitions).toEqual([]);
  });

  it("passes a well-formed sense array through unchanged", () => {
    const senses = [{ pos: "n", definition: "a unit of language" }];
    expect(new Word(makeRow({ core_definitions: senses })).toDetail().core_definitions).toEqual(senses);
  });
});
