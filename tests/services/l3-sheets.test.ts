import { describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@/errors";
import type { L3QuestionAttemptRow, L3QuestionRow, L3SubmissionRow } from "@/domain";
import type {
  IRepositories,
  IL3AnnotationRepository,
  IL3ContextRepository,
  IL3PaperRepository,
  IL3SheetRepository,
} from "@/repositories/interfaces";
import { L3SheetService } from "@/services/l3-sheets.service";

const USER = "00000000-0000-4000-8000-000000000001";
const SHEET = "00000000-0000-4000-8000-000000000401";
const SOURCE = "00000000-0000-4000-8000-000000000302";
const PAPER = "00000000-0000-4000-8000-000000000303";
const Q1 = "00000000-0000-4000-8000-000000000101";
const Q2 = "00000000-0000-4000-8000-000000000102";

function submissionRow(overrides: Partial<L3SubmissionRow> = {}): L3SubmissionRow {
  return {
    id: SHEET,
    user_id: USER,
    scope: "file",
    scope_key: `file:${SOURCE}:reading_choice`,
    source_id: SOURCE,
    question_type: "reading_choice",
    paper_id: null,
    status: "draft",
    answers: {},
    seal_mode: null,
    summary: null,
    sealed_at: null,
    created_at: "2026-09-17T00:00:00.000Z",
    updated_at: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

function questionRow(overrides: Partial<L3QuestionRow> = {}): L3QuestionRow {
  return {
    id: Q1,
    user_id: USER,
    source_id: SOURCE,
    file_key: null,
    space: "阅读",
    question_type: "reading_choice",
    ordinal: 0,
    stem: "题干",
    options: [],
    answer: {},
    explanation: null,
    evidence: [],
    status: "active",
    created_by: "owner",
    input_hash: null,
    created_at: "2026-09-17T00:00:00.000Z",
    updated_at: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

function attemptRow(overrides: Partial<L3QuestionAttemptRow> = {}): L3QuestionAttemptRow {
  return {
    id: "00000000-0000-4000-8000-000000000501",
    user_id: USER,
    question_id: Q1,
    sheet_id: SHEET,
    venue: "file",
    answer: { selected: "B" },
    self_assessment: null,
    status: "active",
    deleted_at: null,
    created_at: "2026-09-17T01:00:00.000Z",
    ...overrides,
  };
}

function makeSheetRepo(overrides: Partial<IL3SheetRepository> = {}): IL3SheetRepository {
  return {
    findDraftByScopeKey: vi.fn(async () => null),
    openSheet: vi.fn(async () => ({ row: submissionRow(), created: true })),
    patchAnswers: vi.fn(async () => submissionRow()),
    sealSheet: vi.fn(async () => submissionRow({ status: "sealed" })),
    getSheet: vi.fn(async () => submissionRow()),
    insertAttempts: vi.fn(async () => []),
    listForQuestions: vi.fn(async () => []),
    softDeleteAttempt: vi.fn(async () => true),
    listBySheet: vi.fn(async () => []),
    countAnsweredBySheet: vi.fn(async () => 0),
    ...overrides,
  } as IL3SheetRepository;
}

function makePaperRepo(overrides: Partial<IL3PaperRepository> = {}): IL3PaperRepository {
  return {
    insertQuestion: vi.fn(),
    findQuestionById: vi.fn(),
    findActiveQuestionsByIds: vi.fn(async () => []),
    listActiveQuestionsForFile: vi.fn(async () => []),
    listPracticeFiles: vi.fn(),
    deleteQuestion: vi.fn(),
    listActivePaperRefsWithPayload: vi.fn(),
    insertPaper: vi.fn(),
    findPaperById: vi.fn(),
    listPapers: vi.fn(),
    ...overrides,
  } as unknown as IL3PaperRepository;
}

function makeContextRepo(source: { id: string } | null): IL3ContextRepository {
  return { findSourceById: vi.fn(async () => source) } as unknown as IL3ContextRepository;
}

function makeAnnotationRepo(overrides: Partial<IL3AnnotationRepository> = {}): IL3AnnotationRepository {
  return {
    listForQuestions: vi.fn(async () => []),
    findByAnchor: vi.fn(async () => null),
    insertAnnotation: vi.fn(),
    updateAnnotation: vi.fn(),
    softDeleteAnnotation: vi.fn(),
    listTags: vi.fn(async () => []),
    replaceTags: vi.fn(async () => []),
    listDraftBySheet: vi.fn(async () => []),
    listAnnotationsBySheet: vi.fn(async () => []),
    promoteBySheet: vi.fn(async () => []),
    insertSummaryAnnotation: vi.fn(),
    ...overrides,
  } as unknown as IL3AnnotationRepository;
}

function makeService(
  sheetRepo: IL3SheetRepository,
  paperRepo: IL3PaperRepository = makePaperRepo(),
  annotationRepo: IL3AnnotationRepository = makeAnnotationRepo(),
  contextRepo: IL3ContextRepository = makeContextRepo({ id: SOURCE }),
): L3SheetService {
  return new L3SheetService(
    sheetRepo,
    paperRepo,
    annotationRepo,
    async (callback) => callback({} as never),
    () => ({
      l3Sheets: sheetRepo,
      l3Paper: paperRepo,
      l3Annotations: annotationRepo,
      l3Context: contextRepo,
    } as unknown as IRepositories),
  );
}

/** file venue 的标准题组装置：两题（Q1 答、Q2 未答由用例决定）。 */
function fileScopedPaperRepo(): IL3PaperRepository {
  return makePaperRepo({
    listActiveQuestionsForFile: vi.fn(async () => [
      questionRow({ id: Q1, ordinal: 0 }),
      questionRow({ id: Q2, ordinal: 1 }),
    ]),
  });
}

describe("L3SheetService.openSheet", () => {
  it("resolves the scope key and reuses or creates by identity", async () => {
    const sheetRepo = makeSheetRepo({
      openSheet: vi.fn(async (input) => ({
        row: submissionRow({ scope_key: input.scope_key, source_id: input.source_id, question_type: input.question_type }),
        created: true,
      })),
    });
    const service = makeService(sheetRepo, makePaperRepo(), makeAnnotationRepo(), makeContextRepo({ id: SOURCE }));
    const result = await service.openSheet({
      userId: USER, scope: "file", sourceId: SOURCE, questionType: "reading_choice",
    });
    expect(result.created).toBe(true);
    expect(sheetRepo.openSheet).toHaveBeenCalledWith(expect.objectContaining({
      scope_key: `file:${SOURCE}:reading_choice`,
      source_id: SOURCE,
      question_type: "reading_choice",
      paper_id: null,
    }));
  });

  it("surfaces idempotent reuse as created=false", async () => {
    const sheetRepo = makeSheetRepo({
      openSheet: vi.fn(async () => ({ row: submissionRow(), created: false })),
    });
    const service = makeService(sheetRepo);
    const result = await service.openSheet({ userId: USER, scope: "file", sourceId: SOURCE, questionType: "reading_choice" });
    expect(result.created).toBe(false);
  });

  it("404s when the source or paper does not belong to the owner", async () => {
    const service = makeService(makeSheetRepo(), makePaperRepo(), makeAnnotationRepo(), makeContextRepo(null));
    await expect(service.openSheet({ userId: USER, scope: "file", sourceId: SOURCE, questionType: "reading_choice" }))
      .rejects.toBeInstanceOf(NotFoundError);

    const paperService = makeService(makeSheetRepo(), makePaperRepo({ findPaperById: vi.fn(async () => null) }));
    await expect(paperService.openSheet({ userId: USER, scope: "paper", paperId: PAPER }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("validates the scope shape before touching repositories", async () => {
    const sheetRepo = makeSheetRepo();
    const service = makeService(sheetRepo);
    await expect(service.openSheet({ userId: USER, scope: "file" } as never))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(service.openSheet({ userId: USER, scope: "paper" } as never))
      .rejects.toBeInstanceOf(ValidationError);
    expect(sheetRepo.openSheet).not.toHaveBeenCalled();
  });

  it("builds the paper scope key for paper venue", async () => {
    const sheetRepo = makeSheetRepo();
    const paperRepo = makePaperRepo({ findPaperById: vi.fn(async () => ({ id: PAPER } as never)) });
    const service = makeService(sheetRepo, paperRepo);
    await service.openSheet({ userId: USER, scope: "paper", paperId: PAPER });
    expect(sheetRepo.openSheet).toHaveBeenCalledWith(expect.objectContaining({
      scope_key: `paper:${PAPER}`,
      paper_id: PAPER,
      source_id: null,
      question_type: null,
    }));
  });
});

describe("L3SheetService.getSheet", () => {
  it("404s for a missing or foreign sheet", async () => {
    const service = makeService(makeSheetRepo({ getSheet: vi.fn(async () => null) }));
    await expect(service.getSheet(USER, SHEET)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns draft sheets with answers and no derived rows", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { selected: "B" } } })),
    });
    const service = makeService(sheetRepo);
    const result = await service.getSheet(USER, SHEET);
    expect(result.sheet.answers[Q1]).toEqual({ selected: "B" });
    expect(result.attempts).toEqual([]);
    expect(sheetRepo.listBySheet).not.toHaveBeenCalled();
  });

  it("derives settled rows in scope order and shades deleted content", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ status: "sealed", answers: {} })),
      listBySheet: vi.fn(async () => [
        attemptRow({ id: "00000000-0000-4000-8000-000000000503", question_id: Q2, created_at: "2026-09-17T02:00:00.000Z" }),
        attemptRow({
          id: "00000000-0000-4000-8000-000000000502", question_id: Q1, created_at: "2026-09-17T01:00:00.000Z",
          status: "deleted", deleted_at: "2026-09-17T03:00:00.000Z",
        }),
      ]),
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());
    const result = await service.getSheet(USER, SHEET);
    expect(result.attempts.map((row) => row.question_id)).toEqual([Q1, Q2]);
    expect(result.attempts[0]!.status).toBe("deleted");
    expect(result.attempts[0]!.answer).toBeNull();
    expect(result.attempts[1]!.answer).toEqual({ selected: "B" });
  });
});

describe("L3SheetService.patchSheet", () => {
  it("returns the merged sheet when the conditional update wins", async () => {
    const sheetRepo = makeSheetRepo({
      patchAnswers: vi.fn(async () => submissionRow({ answers: { [Q1]: { selected: "C" } } })),
    });
    const service = makeService(sheetRepo);
    const result = await service.patchSheet({ userId: USER, sheetId: SHEET, answers: { [Q1]: { selected: "C" } } });
    expect(result.sheet.answers[Q1]).toEqual({ selected: "C" });
  });

  it("404s when the sheet is missing and 409s when it is settled", async () => {
    const missing = makeService(makeSheetRepo({
      patchAnswers: vi.fn(async () => null),
      getSheet: vi.fn(async () => null),
    }));
    await expect(missing.patchSheet({ userId: USER, sheetId: SHEET, answers: { [Q1]: null } }))
      .rejects.toBeInstanceOf(NotFoundError);

    const settled = makeService(makeSheetRepo({
      patchAnswers: vi.fn(async () => null),
      getSheet: vi.fn(async () => submissionRow({ status: "sealed" })),
    }));
    await expect(settled.patchSheet({ userId: USER, sheetId: SHEET, answers: { [Q1]: null } }))
      .rejects.toBeInstanceOf(ConflictError);
  });
});

describe("L3SheetService.sealSheet", () => {
  it("404s for a missing sheet and 409s for a settled one", async () => {
    const missing = makeService(makeSheetRepo({ getSheet: vi.fn(async () => null) }));
    await expect(missing.sealSheet({ userId: USER, sheetId: SHEET, mode: "full", acknowledgeUnanswered: false }))
      .rejects.toBeInstanceOf(NotFoundError);

    const settled = makeService(makeSheetRepo({ getSheet: vi.fn(async () => submissionRow({ status: "sealed" })) }));
    await expect(settled.sealSheet({ userId: USER, sheetId: SHEET, mode: "full", acknowledgeUnanswered: false }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("409s with the unanswered count until the caller confirms", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { selected: "B" } } })),
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());
    const rejected = await service.sealSheet({
      userId: USER, sheetId: SHEET, mode: "full", acknowledgeUnanswered: false,
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ConflictError);
    expect((rejected as ConflictError).meta).toMatchObject({ unansweredCount: 1 });
    expect(sheetRepo.sealSheet).not.toHaveBeenCalled();

    const confirmed = await service.sealSheet({
      userId: USER, sheetId: SHEET, mode: "full", acknowledgeUnanswered: true,
    });
    expect(confirmed.unansweredCount).toBe(1);
  });

  it("full mode materializes answered attempts in scope order and promotes notes", async () => {
    const insertAttempts = vi.fn(async (_userId: string, attempts: readonly { question_id: string }[]) =>
      attempts.map((attempt, index) => attemptRow({ id: `00000000-0000-4000-8000-00000000060${index}`, question_id: attempt.question_id })));
    const promoteBySheet = vi.fn(async () => [{ id: "annotation-1" }]);
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { selected: "B" }, [Q2]: { text: "译文" } } })),
      sealSheet: vi.fn(async () => submissionRow({ status: "sealed", seal_mode: "full", sealed_at: "2026-09-17T04:00:00.000Z" })),
      insertAttempts,
    });
    const annotationRepo = makeAnnotationRepo({ promoteBySheet: promoteBySheet as unknown as IL3AnnotationRepository["promoteBySheet"] });
    const service = makeService(sheetRepo, fileScopedPaperRepo(), annotationRepo);

    const result = await service.sealSheet({ userId: USER, sheetId: SHEET, mode: "full", acknowledgeUnanswered: false });
    expect(result.sheet.status).toBe("sealed");
    expect(result.materializedCount).toBe(2);
    expect(result.promotedAnnotationCount).toBe(1);
    expect(insertAttempts).toHaveBeenCalledWith(USER, [
      expect.objectContaining({ question_id: Q1, sheet_id: SHEET, venue: "file" }),
      expect.objectContaining({ question_id: Q2, sheet_id: SHEET, venue: "file" }),
    ]);
    expect(sheetRepo.sealSheet).toHaveBeenCalledWith(USER, SHEET, expect.objectContaining({
      status: "sealed", seal_mode: "full", summary: null,
    }));
  });

  it("full mode skips unanswered questions when materializing", async () => {
    const insertAttempts = vi.fn(async (_userId: string, attempts: readonly { question_id: string }[]) =>
      attempts.map((attempt) => attemptRow({ question_id: attempt.question_id })));
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { selected: "B" }, [Q2]: null } })),
      insertAttempts,
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());
    const result = await service.sealSheet({
      userId: USER, sheetId: SHEET, mode: "full", acknowledgeUnanswered: true,
    });
    expect(result.unansweredCount).toBe(1);
    expect(result.materializedCount).toBe(1);
    expect(insertAttempts).toHaveBeenCalledWith(USER, [
      expect.objectContaining({ question_id: Q1 }),
    ]);
  });

  it("incremental mode discards the sheet, promotes notes and skips attempts", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { selected: "B" } } })),
      sealSheet: vi.fn(async () => submissionRow({ status: "discarded", seal_mode: "incremental" })),
    });
    const annotationRepo = makeAnnotationRepo({ promoteBySheet: vi.fn(async () => [{ id: "a-1" }, { id: "a-2" }] as never) });
    const service = makeService(sheetRepo, fileScopedPaperRepo(), annotationRepo);

    const result = await service.sealSheet({
      userId: USER, sheetId: SHEET, mode: "incremental", acknowledgeUnanswered: true,
    });
    expect(result.sheet.status).toBe("discarded");
    expect(result.materializedCount).toBe(0);
    expect(result.promotedAnnotationCount).toBe(2);
    expect(sheetRepo.insertAttempts).not.toHaveBeenCalled();
    expect(sheetRepo.sealSheet).toHaveBeenCalledWith(USER, SHEET, expect.objectContaining({
      status: "discarded", seal_mode: "incremental", summary: null,
    }));
  });

  it("summary mode pins the summary note to the first scoped question", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { selected: "B" } } })),
      sealSheet: vi.fn(async () => submissionRow({ status: "discarded", seal_mode: "summary" })),
    });
    const insertSummaryAnnotation = vi.fn(async () => attemptRow());
    const annotationRepo = makeAnnotationRepo({ insertSummaryAnnotation: insertSummaryAnnotation as unknown as IL3AnnotationRepository["insertSummaryAnnotation"] });
    const service = makeService(sheetRepo, fileScopedPaperRepo(), annotationRepo);

    const result = await service.sealSheet({
      userId: USER, sheetId: SHEET, mode: "summary", summary: "本次全对，只留元认知", acknowledgeUnanswered: true,
    });
    expect(result.sheet.status).toBe("discarded");
    expect(insertSummaryAnnotation).toHaveBeenCalledWith({
      user_id: USER,
      question_id: Q1,
      sheet_id: SHEET,
      note: "本次全对，只留元认知",
    });
    expect(sheetRepo.insertAttempts).not.toHaveBeenCalled();
  });

  it("rejects the summary mode without text", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { selected: "B" } } })),
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());
    await expect(service.sealSheet({
      userId: USER, sheetId: SHEET, mode: "summary", acknowledgeUnanswered: true,
    })).rejects.toBeInstanceOf(ValidationError);
    expect(sheetRepo.sealSheet).not.toHaveBeenCalled();
  });

  it("409s when the atomic claim loses the race (conditional update misses)", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { selected: "B" } } })),
      sealSheet: vi.fn(async () => null),
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());
    await expect(service.sealSheet({
      userId: USER, sheetId: SHEET, mode: "full", acknowledgeUnanswered: false,
    })).rejects.toBeInstanceOf(ConflictError);
    expect(sheetRepo.insertAttempts).not.toHaveBeenCalled();
  });

  it("rejects the summary mode when the scope has no questions to pin", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: {} })),
    });
    const service = makeService(sheetRepo, makePaperRepo()); // 空题组
    await expect(service.sealSheet({
      userId: USER, sheetId: SHEET, mode: "summary", summary: "总结", acknowledgeUnanswered: false,
    })).rejects.toBeInstanceOf(ValidationError);
    expect(sheetRepo.sealSheet).not.toHaveBeenCalled();
  });
});

describe("L3SheetService.listAttempts", () => {
  it("dedupes ids and caps the batch at 200", async () => {
    const listForQuestions = vi.fn(async (_userId: string, _questionIds: readonly string[]) => [attemptRow()]);
    const sheetRepo = makeSheetRepo({ listForQuestions });
    const service = makeService(sheetRepo);
    const many = Array.from({ length: 250 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    await service.listAttempts(USER, [Q1, Q1, ...many]);
    expect(listForQuestions).toHaveBeenCalledTimes(1);
    const ids = listForQuestions.mock.calls[0]![1] as string[];
    expect(ids).toHaveLength(200);
    expect(new Set(ids).size).toBe(200);
  });
});

describe("L3SheetService.deleteAttempt", () => {
  it("soft-deletes and 404s on a second delete", async () => {
    const ok = makeService(makeSheetRepo({ softDeleteAttempt: vi.fn(async () => true) }));
    await expect(ok.deleteAttempt(USER, "00000000-0000-4000-8000-000000000501")).resolves.toEqual({ deleted: true });

    const missing = makeService(makeSheetRepo({ softDeleteAttempt: vi.fn(async () => false) }));
    await expect(missing.deleteAttempt(USER, "00000000-0000-4000-8000-000000000501"))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});
