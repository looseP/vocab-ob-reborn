import { describe, expect, it } from "vitest";
import {
  buildSheetScopeKey,
  canPatchSheet,
  countUnansweredQuestions,
  SHEET_SCOPES,
  SHEET_STATUSES,
  SEAL_MODES,
  sheetOpenInputSchema,
  sheetPatchInputSchema,
  sheetSealInputSchema,
  sheetStatusAfterSeal,
} from "@/domain/l3-sheets";

const SOURCE_ID = "00000000-0000-4000-8000-000000000301";
const PAPER_ID = "00000000-0000-4000-8000-000000000302";
const QUESTION_ID = "00000000-0000-4000-8000-000000000303";

describe("sheet taxonomy constants", () => {
  it("exposes the three sheet statuses and two scopes", () => {
    expect([...SHEET_STATUSES]).toEqual(["draft", "sealed", "discarded"]);
    expect([...SHEET_SCOPES]).toEqual(["file", "paper"]);
    expect([...SEAL_MODES]).toEqual(["full", "incremental", "summary"]);
  });
});

describe("sheetStatusAfterSeal", () => {
  it("keeps the sheet sealed on the full-record mode", () => {
    expect(sheetStatusAfterSeal("full")).toBe("sealed");
  });

  it("discards the sheet on incremental and summary modes", () => {
    expect(sheetStatusAfterSeal("incremental")).toBe("discarded");
    expect(sheetStatusAfterSeal("summary")).toBe("discarded");
  });
});

describe("canPatchSheet", () => {
  it("allows patching only while the sheet is a draft", () => {
    expect(canPatchSheet("draft")).toBe(true);
    expect(canPatchSheet("sealed")).toBe(false);
    expect(canPatchSheet("discarded")).toBe(false);
  });
});

describe("buildSheetScopeKey", () => {
  it("builds the file form as file:<source_id>:<question_type>", () => {
    expect(buildSheetScopeKey({ scope: "file", sourceId: SOURCE_ID, questionType: "reading_choice" }))
      .toBe(`file:${SOURCE_ID}:reading_choice`);
  });

  it("builds the paper form as paper:<paper_id>", () => {
    expect(buildSheetScopeKey({ scope: "paper", paperId: PAPER_ID })).toBe(`paper:${PAPER_ID}`);
  });
});

describe("sheetOpenInputSchema", () => {
  it("accepts a file scope with sourceId and questionType", () => {
    const parsed = sheetOpenInputSchema.parse({
      scope: "file",
      sourceId: SOURCE_ID,
      questionType: "reading_choice",
    });
    expect(parsed.scope).toBe("file");
    expect(parsed.sourceId).toBe(SOURCE_ID);
  });

  it("accepts a paper scope with paperId", () => {
    const result = sheetOpenInputSchema.safeParse({ scope: "paper", paperId: PAPER_ID });
    expect(result.success).toBe(true);
  });

  it("rejects a file scope missing sourceId or questionType", () => {
    expect(sheetOpenInputSchema.safeParse({
      scope: "file", questionType: "reading_choice",
    }).success).toBe(false);
    expect(sheetOpenInputSchema.safeParse({
      scope: "file", sourceId: SOURCE_ID,
    }).success).toBe(false);
  });

  it("rejects a paper scope missing paperId and a file scope carrying paperId", () => {
    expect(sheetOpenInputSchema.safeParse({ scope: "paper" }).success).toBe(false);
    expect(sheetOpenInputSchema.safeParse({
      scope: "file", sourceId: SOURCE_ID, questionType: "cloze", paperId: PAPER_ID,
    }).success).toBe(false);
  });

  it("rejects an unknown question type", () => {
    expect(sheetOpenInputSchema.safeParse({
      scope: "file", sourceId: SOURCE_ID, questionType: "essay_dictation",
    }).success).toBe(false);
  });

  it("rejects a non-uuid sourceId", () => {
    expect(sheetOpenInputSchema.safeParse({
      scope: "file", sourceId: "src-1", questionType: "cloze",
    }).success).toBe(false);
  });
});

describe("sheetPatchInputSchema", () => {
  it("accepts per-question merge payloads including explicit nulls", () => {
    const parsed = sheetPatchInputSchema.parse({
      answers: { [QUESTION_ID]: { selected: "B" }, [PAPER_ID]: null },
    });
    expect(parsed.answers[QUESTION_ID]).toEqual({ selected: "B" });
    expect(parsed.answers[PAPER_ID]).toBeNull();
  });

  it("rejects an empty merge object", () => {
    const result = sheetPatchInputSchema.safeParse({ answers: {} });
    expect(result.success).toBe(false);
  });

  it("rejects non-uuid question keys", () => {
    expect(sheetPatchInputSchema.safeParse({ answers: { "q-1": { selected: "A" } } }).success).toBe(false);
  });

  it("rejects more than 200 merged questions in one patch", () => {
    const answers: Record<string, unknown> = {};
    for (let i = 0; i < 201; i += 1) {
      answers[`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`] = { selected: "A" };
    }
    expect(sheetPatchInputSchema.safeParse({ answers }).success).toBe(false);
  });
});

describe("sheetSealInputSchema", () => {
  it("accepts a full-record seal without summary", () => {
    const parsed = sheetSealInputSchema.parse({ mode: "full" });
    expect(parsed.mode).toBe("full");
    expect(parsed.acknowledgeUnanswered).toBe(false);
  });

  it("accepts incremental and summary modes; summary keeps its text", () => {
    expect(sheetSealInputSchema.safeParse({ mode: "incremental" }).success).toBe(true);
    const parsed = sheetSealInputSchema.parse({ mode: "summary", summary: "本次全对，只留元认知" });
    expect(parsed.summary).toBe("本次全对，只留元认知");
  });

  it("rejects a summary-mode seal without summary text", () => {
    const result = sheetSealInputSchema.safeParse({ mode: "summary" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("总结"))).toBe(true);
    }
  });

  it("rejects an unknown mode and over-long summary", () => {
    expect(sheetSealInputSchema.safeParse({ mode: "partial" }).success).toBe(false);
    expect(sheetSealInputSchema.safeParse({
      mode: "full", summary: "x".repeat(2001),
    }).success).toBe(false);
  });

  it("carries the unanswered confirmation flag when explicitly set", () => {
    const parsed = sheetSealInputSchema.parse({ mode: "full", acknowledgeUnanswered: true });
    expect(parsed.acknowledgeUnanswered).toBe(true);
  });
});

describe("countUnansweredQuestions", () => {
  it("counts missing keys and explicit nulls as unanswered", () => {
    expect(countUnansweredQuestions(["a", "b", "c"], { a: { selected: "A" } })).toBe(2);
    expect(countUnansweredQuestions(["a", "b"], { a: null, b: { text: "译文" } })).toBe(1);
  });

  it("returns zero when every scoped question is answered", () => {
    expect(countUnansweredQuestions(["a"], { a: 0 })).toBe(0);
  });

  it("returns zero for an empty question scope", () => {
    expect(countUnansweredQuestions([], { a: "x" })).toBe(0);
  });
});
