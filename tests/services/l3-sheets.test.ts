import { describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@/errors";
import type { L3QuestionAttemptRow, L3QuestionRow, L3SheetArchiveRow, L3SubmissionRow } from "@/domain";
import type {
  IRepositories,
  IL3AnnotationRepository,
  IL3ContextRepository,
  IL3PaperRepository,
  IL3SheetRepository,
} from "@/repositories/interfaces";
import type { IL3StudyReferenceRepository } from "@/repositories/l3-study-references.repository";
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
    writing_task_id: null,
    parent_sheet_id: null,
    revision_no: null,
    draft_version: 0,
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
    answer: { choice: "B" },
    self_assessment: null,
    status: "active",
    deleted_at: null,
    created_at: "2026-09-17T01:00:00.000Z",
    ...overrides,
  };
}

function makeSheetRepo(overrides: Partial<IL3SheetRepository> = {}): IL3SheetRepository {
  // Task B（2026-09-19）：定格临界区改为经 getSheetForUpdate（FOR UPDATE）读取权威
  // 行；默认让 getSheetForUpdate 镜像 getSheet 夹具，使既有 seal 测试（多覆盖 getSheet
  // 以给定 answers/version）无需逐条改写即观察到相同数据。显式覆盖 getSheetForUpdate 时优先。
  const getSheet = overrides.getSheet ?? vi.fn(async () => submissionRow());
  const repo: IL3SheetRepository = {
    findDraftByScopeKey: vi.fn(async () => null),
    openSheet: vi.fn(async () => ({ row: submissionRow(), created: true })),
    patchAnswers: vi.fn(async () => submissionRow()),
    sealSheet: vi.fn(async () => submissionRow({ status: "sealed" })),
    getSheet,
    insertAttempts: vi.fn(async () => []),
    listForQuestions: vi.fn(async () => []),
    softDeleteAttempt: vi.fn(async () => true),
    listBySheet: vi.fn(async () => []),
    countAnsweredBySheet: vi.fn(async () => 0),
    listArchive: vi.fn(async () => []),
    ...overrides,
  } as IL3SheetRepository;
  return repo;
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

/** 引用仓储替身：默认「无 blocker」，用例可覆盖 getAttemptDeleteBlockers。 */
function makeStudyReferenceRepo(
  overrides: Partial<Record<keyof IL3StudyReferenceRepository, unknown>> = {},
): IL3StudyReferenceRepository {
  return {
    lockTargets: vi.fn(async () => undefined),
    getAttemptDeleteBlockers: vi.fn(async () => []),
    getQuestionDeleteBlockers: vi.fn(async () => []),
    ...overrides,
  } as unknown as IL3StudyReferenceRepository;
}

function makeService(
  sheetRepo: IL3SheetRepository,
  paperRepo: IL3PaperRepository = makePaperRepo(),
  annotationRepo: IL3AnnotationRepository = makeAnnotationRepo(),
  contextRepo: IL3ContextRepository = makeContextRepo({ id: SOURCE }),
  studyReferences: IL3StudyReferenceRepository = makeStudyReferenceRepo(),
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
      studyReferences,
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
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { choice: "B" } } })),
    });
    const service = makeService(sheetRepo);
    const result = await service.getSheet(USER, SHEET);
    expect(result.sheet.answers[Q1]).toEqual({ choice: "B" });
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
    expect(result.attempts[1]!.answer).toEqual({ choice: "B" });
  });
});

describe("L3SheetService.patchSheet", () => {
  it("returns the merged sheet when the conditional update wins", async () => {
    const patchAnswers = vi.fn(async () => submissionRow({ answers: { [Q1]: { choice: "C" } }, draft_version: 4 }));
    const sheetRepo = makeSheetRepo({ patchAnswers });
    const service = makeService(sheetRepo);
    const result = await service.patchSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 3, answers: { [Q1]: { choice: "C" } },
    });
    expect(result.sheet.answers[Q1]).toEqual({ choice: "C" });
    // V：客户端确认版本透传进条件合并
    expect(patchAnswers).toHaveBeenCalledWith(USER, SHEET, { [Q1]: { choice: "C" } }, 3);
  });

  it("404s when the sheet is missing and 409s when it is settled", async () => {
    const missing = makeService(makeSheetRepo({
      patchAnswers: vi.fn(async () => null),
      getSheet: vi.fn(async () => null),
    }));
    await expect(missing.patchSheet({ userId: USER, sheetId: SHEET, expectedVersion: 0, answers: { [Q1]: null } }))
      .rejects.toBeInstanceOf(NotFoundError);

    const settled = makeService(makeSheetRepo({
      patchAnswers: vi.fn(async () => null),
      getSheet: vi.fn(async () => submissionRow({ status: "sealed" })),
    }));
    await expect(settled.patchSheet({ userId: USER, sheetId: SHEET, expectedVersion: 0, answers: { [Q1]: null } }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("V：draft 且条件合并落空 = 版本已前进 → 409 DRAFT_VERSION_CONFLICT（不泄露服务器版本）", async () => {
    const sheetRepo = makeSheetRepo({
      patchAnswers: vi.fn(async () => null),
      getSheet: vi.fn(async () => submissionRow({ draft_version: 5 })),
    });
    const service = makeService(sheetRepo);
    const rejected = await service.patchSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 3, answers: { [Q1]: { choice: "B" } },
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ConflictError);
    expect((rejected as ConflictError).meta).toMatchObject({ code: "DRAFT_VERSION_CONFLICT" });
    // 不泄露服务器当前版本（无 currentVersion / draft_version 字段）
    expect((rejected as ConflictError).meta).not.toHaveProperty("currentVersion");
    expect((rejected as ConflictError).meta).not.toHaveProperty("draft_version");
  });
});

describe("L3SheetService 通用写面 vs writing 稿（W3 旁路封堵）", () => {
  const writingDraft = (overrides: Partial<L3SubmissionRow> = {}): L3SubmissionRow =>
    submissionRow({
      scope: "writing",
      scope_key: "writing:00000000-0000-4000-8000-000000000701",
      source_id: null,
      question_type: null,
      paper_id: null,
      writing_task_id: "00000000-0000-4000-8000-000000000701",
      ...overrides,
    });

  it("patchSheet 对 writing 稿 409 WRITING_ENDPOINT_REQUIRED（通用 PATCH 非旁路）", async () => {
    const sheetRepo = makeSheetRepo({
      patchAnswers: vi.fn(async () => null),
      getSheet: vi.fn(async () => writingDraft()),
    });
    const service = makeService(sheetRepo);
    await expect(service.patchSheet({ userId: USER, sheetId: SHEET, expectedVersion: 0, answers: { [Q1]: null } }))
      .rejects.toMatchObject({ httpStatus: 409, meta: { code: "WRITING_ENDPOINT_REQUIRED" } });
  });

  it("sealSheet 对 writing 稿 409 WRITING_ENDPOINT_REQUIRED（不进入定格三档）", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => writingDraft()),
    });
    const service = makeService(sheetRepo);
    await expect(service.sealSheet({ userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: false }))
      .rejects.toMatchObject({ httpStatus: 409, meta: { code: "WRITING_ENDPOINT_REQUIRED" } });
  });
});

describe("L3SheetService.sealSheet", () => {
  it("404s for a missing sheet and 409s for a settled one", async () => {
    const missing = makeService(makeSheetRepo({ getSheet: vi.fn(async () => null) }));
    await expect(missing.sealSheet({ userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: false }))
      .rejects.toBeInstanceOf(NotFoundError);

    const settled = makeService(makeSheetRepo({ getSheet: vi.fn(async () => submissionRow({ status: "sealed" })) }));
    await expect(settled.sealSheet({ userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: false }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("409s with the unanswered count until the caller confirms", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { choice: "B" } } })),
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());
    const rejected = await service.sealSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: false,
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ConflictError);
    expect((rejected as ConflictError).meta).toMatchObject({ unansweredCount: 1 });
    expect(sheetRepo.sealSheet).not.toHaveBeenCalled();

    const confirmed = await service.sealSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: true,
    });
    expect(confirmed.unansweredCount).toBe(1);
  });

  it("full mode materializes answered attempts in scope order and promotes notes", async () => {
    const insertAttempts = vi.fn(async (_userId: string, attempts: readonly { question_id: string }[]) =>
      attempts.map((attempt, index) => attemptRow({ id: `00000000-0000-4000-8000-00000000060${index}`, question_id: attempt.question_id })));
    const promoteBySheet = vi.fn(async () => [{ id: "annotation-1" }]);
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { choice: "B" }, [Q2]: { text: "译文" } } })),
      sealSheet: vi.fn(async () => submissionRow({ status: "sealed", seal_mode: "full", sealed_at: "2026-09-17T04:00:00.000Z" })),
      insertAttempts,
    });
    const annotationRepo = makeAnnotationRepo({ promoteBySheet: promoteBySheet as unknown as IL3AnnotationRepository["promoteBySheet"] });
    const service = makeService(sheetRepo, fileScopedPaperRepo(), annotationRepo);

    const result = await service.sealSheet({ userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: false });
    expect(result.sheet.status).toBe("sealed");
    expect(result.materializedCount).toBe(2);
    expect(result.promotedAnnotationCount).toBe(1);
    expect(insertAttempts).toHaveBeenCalledWith(USER, [
      expect.objectContaining({ question_id: Q1, sheet_id: SHEET, venue: "file" }),
      expect.objectContaining({ question_id: Q2, sheet_id: SHEET, venue: "file" }),
    ]);
    expect(sheetRepo.sealSheet).toHaveBeenCalledWith(USER, SHEET, expect.objectContaining({
      status: "sealed", seal_mode: "full", summary: null,
    }), expect.any(Number));
  });

  it("V：以 input.expectedVersion（客户端确认版本）作为最终 CAS 基线传给 sealSheet", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { choice: "B" } }, draft_version: 7 })),
      sealSheet: vi.fn(async () => submissionRow({ status: "sealed", seal_mode: "full" })),
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());
    await service.sealSheet({ userId: USER, sheetId: SHEET, expectedVersion: 7, mode: "full", acknowledgeUnanswered: true });
    expect(sheetRepo.sealSheet).toHaveBeenCalledWith(
      USER, SHEET, expect.objectContaining({ status: "sealed", seal_mode: "full" }), 7,
    );
  });

  it("V：input.expectedVersion 与读取行不一致（客户端确认后、读取前的并发写入）→ 409 且不物化", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { choice: "B" } }, draft_version: 2 })),
      sealSheet: vi.fn(async () => submissionRow({ status: "sealed", seal_mode: "full" })),
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());
    const rejected = await service.sealSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 1, mode: "full", acknowledgeUnanswered: true,
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ConflictError);
    expect((rejected as ConflictError).meta).toMatchObject({ code: "DRAFT_VERSION_CONFLICT" });
    expect(sheetRepo.sealSheet).not.toHaveBeenCalled(); // 不抢占、不物化
    expect(sheetRepo.insertAttempts).not.toHaveBeenCalled();
  });

  it("full mode skips unanswered questions when materializing", async () => {
    const insertAttempts = vi.fn(async (_userId: string, attempts: readonly { question_id: string }[]) =>
      attempts.map((attempt) => attemptRow({ question_id: attempt.question_id })));
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { choice: "B" }, [Q2]: null } })),
      insertAttempts,
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());
    const result = await service.sealSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: true,
    });
    expect(result.unansweredCount).toBe(1);
    expect(result.materializedCount).toBe(1);
    expect(insertAttempts).toHaveBeenCalledWith(USER, [
      expect.objectContaining({ question_id: Q1 }),
    ]);
  });

  it("incremental mode discards the sheet, promotes notes and skips attempts", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { choice: "B" } } })),
      sealSheet: vi.fn(async () => submissionRow({ status: "discarded", seal_mode: "incremental" })),
    });
    const annotationRepo = makeAnnotationRepo({ promoteBySheet: vi.fn(async () => [{ id: "a-1" }, { id: "a-2" }] as never) });
    const service = makeService(sheetRepo, fileScopedPaperRepo(), annotationRepo);

    const result = await service.sealSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "incremental", acknowledgeUnanswered: true,
    });
    expect(result.sheet.status).toBe("discarded");
    expect(result.materializedCount).toBe(0);
    expect(result.promotedAnnotationCount).toBe(2);
    expect(sheetRepo.insertAttempts).not.toHaveBeenCalled();
    expect(sheetRepo.sealSheet).toHaveBeenCalledWith(USER, SHEET, expect.objectContaining({
      status: "discarded", seal_mode: "incremental", summary: null,
    }), expect.any(Number));
  });

  it("summary mode pins the summary note to the first scoped question", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { choice: "B" } } })),
      sealSheet: vi.fn(async () => submissionRow({ status: "discarded", seal_mode: "summary" })),
    });
    const insertSummaryAnnotation = vi.fn(async () => attemptRow());
    const annotationRepo = makeAnnotationRepo({ insertSummaryAnnotation: insertSummaryAnnotation as unknown as IL3AnnotationRepository["insertSummaryAnnotation"] });
    const service = makeService(sheetRepo, fileScopedPaperRepo(), annotationRepo);

    const result = await service.sealSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "summary", summary: "本次全对，只留元认知", acknowledgeUnanswered: true,
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
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { choice: "B" } } })),
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());
    await expect(service.sealSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "summary", acknowledgeUnanswered: true,
    })).rejects.toBeInstanceOf(ValidationError);
    expect(sheetRepo.sealSheet).not.toHaveBeenCalled();
  });

  it("409s when the atomic claim loses the race (conditional update misses)", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { choice: "B" } } })),
      sealSheet: vi.fn(async () => null),
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());
    await expect(service.sealSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: false,
    })).rejects.toBeInstanceOf(ConflictError);
    expect(sheetRepo.insertAttempts).not.toHaveBeenCalled();
  });

  it("rejects the summary mode when the scope has no questions to pin", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: {} })),
    });
    const service = makeService(sheetRepo, makePaperRepo()); // 空题组
    await expect(service.sealSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "summary", summary: "总结", acknowledgeUnanswered: false,
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
  const ATTEMPT = "00000000-0000-4000-8000-000000000501";

  it("soft-deletes and 404s on a second delete", async () => {
    const ok = makeService(makeSheetRepo({ softDeleteAttempt: vi.fn(async () => true) }));
    await expect(ok.deleteAttempt(USER, ATTEMPT)).resolves.toEqual({ deleted: true });

    const missing = makeService(makeSheetRepo({ softDeleteAttempt: vi.fn(async () => false) }));
    await expect(missing.deleteAttempt(USER, ATTEMPT))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  // N2 第三条链 K11 / K17：软删不撞 RESTRICT（真库探针 F9），所以删除面必须自带预检。
  it("先取 l3_attempt 锁再查 blocker（与 capture 共用同一把锁键）", async () => {
    const lockTargets = vi.fn(async () => undefined);
    const service = makeService(
      makeSheetRepo({ softDeleteAttempt: vi.fn(async () => true) }),
      undefined,
      undefined,
      undefined,
      makeStudyReferenceRepo({ lockTargets }),
    );
    await service.deleteAttempt(USER, ATTEMPT);
    expect(lockTargets).toHaveBeenCalledWith(USER, [{ kind: "attempt", id: ATTEMPT }]);
  });

  it("被笔记引用时抛 409 且带可读 blocker 列表，软删不执行", async () => {
    const softDeleteAttempt = vi.fn(async () => true);
    const service = makeService(
      makeSheetRepo({ softDeleteAttempt }),
      undefined,
      undefined,
      undefined,
      makeStudyReferenceRepo({
        getAttemptDeleteBlockers: vi.fn(async () => [
          { note_id: "00000000-0000-4000-8000-000000000601", title: "卷面整理", status: "active", reference_count: 2 },
          { note_id: "00000000-0000-4000-8000-000000000602", title: "作文复盘", status: "archived", reference_count: 1 },
        ]),
      }),
    );
    const error = await service.deleteAttempt(USER, ATTEMPT).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as { meta?: unknown }).meta).toEqual({
      entityType: "attempt",
      id: ATTEMPT,
      blockers: {
        studyNotes: [
          { id: "00000000-0000-4000-8000-000000000601", title: "卷面整理", status: "active", referenceCount: 2 },
          { id: "00000000-0000-4000-8000-000000000602", title: "作文复盘", status: "archived", referenceCount: 1 },
        ],
      },
      resolution: "remove_references_or_convert_to_plain_excerpt",
    });
    expect(softDeleteAttempt).not.toHaveBeenCalled();
  });
});

describe("L3SheetService.sealSheet（v2 §4.6/§10：旗标物化与待复查计数）", () => {
  it("counts recheck questions into the response and 409 details（不阻断，只提示）", async () => {
    const recheckAnswers = {
      [Q1]: { choice: "B", flags: { doubt: true, recheck: true } },
      [Q2]: { choice: "C" },
    };
    const fullRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: recheckAnswers })),
      sealSheet: vi.fn(async () => submissionRow({ status: "sealed", seal_mode: "full" })),
    });
    const full = await makeService(fullRepo, fileScopedPaperRepo()).sealSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: false,
    });
    expect(full.recheckCount).toBe(1);

    // 有未答时：409 details 同时携带未答与待复查计数（软确认复述数据源）
    const softRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ answers: { [Q1]: { choice: "B", flags: { recheck: true } } } })),
    });
    const rejected = await makeService(softRepo, fileScopedPaperRepo()).sealSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: false,
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ConflictError);
    expect((rejected as ConflictError).meta).toMatchObject({ unansweredCount: 1, recheckCount: 1 });
    expect(softRepo.sealSheet).not.toHaveBeenCalled();
  });

  it("full mode materializes the subjective snapshot into self_assessment and keeps answer factual", async () => {
    const insertAttempts = vi.fn(async (_userId: string, attempts: readonly { question_id: string }[]) =>
      attempts.map((attempt) => attemptRow({ question_id: attempt.question_id })));
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({
        answers: {
          [Q1]: {
            choice: "B",
            flags: { doubt: true, recheck: true },
            optionFlags: ["A", "C"],
            marks: [{ scope: "passage", start: 3, end: 12 }],
          },
          [Q2]: { choice: "C" },
        },
      })),
      sealSheet: vi.fn(async () => submissionRow({ status: "sealed", seal_mode: "full" })),
      insertAttempts,
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());
    await service.sealSheet({ userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: false });

    expect(insertAttempts).toHaveBeenCalledWith(USER, [
      expect.objectContaining({
        question_id: Q1,
        answer: { choice: "B" },
        self_assessment: {
          flags: { doubt: true, recheck: true },
          optionFlags: ["A", "C"],
          marks: [{ scope: "passage", start: 3, end: 12 }],
        },
      }),
      expect.objectContaining({ question_id: Q2, answer: { choice: "C" }, self_assessment: null }),
    ]);
  });

  it("仅痕迹题（只标重点未选答案）计入未答软确认；确认后痕迹仍随定格物化（口径统一修正）", async () => {
    const insertAttempts = vi.fn(async (_userId: string, attempts: readonly { question_id: string }[]) =>
      attempts.map((attempt) => attemptRow({ question_id: attempt.question_id })));
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({
        answers: {
          [Q1]: { marks: [{ scope: "passage", start: 3, end: 12 }] },
          [Q2]: { choice: "C" },
        },
      })),
      sealSheet: vi.fn(async () => submissionRow({ status: "sealed", seal_mode: "full" })),
      insertAttempts,
    });
    const service = makeService(sheetRepo, fileScopedPaperRepo());

    // 旧口径把「仅有痕迹」误判为已答（不弹软确认）；修正后计入未答。
    const rejected = await service.sealSheet({
      userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: false,
    }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ConflictError);
    expect((rejected as ConflictError).meta).toMatchObject({ unansweredCount: 1 });

    // 确认后：Q1 仍物化（痕迹不丢）——answer 精确为空对象（主观字段不进作答事实）、痕迹进 self_assessment。
    await service.sealSheet({ userId: USER, sheetId: SHEET, expectedVersion: 0, mode: "full", acknowledgeUnanswered: true });
    const lastCall = insertAttempts.mock.calls[insertAttempts.mock.calls.length - 1]!;
    const rows = lastCall[1] as unknown as Array<{ question_id: string; answer: unknown; self_assessment: unknown }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.question_id).toBe(Q1);
    expect(rows[0]!.answer).toEqual({});
    expect(rows[0]!.self_assessment).toEqual({ marks: [{ scope: "passage", start: 3, end: 12 }] });
    expect(rows[1]!.question_id).toBe(Q2);
    expect(rows[1]!.answer).toEqual({ choice: "C" });
    expect(rows[1]!.self_assessment).toBeNull();
  });
});

describe("L3SheetService.listArchive（F-1 题纸档案）", () => {
  it("passes the limit through within the actor-bound transaction", async () => {
    const archive: L3SheetArchiveRow[] = [{
      id: SHEET,
      scope: "file",
      source_id: SOURCE,
      question_type: "reading_choice",
      paper_id: null,
      status: "sealed",
      seal_mode: "full",
      sealed_at: "2026-09-18T00:10:00.000Z",
      created_at: "2026-09-18T00:00:00.000Z",
      graded_count: 3,
      venue_title: "WA 阅读理解文件",
    }];
    const listArchive = vi.fn(async () => archive);
    const service = makeService(makeSheetRepo({ listArchive }));
    const result = await service.listArchive(USER, { limit: 20 });
    expect(listArchive).toHaveBeenCalledWith(USER, 20);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ graded_count: 3, status: "sealed" });
  });
});
