import { describe, it, expect } from "vitest";
import { Word } from "@/domain/word.entity";
import { ReviewCard } from "@/domain/review.entity";
import { Note } from "@/domain/note.entity";
import { Wordbook } from "@/domain/wordbook.entity";
import type { WordRow, UserWordProgressRow, NoteRow, WordbookRow } from "@/domain";

function makeWordRow(overrides: Partial<WordRow> = {}): WordRow {
  return {
    id: "w1", slug: "aboard", title: "aboard", lemma: "aboard",
    pos: "adv", cefr: "B1", ipa: null, aliases: [],
    short_definition: "on a ship", definition_md: "md", body_md: "body",
    examples: [], metadata: { word_freq: "基础词", semantic_field: "交通" },
    source_path: "test.md", source_updated_at: null, content_hash: "abc123",
    is_published: true, is_deleted: false, created_at: "", updated_at: "",
    lang_code: "en", core_definitions: [], prototype_text: null,
    collocations: [], corpus_items: [], synonym_items: [], antonym_items: [],
    body_html: null, definition_html: null, synonym_html: null,
    antonym_html: null, quality_status: "ok", quality_issues: [],
    synced_at: "", ...overrides,
  } as WordRow;
}

function makeProgressRow(overrides: Partial<UserWordProgressRow> = {}): UserWordProgressRow {
  return {
    id: "p1", user_id: "u1", word_id: "w1", wordbook_id: "wb1",
    state: "review", stability: 1.5, difficulty: 0.3, retrievability: 0.9,
    desired_retention: 0.9, due_at: null, last_reviewed_at: null,
    last_rating: null, review_count: 3, lapse_count: 0,
    again_count: 0, hard_count: 0, good_count: 3, easy_count: 0,
    interval_days: 7, scheduler_payload: {}, content_hash_snapshot: null,
    skip_count: 0, created_at: "", updated_at: "", ...overrides,
  } as UserWordProgressRow;
}

describe("Word entity", () => {
  it("isPublished returns true when published and not deleted", () => {
    const word = new Word(makeWordRow());
    expect(word.isPublished).toBe(true);
  });

  it("isPublished returns false when deleted", () => {
    const word = new Word(makeWordRow({ is_deleted: true }));
    expect(word.isPublished).toBe(false);
  });

  it("freqLabel extracts from metadata", () => {
    const word = new Word(makeWordRow());
    expect(word.freqLabel).toBe("基础词");
  });

  it("semanticField extracts from metadata", () => {
    const word = new Word(makeWordRow());
    expect(word.semanticField).toBe("交通");
  });

  it("hasContentDrift detects hash difference", () => {
    const word = new Word(makeWordRow({ content_hash: "new" }));
    expect(word.hasContentDrift("old")).toBe(true);
    expect(word.hasContentDrift("new")).toBe(false);
    expect(word.hasContentDrift(null)).toBe(false);
  });
});

describe("ReviewCard entity", () => {
  it("isDue returns true for new card (due_at null)", () => {
    const card = new ReviewCard(makeProgressRow({ state: "new", due_at: null }),
      { id: "w1", slug: "aboard", title: "aboard", lemma: "aboard" });
    expect(card.isDue).toBe(true);
  });

  it("isDue returns false for future due_at", () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const card = new ReviewCard(makeProgressRow({ due_at: future }),
      { id: "w1", slug: "aboard", title: "aboard", lemma: "aboard" });
    expect(card.isDue).toBe(false);
  });

  it("isDue returns true for past due_at", () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const card = new ReviewCard(makeProgressRow({ due_at: past }),
      { id: "w1", slug: "aboard", title: "aboard", lemma: "aboard" });
    expect(card.isDue).toBe(true);
  });

  it("isSuspended detects suspended state", () => {
    const card = new ReviewCard(makeProgressRow({ state: "suspended" }),
      { id: "w1", slug: "aboard", title: "aboard", lemma: "aboard" });
    expect(card.isSuspended).toBe(true);
    expect(card.isAnswerable).toBe(false);
  });

  it("isLeech triggers at 8+ lapses", () => {
    const card = new ReviewCard(makeProgressRow({ lapse_count: 8 }),
      { id: "w1", slug: "aboard", title: "aboard", lemma: "aboard" });
    expect(card.isLeech).toBe(true);
  });

  it("isLeech false below threshold", () => {
    const card = new ReviewCard(makeProgressRow({ lapse_count: 7 }),
      { id: "w1", slug: "aboard", title: "aboard", lemma: "aboard" });
    expect(card.isLeech).toBe(false);
  });

  it("needsRecheck detects content drift", () => {
    const card = new ReviewCard(makeProgressRow({ content_hash_snapshot: "old" }),
      { id: "w1", slug: "aboard", title: "aboard", lemma: "aboard" });
    expect(card.needsRecheck("new")).toBe(true);
    expect(card.needsRecheck("old")).toBe(false);
  });
});

describe("Note entity", () => {
  it("shouldCreateRevision when content differs", () => {
    const note = new Note({
      id: "n1", user_id: "u1", word_id: "w1", wordbook_id: "wb1",
      content_md: "old", version: 1, created_at: "", updated_at: "",
    } as NoteRow);
    expect(note.shouldCreateRevision("new")).toBe(true);
    expect(note.shouldCreateRevision("old")).toBe(false);
  });

  it("nextVersion increments only on change", () => {
    const note = new Note({
      id: "n1", user_id: "u1", word_id: "w1", wordbook_id: "wb1",
      content_md: "same", version: 5, created_at: "", updated_at: "",
    } as NoteRow);
    expect(note.nextVersion("same")).toBe(5);
    expect(note.nextVersion("different")).toBe(6);
  });
});

describe("Wordbook entity", () => {
  it("reviewSettings extracts from JSONB", () => {
    const wb = new Wordbook({
      id: "wb1", user_id: "u1", name: "Global", is_default: true,
      settings: { review: { desired_retention: 0.85, fsrs_weights: [1, 2, 3] } },
      created_at: "", updated_at: "",
    } as WordbookRow);
    expect(wb.reviewSettings.desiredRetention).toBe(0.85);
    expect(wb.reviewSettings.fsrsWeights).toEqual([1, 2, 3]);
  });

  it("reviewSettings returns empty when no settings", () => {
    const wb = new Wordbook({
      id: "wb1", user_id: "u1", name: "Global", is_default: true,
      settings: null, created_at: "", updated_at: "",
    } as WordbookRow);
    expect(wb.reviewSettings).toEqual({});
  });
});
