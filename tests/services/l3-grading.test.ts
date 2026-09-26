import { describe, expect, it, vi } from "vitest";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/errors";
import type {
  L3GradingResultRow,
  L3QuestionAnnotationRow,
  L3QuestionAttemptRow,
  L3QuestionRow,
  L3SourceRow,
  L3SubmissionRow,
} from "@/domain";
import type {
  IL3AnnotationRepository,
  IL3ContextRepository,
  IL3GradingRepository,
  IL3PaperRepository,
  IL3SheetRepository,
  IRepositories,
} from "@/repositories/interfaces";
import { L3GradingService } from "@/services/l3-grading.service";

const USER = "00000000-0000-4000-8000-000000000001";
const SHEET = "00000000-0000-4000-8000-000000000401";
const SOURCE = "00000000-0000-4000-8000-000000000301";
const SOURCE_B = "00000000-0000-4000-8000-000000000302";
const Q1 = "00000000-0000-4000-8000-000000000101";
const Q2 = "00000000-0000-4000-8000-000000000102";
const A1 = "00000000-0000-4000-8000-000000000201";
const A2 = "00000000-0000-4000-8000-000000000202";
const A3 = "00000000-0000-4000-8000-000000000203";

function sheetRow(overrides: Partial<L3SubmissionRow> = {}): L3SubmissionRow {
  return {
    id: SHEET,
    user_id: USER,
    scope: "file",
    scope_key: `file:${SOURCE}:reading_choice`,
    source_id: SOURCE,
    question_type: "reading_choice",
    paper_id: null,
    writing_task_id: null,
    parent_sheet_id: null,
    revision_no: null,
    draft_version: 0,
    question_ids: null,
    status: "sealed",
    answers: {},
    seal_mode: "full",
    summary: null,
    sealed_at: "2026-09-17T00:00:00Z",
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function questionRow(id: string, overrides: Partial<L3QuestionRow> = {}): L3QuestionRow {
  return {
    id,
    user_id: USER,
    source_id: SOURCE,
    file_key: null,
    space: "阅读",
    question_type: "reading_choice",
    ordinal: 0,
    stem: `题干 ${id.slice(-3)}`,
    options: [{ key: "A", text: "选项 A" }, { key: "B", text: "选项 B" }],
    answer: { choice: "B" },
    explanation: "定位第二段。",
    evidence: [],
    status: "active",
    created_by: "owner",
    input_hash: null,
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
    ...overrides,
  };
}

function attemptRow(questionId: string, overrides: Partial<L3QuestionAttemptRow> = {}): L3QuestionAttemptRow {
  return {
    id: `attempt-${questionId.slice(-3)}`,
    user_id: USER,
    question_id: questionId,
    sheet_id: SHEET,
    venue: "file",
    answer: { choice: "A" },
    self_assessment: { flags: { doubt: true } },
    status: "active",
    deleted_at: null,
    created_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function annotationRow(overrides: Partial<L3QuestionAnnotationRow> = {}): L3QuestionAnnotationRow {
  return {
    id: A1,
    user_id: USER,
    question_id: Q1,
    ordinal: 0,
    anchor_start: 12,
    anchor_end: 20,
    excerpt: "trap phrase",
    note: "选项 B 偷换概念",
    entry_tags: ["推断题"],
    option_tags: { B: ["偷换概念"] },
    stage: "submitted",
    sheet_id: SHEET,
    review: null,
    review_sheet_id: null,
    status: "active",
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
    ...overrides,
  };
}

function sourceRow(id: string, overrides: Partial<L3SourceRow> = {}): L3SourceRow {
  return {
    id,
    user_id: USER,
    wordbook_id: null,
    source_type: "article",
    title: `原文 ${id.slice(-3)}`,
    author: null,
    url: null,
    language: "en",
    metadata: {},
    content_text: "The passage content.",
    content_hash: null,
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
    ...overrides,
  };
}

function gradingRow(questionId: string, overrides: Partial<L3GradingResultRow> = {}): L3GradingResultRow {
  return {
    id: `grading-${questionId.slice(-3)}`,
    user_id: USER,
    sheet_id: SHEET,
    question_id: questionId,
    verdict: "wrong",
    analysis_md: null,
    graded_by: "agent-a",
    graded_at: "2026-09-17T01:00:00Z",
    ...overrides,
  };
}

interface ServiceDeps {
  grading?: Partial<IL3GradingRepository>;
  sheets?: Partial<IL3SheetRepository>;
  paper?: Partial<IL3PaperRepository>;
  annotations?: Partial<IL3AnnotationRepository>;
  context?: Partial<IL3ContextRepository>;
}

function makeService(deps: ServiceDeps = {}): L3GradingService {
  const gradingRepo = {
    listBySheet: vi.fn(async () => []),
    upsertResults: vi.fn(async () => []),
    ...deps.grading,
  } as IL3GradingRepository;
  const sheetRepo = {
    getSheet: vi.fn(async () => sheetRow()),
    listBySheet: vi.fn(async () => []),
    ...deps.sheets,
  } as unknown as IL3SheetRepository;
  const paperRepo = {
    listActiveQuestionsForFile: vi.fn(async () => [questionRow(Q1), questionRow(Q2, { ordinal: 1 })]),
    findPaperById: vi.fn(async () => null),
    findActiveQuestionsByIds: vi.fn(async () => []),
    ...deps.paper,
  } as unknown as IL3PaperRepository;
  const annotationRepo = {
    listAnnotationsBySheet: vi.fn(async () => []),
    applyAnnotationReview: vi.fn(async () => annotationRow()),
    confirmAnnotation: vi.fn(async () => null),
    getAnnotation: vi.fn(async () => null),
    ...deps.annotations,
  } as unknown as IL3AnnotationRepository;
  const contextRepo = {
    findSourceById: vi.fn(async () => sourceRow(SOURCE)),
    ...deps.context,
  } as unknown as IL3ContextRepository;

  return new L3GradingService(
    gradingRepo,
    sheetRepo,
    paperRepo,
    annotationRepo,
    contextRepo,
    async (callback) => callback({} as never),
    () => ({
      l3Grading: gradingRepo,
      l3Sheets: sheetRepo,
      l3Paper: paperRepo,
      l3Annotations: annotationRepo,
      l3Context: contextRepo,
    } as unknown as IRepositories),
  );
}

describe("L3GradingService.getGradingContext", () => {
  it("404s when the sheet is missing or not owned", async () => {
    const service = makeService({ sheets: { getSheet: vi.fn(async () => null) } });
    await expect(service.getGradingContext(USER, SHEET)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("409s for draft and discarded sheets (双重防护)", async () => {
    const draft = makeService({ sheets: { getSheet: vi.fn(async () => sheetRow({ status: "draft" })) } });
    await expect(draft.getGradingContext(USER, SHEET)).rejects.toBeInstanceOf(ConflictError);
    const discarded = makeService({ sheets: { getSheet: vi.fn(async () => sheetRow({ status: "discarded" })) } });
    await expect(discarded.getGradingContext(USER, SHEET)).rejects.toBeInstanceOf(ConflictError);
  });

  it("assembles the sealed context: answerIndex + latest active attempt + submitted-only notes + source", async () => {
    const service = makeService({
      sheets: {
        listBySheet: vi.fn(async () => [
          attemptRow(Q1, { id: "attempt-old", status: "deleted", deleted_at: "2026-09-17T02:00:00Z" }),
          attemptRow(Q1, { id: "attempt-new" }),
        ]),
      },
      annotations: {
        listAnnotationsBySheet: vi.fn(async () => [
          annotationRow({ id: A1, stage: "submitted" }),
          annotationRow({ id: A2, stage: "confirmed" }),
          annotationRow({ id: A3, question_id: Q2, stage: "draft" }),
        ]),
      },
    });
    const result = await service.getGradingContext(USER, SHEET);
    expect(result.sheet.status).toBe("sealed");
    expect(result.questions).toHaveLength(2);
    const q1 = result.questions[0]!;
    expect(q1.answerIndex).toEqual({ choice: "B" });
    expect(q1.attempt?.answer).toEqual({ choice: "A" });
    expect(q1.annotations.map((row) => row.id)).toEqual([A1]);
    const q2 = result.questions[1]!;
    expect(q2.annotations).toEqual([]);
    expect(q2.attempt).toBeNull();
    expect(result.sources).toEqual([{ id: SOURCE, title: "原文 301", content_text: "The passage content." }]);
  });

  it("dedupes multiple sources for the paper venue", async () => {
    const paperSheet = sheetRow({ scope: "paper", source_id: null, question_type: null, paper_id: "00000000-0000-4000-8000-000000000501" });
    const paper = {
      id: "00000000-0000-4000-8000-000000000501",
      user_id: USER,
      title: "整卷",
      direction: null,
      metadata: {},
      payload: { version: 1, sections: [{ key: "s1", title: "阅读", questionType: "reading_choice", sourceId: SOURCE, fileKey: null, questionIds: [Q1, Q2] }] },
      payload_version: 1,
      status: "active",
      created_by: "owner",
      input_hash: null,
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    };
    const service = makeService({
      sheets: { getSheet: vi.fn(async () => paperSheet) },
      paper: {
        findPaperById: vi.fn(async () => paper as never),
        findActiveQuestionsByIds: vi.fn(async () => [
          questionRow(Q1, { source_id: SOURCE }),
          questionRow(Q2, { source_id: SOURCE_B, ordinal: 1 }),
        ]),
      },
      context: {
        findSourceById: vi.fn(async (_userId: string, sourceId: string) => sourceRow(sourceId)),
      },
    });
    const result = await service.getGradingContext(USER, SHEET);
    expect(result.sources.map((source) => source.id)).toEqual([SOURCE, SOURCE_B]);
    expect(result.questions[1]!.source_id).toBe(SOURCE_B);
  });
});

describe("L3GradingService.getGradingResults", () => {
  it("returns the verdict rows for a sealed sheet", async () => {
    const listBySheet = vi.fn(async () => [gradingRow(Q1)]);
    const service = makeService({ grading: { listBySheet } });
    const result = await service.getGradingResults(USER, SHEET);
    expect(result.results).toHaveLength(1);
    expect(listBySheet).toHaveBeenCalledWith(USER, SHEET);
  });

  it("409s for non-sealed sheets", async () => {
    const service = makeService({ sheets: { getSheet: vi.fn(async () => sheetRow({ status: "draft" })) } });
    await expect(service.getGradingResults(USER, SHEET)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("L3GradingService.submitGrading", () => {
  it("upserts results with server-side graded_by and auto-confirms sound reviews", async () => {
    const upsertResults = vi.fn(async (inputs: { graded_by: string }[]) => inputs.map((input) => gradingRow(Q1, { graded_by: input.graded_by })));
    const applyAnnotationReview = vi.fn(async () => annotationRow({ stage: "confirmed" }));
    const service = makeService({
      grading: { upsertResults: upsertResults as never },
      annotations: {
        listAnnotationsBySheet: vi.fn(async () => [annotationRow({ id: A1, stage: "submitted" })]),
        applyAnnotationReview,
      },
    });
    const result = await service.submitGrading({
      userId: USER,
      sheetId: SHEET,
      gradedBy: "agent-a",
      results: [{
        questionId: Q1,
        verdict: "wrong",
        analysisMd: "定位偏移。",
        annotationReviews: [{ annotationId: A1, verdict: "sound", correctedTags: ["细节题"], comment: "锚点准确" }],
      }],
    });
    expect(upsertResults).toHaveBeenCalledWith([
      { user_id: USER, sheet_id: SHEET, question_id: Q1, verdict: "wrong", analysis_md: "定位偏移。", graded_by: "agent-a" },
    ]);
    expect(applyAnnotationReview).toHaveBeenCalledWith(USER, A1, { verdict: "sound", corrected_tags: ["细节题"], comment: "锚点准确" }, "confirmed", SHEET);
    expect(result).toMatchObject({ resultCount: 1, annotationReviewCount: 1, confirmedCount: 1 });
  });

  it("keeps questionable/wrong on submitted and never downgrades confirmed (终态不回滚)", async () => {
    const applyAnnotationReview = vi.fn(async () => annotationRow());
    const service = makeService({
      grading: { upsertResults: vi.fn(async () => [gradingRow(Q1)]) as never },
      annotations: {
        listAnnotationsBySheet: vi.fn(async () => [
          annotationRow({ id: A1, stage: "confirmed" }),
          annotationRow({ id: A2, stage: "submitted" }),
        ]),
        applyAnnotationReview,
      },
    });
    const result = await service.submitGrading({
      userId: USER,
      sheetId: SHEET,
      gradedBy: "owner",
      results: [{
        questionId: Q1,
        verdict: "partial",
        annotationReviews: [
          { annotationId: A1, verdict: "questionable" },
          { annotationId: A2, verdict: "wrong" },
        ],
      }],
    });
    expect(applyAnnotationReview).toHaveBeenNthCalledWith(1, USER, A1, { verdict: "questionable" }, "confirmed", SHEET);
    expect(applyAnnotationReview).toHaveBeenNthCalledWith(2, USER, A2, { verdict: "wrong" }, "submitted", SHEET);
    expect(result).toMatchObject({ annotationReviewCount: 2, confirmedCount: 0 });
  });

  it("422s for questionIds outside the sheet scope", async () => {
    const service = makeService({ paper: { listActiveQuestionsForFile: vi.fn(async () => [questionRow(Q1)]) } });
    await expect(service.submitGrading({
      userId: USER,
      sheetId: SHEET,
      gradedBy: "agent-a",
      results: [{ questionId: Q2, verdict: "correct" }],
    })).rejects.toBeInstanceOf(BusinessRuleError);
  });

  it("422s for annotationIds outside the reviewable set (draft notes not authorized)", async () => {
    const upsertResults = vi.fn(async () => []);
    const service = makeService({
      grading: { upsertResults: upsertResults as never },
      annotations: {
        listAnnotationsBySheet: vi.fn(async () => [annotationRow({ id: A3, stage: "draft", question_id: Q2 })]),
      },
    });
    await expect(service.submitGrading({
      userId: USER,
      sheetId: SHEET,
      gradedBy: "agent-a",
      results: [{ questionId: Q1, verdict: "correct", annotationReviews: [{ annotationId: A3, verdict: "wrong" }] }],
    })).rejects.toBeInstanceOf(BusinessRuleError);
    expect(upsertResults).not.toHaveBeenCalled();
  });

  it("409s for non-sealed sheets", async () => {
    const service = makeService({ sheets: { getSheet: vi.fn(async () => sheetRow({ status: "discarded" })) } });
    await expect(service.submitGrading({
      userId: USER,
      sheetId: SHEET,
      gradedBy: "agent-a",
      results: [{ questionId: Q1, verdict: "correct" }],
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("aborts the whole submission when a review write races with a stage change", async () => {
    const service = makeService({
      grading: { upsertResults: vi.fn(async () => [gradingRow(Q1)]) as never },
      annotations: {
        listAnnotationsBySheet: vi.fn(async () => [annotationRow({ id: A1, stage: "submitted" })]),
        applyAnnotationReview: vi.fn(async () => null),
      },
    });
    await expect(service.submitGrading({
      userId: USER,
      sheetId: SHEET,
      gradedBy: "agent-a",
      results: [{ questionId: Q1, verdict: "correct", annotationReviews: [{ annotationId: A1, verdict: "sound" }] }],
    })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("L3GradingService.confirmAnnotation", () => {
  it("confirms a submitted annotation via the owner channel", async () => {
    const item = annotationRow({ stage: "confirmed" });
    const service = makeService({ annotations: { confirmAnnotation: vi.fn(async () => item) } });
    await expect(service.confirmAnnotation(USER, A1)).resolves.toEqual({ item });
  });

  it("404s when the annotation is missing or not owned", async () => {
    const service = makeService({ annotations: { confirmAnnotation: vi.fn(async () => null), getAnnotation: vi.fn(async () => null) } });
    await expect(service.confirmAnnotation(USER, A1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("409s when the annotation is not submitted", async () => {
    const service = makeService({
      annotations: {
        confirmAnnotation: vi.fn(async () => null),
        getAnnotation: vi.fn(async () => annotationRow({ stage: "confirmed" })),
      },
    });
    await expect(service.confirmAnnotation(USER, A1)).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("L3GradingService 对 writing 稿的 generic 封堵（W5 防两套反馈真源）", () => {
  const writingSheet = (): L3SubmissionRow => sheetRow({
    scope: "writing",
    scope_key: "writing:00000000-0000-4000-8000-000000000701",
    source_id: null,
    question_type: null,
    writing_task_id: "00000000-0000-4000-8000-000000000701",
  });

  it("context / results / submit 三入口对 writing 稿一律 409 WRITING_ENDPOINT_REQUIRED", async () => {
    const service = makeService({ sheets: { getSheet: vi.fn(async () => writingSheet()) } });
    await expect(service.getGradingContext(USER, SHEET))
      .rejects.toMatchObject({ httpStatus: 409, meta: { code: "WRITING_ENDPOINT_REQUIRED" } });
    await expect(service.getGradingResults(USER, SHEET))
      .rejects.toMatchObject({ httpStatus: 409, meta: { code: "WRITING_ENDPOINT_REQUIRED" } });
    await expect(service.submitGrading({
      userId: USER,
      sheetId: SHEET,
      gradedBy: "agent-a",
      results: [{ questionId: Q1, verdict: "correct" }],
    })).rejects.toMatchObject({ httpStatus: 409, meta: { code: "WRITING_ENDPOINT_REQUIRED" } });
  });
});
