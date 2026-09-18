import { describe, expect, it } from "vitest";
import {
  addSheetAnswerMark,
  ANNOTATION_AGENT_READABLE_STAGES,
  annotationReviewEntrySchema,
  annotationReviewSchema,
  annotationReviewsSectionSchema,
  buildAttemptSelfAssessment,
  buildSheetScopeKey,
  canPatchSheet,
  countRecheckQuestions,
  countUnansweredQuestions,
  hasAnswerContent,
  isAnnotationAgentReadable,
  pruneSheetAnswer,
  removeSheetAnswerMark,
  SHEET_ANSWER_MARK_SCOPES,
  SHEET_INTERACTIVE_SCOPES,
  SHEET_SCOPES,
  SHEET_STATUSES,
  SEAL_MODES,
  sheetAnswerMarkKey,
  sheetAnswerSchema,
  sheetOpenInputSchema,
  sheetPatchInputSchema,
  sheetSealInputSchema,
  sheetStatusAfterSeal,
  stripAnswerSubjectiveFields,
} from "@/domain/l3-sheets";

const SOURCE_ID = "00000000-0000-4000-8000-000000000301";
const PAPER_ID = "00000000-0000-4000-8000-000000000302";
const QUESTION_ID = "00000000-0000-4000-8000-000000000303";

describe("sheet taxonomy constants", () => {
  it("exposes the three sheet statuses and the stored scopes（W1：writing 入存储枚举）", () => {
    expect([...SHEET_STATUSES]).toEqual(["draft", "sealed", "discarded"]);
    expect([...SHEET_SCOPES]).toEqual(["file", "paper", "writing"]);
    expect([...SHEET_INTERACTIVE_SCOPES]).toEqual(["file", "paper"]);
    expect([...SEAL_MODES]).toEqual(["full", "incremental", "summary"]);
  });

  it("通用开纸输入不接受 writing（写作稿只由作文专用 POST 创建）", () => {
    expect(sheetOpenInputSchema.safeParse({ scope: "writing", paperId: PAPER_ID }).success).toBe(false);
    // 交互域仍正常。
    expect(sheetOpenInputSchema.safeParse({ scope: "paper", paperId: PAPER_ID }).success).toBe(true);
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

  it("builds the writing form as writing:<task_id>", () => {
    const taskId = "00000000-0000-4000-8000-000000000304";
    expect(buildSheetScopeKey({ scope: "writing", taskId })).toBe(`writing:${taskId}`);
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
      answers: { [QUESTION_ID]: { choice: "B" }, [PAPER_ID]: null },
    });
    expect(parsed.answers[QUESTION_ID]).toEqual({ choice: "B" });
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

describe("countUnansweredQuestions（口径统一修正：无作答内容才算未答）", () => {
  it("counts missing keys and explicit nulls as unanswered", () => {
    expect(countUnansweredQuestions(["a", "b", "c"], { a: { choice: "A" } })).toBe(2);
    expect(countUnansweredQuestions(["a", "b"], { a: null, b: { text: "译文" } })).toBe(1);
  });

  it("only trace fields (marks/flags/optionFlags) or empty objects still count as unanswered", () => {
    expect(countUnansweredQuestions(["a"], { a: { marks: [{ scope: "passage", start: 1, end: 2 }] } })).toBe(1);
    expect(countUnansweredQuestions(["a"], { a: { flags: { recheck: true } } })).toBe(1);
    expect(countUnansweredQuestions(["a"], { a: {} })).toBe(1);
  });

  it("choice / choices / text count as answered; blank strings do not", () => {
    expect(countUnansweredQuestions(["a", "b", "c"], {
      a: { choice: "B" }, b: { choices: ["A", "C"] }, c: { text: "译文" },
    })).toBe(0);
    expect(countUnansweredQuestions(["a"], { a: { choice: "   " } })).toBe(1);
  });

  it("returns zero for an empty question scope", () => {
    expect(countUnansweredQuestions([], { a: "x" })).toBe(0);
  });
});

describe("hasAnswerContent（作答内容判据，单一真源）", () => {
  it("accepts non-empty string / choice / choices / text", () => {
    expect(hasAnswerContent("free text")).toBe(true);
    expect(hasAnswerContent({ choice: "B" })).toBe(true);
    expect(hasAnswerContent({ choices: ["A"] })).toBe(true);
    expect(hasAnswerContent({ text: "译文" })).toBe(true);
  });

  it("rejects null / empty values / subjective-only shapes / unknown shapes", () => {
    expect(hasAnswerContent(null)).toBe(false);
    expect(hasAnswerContent("")).toBe(false);
    expect(hasAnswerContent({})).toBe(false);
    expect(hasAnswerContent({ choice: "" })).toBe(false);
    expect(hasAnswerContent({ choice: "   " })).toBe(false);
    expect(hasAnswerContent({ marks: [{ scope: "stem", start: 1, end: 2 }] })).toBe(false);
    expect(hasAnswerContent({ unknownShape: true })).toBe(false);
    expect(hasAnswerContent([1, 2])).toBe(false);
  });
});

describe("annotation review contract (批次三形状)", () => {
  const ANNOTATION_ID = "00000000-0000-4000-8000-000000000201";

  it("accepts a verdict-only review entry", () => {
    const parsed = annotationReviewsSectionSchema.parse({
      annotation_reviews: [{ annotation_id: ANNOTATION_ID, review: { verdict: "sound" } }],
    });
    expect(parsed.annotation_reviews[0]!.review.verdict).toBe("sound");
  });

  it("accepts corrected_tags and comment; caps tags at 8", () => {
    const ok = annotationReviewSchema.safeParse({
      verdict: "questionable",
      corrected_tags: ["偷换概念"],
      comment: "选项 B 的归因值得再核对",
    });
    expect(ok.success).toBe(true);
    expect(annotationReviewSchema.safeParse({
      verdict: "sound",
      corrected_tags: Array.from({ length: 9 }, (_, i) => `标签${i}`),
    }).success).toBe(false);
  });

  it("rejects an unknown verdict and extra keys (strict)", () => {
    expect(annotationReviewSchema.safeParse({ verdict: "maybe" }).success).toBe(false);
    expect(annotationReviewSchema.safeParse({ verdict: "sound", note: "篡改内容" }).success).toBe(false);
    expect(annotationReviewEntrySchema.safeParse({
      annotation_id: ANNOTATION_ID, review: { verdict: "sound" }, note: "越权字段",
    }).success).toBe(false);
  });

  it("caps the reviews section at 200 entries and requires the annotation_id", () => {
    expect(annotationReviewsSectionSchema.safeParse({
      annotation_reviews: Array.from({ length: 201 }, () => ({
        annotation_id: ANNOTATION_ID, review: { verdict: "sound" },
      })),
    }).success).toBe(false);
    expect(annotationReviewsSectionSchema.safeParse({
      annotation_reviews: [{ review: { verdict: "sound" } }],
    }).success).toBe(false);
  });

  it("提交即授权：仅 submitted 对 agent 可读（draft/confirmed 不开放）", () => {
    expect([...ANNOTATION_AGENT_READABLE_STAGES]).toEqual(["submitted"]);
    expect(isAnnotationAgentReadable("submitted")).toBe(true);
    expect(isAnnotationAgentReadable("draft")).toBe(false);
    expect(isAnnotationAgentReadable("confirmed")).toBe(false);
  });
});

describe("sheetAnswerSchema（v2 显式键契约，ADR-0034 增补条 8）", () => {
  it("接受三类显式键与全可选空对象", () => {
    const full = sheetAnswerSchema.safeParse({
      choice: "B",
      flags: { doubt: true, recheck: true },
      optionFlags: ["A", "C"],
      marks: [{ scope: "passage", start: 3, end: 12 }],
    });
    expect(full.success).toBe(true);
    expect(sheetAnswerSchema.safeParse({}).success).toBe(true);
    expect(sheetAnswerSchema.safeParse({ choice: "B" }).success).toBe(true);
  });

  it("strict 收口未知键（原宽松形状 selected 被拒）", () => {
    expect(sheetAnswerSchema.safeParse({ selected: "C" }).success).toBe(false);
    expect(sheetAnswerSchema.safeParse({ choice: "B", extra: 1 }).success).toBe(false);
    expect(sheetAnswerSchema.safeParse({ flags: { unknown: true } }).success).toBe(false);
  });

  it("拒绝非法 marks（scope 白名单 / end>start）", () => {
    expect(sheetAnswerSchema.safeParse({ marks: [{ scope: "note", start: 1, end: 5 }] }).success).toBe(false);
    expect(sheetAnswerSchema.safeParse({ marks: [{ scope: "stem", start: 5, end: 5 }] }).success).toBe(false);
    expect(sheetAnswerSchema.safeParse({ marks: [{ scope: "stem", start: 9, end: 3 }] }).success).toBe(false);
  });

  it("marks 同 scope+start+end 去重（重复即拒，fail-closed）", () => {
    const dup = sheetAnswerSchema.safeParse({
      marks: [{ scope: "passage", start: 3, end: 12 }, { scope: "passage", start: 3, end: 12 }],
    });
    expect(dup.success).toBe(false);
    const distinct = sheetAnswerSchema.safeParse({
      marks: [{ scope: "passage", start: 3, end: 12 }, { scope: "stem", start: 3, end: 12 }],
    });
    expect(distinct.success).toBe(true);
  });

  it("optionFlags 去重（重复选项拒绝）", () => {
    expect(sheetAnswerSchema.safeParse({ optionFlags: ["A", "A"] }).success).toBe(false);
    expect(sheetAnswerSchema.safeParse({ optionFlags: ["A", "B"] }).success).toBe(true);
  });

  it("PATCH 契约收口 answers 值形状（null 清除仍放行）", () => {
    const ok = sheetPatchInputSchema.safeParse({
      answers: { [QUESTION_ID]: { choice: "B", flags: { recheck: true } } },
    });
    expect(ok.success).toBe(true);
    const cleared = sheetPatchInputSchema.safeParse({ answers: { [QUESTION_ID]: null } });
    expect(cleared.success).toBe(true);
    const loose = sheetPatchInputSchema.safeParse({ answers: { [QUESTION_ID]: { selected: "C" } } });
    expect(loose.success).toBe(false);
  });
});

describe("marks 切换纯函数（v2 §4.6）", () => {
  const M1 = { scope: "passage" as const, start: 3, end: 12 };
  const M2 = { scope: "stem" as const, start: 3, end: 12 };

  it("sheetAnswerMarkKey 以 scope+start+end 为键", () => {
    expect(sheetAnswerMarkKey(M1)).toBe("passage:3:12");
  });

  it("addSheetAnswerMark 去重添加（重复同键幂等不增）", () => {
    const once = addSheetAnswerMark([], M1);
    expect(once).toHaveLength(1);
    const twice = addSheetAnswerMark(once, M1);
    expect(twice).toHaveLength(1);
    const crossScope = addSheetAnswerMark(twice, M2);
    expect(crossScope).toHaveLength(2);
  });

  it("removeSheetAnswerMark 存在才删（新数组，原数组不动）", () => {
    const base = [M1];
    expect(removeSheetAnswerMark(base, M1)).toHaveLength(0);
    expect(removeSheetAnswerMark(base, M2)).toHaveLength(1);
    expect(base).toHaveLength(1);
  });
});

describe("选项标记契约（验收补记：marks scope 扩至 option）", () => {
  const OM = { scope: "option" as const, optionKey: "B", start: 2, end: 6 };
  const OC = { scope: "option" as const, optionKey: "C", start: 2, end: 6 };

  it("白名单三档，接受 option 标记（optionKey 定位）", () => {
    expect([...SHEET_ANSWER_MARK_SCOPES]).toEqual(["passage", "stem", "option"]);
    expect(sheetAnswerSchema.safeParse({ marks: [OM] }).success).toBe(true);
  });

  it("option 标记必须携带 optionKey；非 option 标记不得携带", () => {
    expect(sheetAnswerSchema.safeParse({ marks: [{ scope: "option", start: 2, end: 6 }] }).success).toBe(false);
    expect(sheetAnswerSchema.safeParse({ marks: [{ scope: "passage", optionKey: "B", start: 2, end: 6 }] }).success).toBe(false);
    expect(sheetAnswerSchema.safeParse({ marks: [{ scope: "stem", optionKey: "B", start: 2, end: 6 }] }).success).toBe(false);
  });

  it("去重按 optionKey 分键：同选项同区间重复即拒；不同选项/跨 scope 同区间放行", () => {
    expect(sheetAnswerSchema.safeParse({ marks: [OM, { scope: "option", optionKey: "B", start: 2, end: 6 }] }).success).toBe(false);
    expect(sheetAnswerSchema.safeParse({ marks: [OM, OC] }).success).toBe(true);
    expect(sheetAnswerSchema.safeParse({ marks: [OM, { scope: "stem", start: 2, end: 6 }] }).success).toBe(true);
  });

  it("sheetAnswerMarkKey：option 键含 optionKey（option:B:2:6）", () => {
    expect(sheetAnswerMarkKey(OM)).toBe("option:B:2:6");
    expect(sheetAnswerMarkKey({ scope: "passage", start: 3, end: 12 })).toBe("passage:3:12");
  });

  it("add/remove 对选项标记按 optionKey 幂等", () => {
    const once = addSheetAnswerMark([], OM);
    expect(once).toHaveLength(1);
    expect(addSheetAnswerMark(once, OM)).toHaveLength(1);
    const crossOption = addSheetAnswerMark(once, OC);
    expect(crossOption).toHaveLength(2);
    expect(removeSheetAnswerMark(crossOption, OM)).toHaveLength(1);
  });
});

describe("定格物化辅助纯函数（v2 §4.6/§10）", () => {
  it("countRecheckQuestions 只数题级 recheck 为真（脏值不算）", () => {
    const answers = {
      [QUESTION_ID]: { flags: { recheck: true } },
      [SOURCE_ID]: { flags: { recheck: false } },
      [PAPER_ID]: { choice: "B" },
      "00000000-0000-4000-8000-000000000304": { flags: "dirty" },
    };
    expect(countRecheckQuestions([QUESTION_ID, SOURCE_ID, PAPER_ID, "00000000-0000-4000-8000-000000000304"], answers)).toBe(1);
  });

  it("buildAttemptSelfAssessment 提取主观状态快照（纯 choice → null）", () => {
    expect(buildAttemptSelfAssessment({
      choice: "B",
      flags: { doubt: true },
      optionFlags: ["A"],
      marks: [{ scope: "passage", start: 1, end: 4 }],
    })).toEqual({
      flags: { doubt: true },
      optionFlags: ["A"],
      marks: [{ scope: "passage", start: 1, end: 4 }],
    });
    expect(buildAttemptSelfAssessment({ choice: "B" })).toBeNull();
    expect(buildAttemptSelfAssessment(null)).toBeNull();
    expect(buildAttemptSelfAssessment("dirty")).toBeNull();
    expect(buildAttemptSelfAssessment({ flags: {} })).toBeNull();
  });

  it("recheck 随 flags 整段物化（2026-09-17 复核修订：非剥离；定格后可回看「当时想复查」）", () => {
    expect(buildAttemptSelfAssessment({ flags: { doubt: true, recheck: true } }))
      .toEqual({ flags: { doubt: true, recheck: true } });
    expect(buildAttemptSelfAssessment({ flags: { recheck: true } }))
      .toEqual({ flags: { recheck: true } });
  });

  it("pruneSheetAnswer 清理空键（全空返回 null=整体清除）", () => {
    expect(pruneSheetAnswer({ choice: "B", flags: {}, optionFlags: [], marks: [] })).toEqual({ choice: "B" });
    expect(pruneSheetAnswer({ flags: { doubt: true } })).toEqual({ flags: { doubt: true } });
    expect(pruneSheetAnswer({})).toBeNull();
    expect(pruneSheetAnswer({ flags: {} })).toBeNull();
  });

  it("stripAnswerSubjectiveFields 剥离主观字段只留作答事实", () => {
    expect(stripAnswerSubjectiveFields({
      choice: "B",
      flags: { doubt: true },
      optionFlags: ["A"],
      marks: [{ scope: "stem", start: 1, end: 4 }],
    })).toEqual({ choice: "B" });
    expect(stripAnswerSubjectiveFields({ marks: [{ scope: "stem", start: 1, end: 4 }] })).toEqual({});
    expect(stripAnswerSubjectiveFields(null)).toEqual({});
  });
});
