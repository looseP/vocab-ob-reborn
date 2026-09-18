import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "@/errors";
import type { L3AnnotationTagRow, L3QuestionAnnotationRow, L3QuestionRow, L3SubmissionRow } from "@/domain";
import type {
  IRepositories,
  IL3AnnotationRepository,
  IL3PaperRepository,
  IL3SheetRepository,
} from "@/repositories/interfaces";
import { L3AnnotationService } from "@/services/l3-annotations.service";
import { PRESET_ENTRY_TAGS, PRESET_OPTION_TAGS } from "@/domain/l3-annotations";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const QUESTION_ID = "00000000-0000-4000-8000-000000000101";
const ANNOTATION_ID = "00000000-0000-4000-8000-000000000201";

function questionRow(overrides: Partial<L3QuestionRow> = {}): L3QuestionRow {
  return {
    id: QUESTION_ID,
    user_id: USER_ID,
    source_id: null,
    file_key: "file-1",
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
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
    ...overrides,
  };
}

function annotationRow(overrides: Partial<L3QuestionAnnotationRow> = {}): L3QuestionAnnotationRow {
  return {
    id: ANNOTATION_ID,
    user_id: USER_ID,
    question_id: QUESTION_ID,
    ordinal: 0,
    anchor_start: 12,
    anchor_end: 20,
    excerpt: "trap phrase",
    note: "B 偷换概念",
    entry_tags: ["推断题"],
    option_tags: { B: ["偷换概念"] },
    stage: "confirmed",
    sheet_id: null,
    review: null,
    review_sheet_id: null,
    status: "active",
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
    ...overrides,
  };
}

function tagRow(kind: "entry" | "option", label: string, ordinal: number): L3AnnotationTagRow {
  return {
    id: `tag-${kind}-${ordinal}`,
    user_id: USER_ID,
    kind,
    label,
    ordinal,
    status: "active",
    created_at: "2026-09-16T00:00:00Z",
    updated_at: "2026-09-16T00:00:00Z",
  };
}

function makeAnnotationRepo(overrides: Partial<IL3AnnotationRepository> = {}): IL3AnnotationRepository {
  return {
    listForQuestions: vi.fn(async () => []),
    findByAnchor: vi.fn(async () => null),
    insertAnnotation: vi.fn(async () => annotationRow()),
    updateAnnotation: vi.fn(async () => annotationRow()),
    softDeleteAnnotation: vi.fn(async () => true),
    listTags: vi.fn(async () => []),
    replaceTags: vi.fn(async () => []),
    listDraftBySheet: vi.fn(async () => []),
    listAnnotationsBySheet: vi.fn(async () => []),
    getAnnotation: vi.fn(async () => null),
    withdrawAnnotation: vi.fn(async () => null),
    promoteBySheet: vi.fn(async () => []),
    insertSummaryAnnotation: vi.fn(async () => annotationRow()),
    applyAnnotationReview: vi.fn(async () => null),
    confirmAnnotation: vi.fn(async () => null),
    ...overrides,
  };
}

function makePaperRepo(question: L3QuestionRow | null): IL3PaperRepository {
  return {
    insertQuestion: vi.fn(),
    findQuestionById: vi.fn(async () => question),
    findActiveQuestionsByIds: vi.fn(),
    listActiveQuestionsForFile: vi.fn(),
    listPracticeFiles: vi.fn(),
    deleteQuestion: vi.fn(),
    listActivePaperRefsWithPayload: vi.fn(),
    insertPaper: vi.fn(),
    findPaperById: vi.fn(),
    listPapers: vi.fn(),
  } as unknown as IL3PaperRepository;
}

function makeSheetRepo(sheet: L3SubmissionRow | null): IL3SheetRepository {
  return {
    findDraftByScopeKey: vi.fn(),
    openSheet: vi.fn(),
    patchAnswers: vi.fn(),
    sealSheet: vi.fn(),
    getSheet: vi.fn(async () => sheet),
    insertAttempts: vi.fn(),
    listForQuestions: vi.fn(),
    softDeleteAttempt: vi.fn(),
    listBySheet: vi.fn(),
    countAnsweredBySheet: vi.fn(),
  } as unknown as IL3SheetRepository;
}

function submissionRow(overrides: Partial<L3SubmissionRow> = {}): L3SubmissionRow {
  return {
    id: "00000000-0000-4000-8000-000000000401",
    user_id: USER_ID,
    scope: "file",
    scope_key: "file:00000000-0000-4000-8000-000000000302:reading_choice",
    source_id: "00000000-0000-4000-8000-000000000302",
    question_type: "reading_choice",
    paper_id: null,
    status: "draft",
    answers: {},
    seal_mode: null,
    summary: null,
    sealed_at: null,
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function makeService(
  annotationRepo: IL3AnnotationRepository,
  paperRepo: IL3PaperRepository,
  sheetRepo: IL3SheetRepository = makeSheetRepo(null),
): L3AnnotationService {
  return new L3AnnotationService(
    annotationRepo,
    paperRepo,
    async (callback) => callback({} as never),
    () => ({
      l3Annotations: annotationRepo,
      l3Paper: paperRepo,
      l3Sheets: sheetRepo,
    } as unknown as IRepositories),
  );
}

const anchoredInput = {
  userId: USER_ID,
  questionId: QUESTION_ID,
  anchorStart: 12,
  anchorEnd: 20,
  excerpt: "trap phrase",
  note: "B 偷换概念",
  entryTags: ["推断题"],
  optionTags: { B: ["偷换概念"] },
};

describe("L3AnnotationService.createAnnotation", () => {
  let annotationRepo: IL3AnnotationRepository;

  beforeEach(() => {
    annotationRepo = makeAnnotationRepo();
  });

  it("404s when the question does not exist or belongs to another user", async () => {
    const service = makeService(annotationRepo, makePaperRepo(null));
    await expect(service.createAnnotation(anchoredInput)).rejects.toBeInstanceOf(NotFoundError);
    expect(annotationRepo.insertAnnotation).not.toHaveBeenCalled();
  });

  it("returns the existing row without inserting when the anchor already exists", async () => {
    const existing = annotationRow();
    annotationRepo = makeAnnotationRepo({ findByAnchor: vi.fn(async () => existing) });
    const service = makeService(annotationRepo, makePaperRepo(questionRow()));

    const result = await service.createAnnotation(anchoredInput);
    expect(result).toEqual({ item: existing, idempotent: true });
    expect(annotationRepo.insertAnnotation).not.toHaveBeenCalled();
    expect(annotationRepo.findByAnchor).toHaveBeenCalledWith(USER_ID, QUESTION_ID, 12, 20);
  });

  it("inserts a new anchored annotation when the anchor is free", async () => {
    const service = makeService(annotationRepo, makePaperRepo(questionRow()));
    const result = await service.createAnnotation(anchoredInput);
    expect(result.idempotent).toBe(false);
    expect(annotationRepo.insertAnnotation).toHaveBeenCalledWith({
      user_id: USER_ID,
      question_id: QUESTION_ID,
      anchor_start: 12,
      anchor_end: 20,
      excerpt: "trap phrase",
      note: "B 偷换概念",
      entry_tags: ["推断题"],
      option_tags: { B: ["偷换概念"] },
      stage: "confirmed",
      sheet_id: null,
    });
  });

  it("skips the anchor lookup for loose (anchor-free) entries", async () => {
    const service = makeService(annotationRepo, makePaperRepo(questionRow()));
    await service.createAnnotation({
      userId: USER_ID, questionId: QUESTION_ID,
      anchorStart: null, anchorEnd: null, excerpt: null,
      note: "题型归因", entryTags: ["主旨题"], optionTags: {},
    });
    expect(annotationRepo.findByAnchor).not.toHaveBeenCalled();
    expect(annotationRepo.insertAnnotation).toHaveBeenCalledTimes(1);
  });
});

describe("L3AnnotationService.patchAnnotation", () => {
  it("maps camelCase patch onto snake_case columns and returns the item", async () => {
    const updated = annotationRow({ note: "改后" });
    const repo = makeAnnotationRepo({ updateAnnotation: vi.fn(async () => updated) });
    const service = makeService(repo, makePaperRepo(questionRow()));

    const result = await service.patchAnnotation({
      userId: USER_ID, id: ANNOTATION_ID, note: "改后",
    });
    expect(result.item).toBe(updated);
    expect(repo.updateAnnotation).toHaveBeenCalledWith(USER_ID, ANNOTATION_ID, { note: "改后" });
  });

  it("passes explicit null anchor triple through to the database patch", async () => {
    const repo = makeAnnotationRepo({
      updateAnnotation: vi.fn(async () => annotationRow({ anchor_start: null, anchor_end: null, excerpt: null })),
    });
    const service = makeService(repo, makePaperRepo(questionRow()));
    await service.patchAnnotation({
      userId: USER_ID, id: ANNOTATION_ID,
      anchorStart: null, anchorEnd: null, excerpt: null,
    });
    expect(repo.updateAnnotation).toHaveBeenCalledWith(USER_ID, ANNOTATION_ID, {
      anchor_start: null, anchor_end: null, excerpt: null,
    });
  });

  it("404s when the row is missing / owned by someone else", async () => {
    const repo = makeAnnotationRepo({ updateAnnotation: vi.fn(async () => null) });
    const service = makeService(repo, makePaperRepo(questionRow()));
    await expect(service.patchAnnotation({ userId: USER_ID, id: ANNOTATION_ID, note: "x" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("L3AnnotationService.deleteAnnotation", () => {
  it("soft-deletes an owned active row", async () => {
    const repo = makeAnnotationRepo({ softDeleteAnnotation: vi.fn(async () => true) });
    const service = makeService(repo, makePaperRepo(questionRow()));
    await expect(service.deleteAnnotation(USER_ID, ANNOTATION_ID)).resolves.toEqual({ deleted: true });
  });

  it("404s when nothing was deleted", async () => {
    const repo = makeAnnotationRepo({ softDeleteAnnotation: vi.fn(async () => false) });
    const service = makeService(repo, makePaperRepo(questionRow()));
    await expect(service.deleteAnnotation(USER_ID, ANNOTATION_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("L3AnnotationService.listForQuestions", () => {
  it("dedupes ids and returns the repository rows under items", async () => {
    const rows = [annotationRow()];
    const repo = makeAnnotationRepo({ listForQuestions: vi.fn(async () => rows) });
    const service = makeService(repo, makePaperRepo(questionRow()));
    const result = await service.listForQuestions(USER_ID, [QUESTION_ID, QUESTION_ID]);
    expect(result.items).toBe(rows);
    expect(repo.listForQuestions).toHaveBeenCalledWith(USER_ID, [QUESTION_ID]);
  });
});

describe("L3AnnotationService tag dictionary", () => {
  it("groups existing tags by kind in ordinal order", async () => {
    const rows = [tagRow("entry", "细节题", 0), tagRow("option", "无中生有", 0)];
    const repo = makeAnnotationRepo({ listTags: vi.fn(async () => rows) });
    const service = makeService(repo, makePaperRepo(questionRow()));
    await expect(service.getTagDict(USER_ID)).resolves.toEqual({
      entry: ["细节题"],
      option: ["无中生有"],
    });
    expect(repo.replaceTags).not.toHaveBeenCalled();
  });

  it("lazy-seeds the preset dictionary inside the same transaction on first read", async () => {
    const seeded = [
      ...PRESET_ENTRY_TAGS.map((label, i) => tagRow("entry", label, i)),
      ...PRESET_OPTION_TAGS.map((label, i) => tagRow("option", label, i)),
    ];
    const repo = makeAnnotationRepo({
      listTags: vi.fn(async () => []),
      replaceTags: vi.fn(async () => seeded),
    });
    const service = makeService(repo, makePaperRepo(questionRow()));
    const dict = await service.getTagDict(USER_ID);
    expect(repo.replaceTags).toHaveBeenCalledWith(USER_ID, {
      entry: [...PRESET_ENTRY_TAGS],
      option: [...PRESET_OPTION_TAGS],
    });
    expect(dict.entry).toEqual([...PRESET_ENTRY_TAGS]);
    expect(dict.option).toEqual([...PRESET_OPTION_TAGS]);
  });

  it("replaces the whole dictionary on PUT and returns the new labels", async () => {
    const rows = [tagRow("entry", "自定义题型", 0)];
    const repo = makeAnnotationRepo({ replaceTags: vi.fn(async () => rows) });
    const service = makeService(repo, makePaperRepo(questionRow()));
    const result = await service.replaceTagDict({ userId: USER_ID, entry: ["自定义题型"], option: [] });
    expect(result).toEqual({ entry: ["自定义题型"], option: [] });
  });
});

describe("L3AnnotationService.createAnnotation · 批次二草稿注记", () => {
  const SHEET_ID = "00000000-0000-4000-8000-000000000401";

  it("creates a draft note pinned to the draft sheet", async () => {
    const annotationRepo = makeAnnotationRepo();
    vi.mocked(annotationRepo.insertAnnotation).mockResolvedValue(
      annotationRow({ stage: "draft", sheet_id: SHEET_ID }),
    );
    const service = makeService(
      annotationRepo,
      makePaperRepo(questionRow()),
      makeSheetRepo(submissionRow({ status: "draft" })),
    );
    const result = await service.createAnnotation({ ...anchoredInput, sheetId: SHEET_ID });
    expect(result.item.stage).toBe("draft");
    expect(result.idempotent).toBe(false);
    expect(annotationRepo.insertAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "draft", sheet_id: SHEET_ID }),
    );
  });

  it("404s when the sheet does not exist for this owner", async () => {
    const annotationRepo = makeAnnotationRepo();
    const service = makeService(annotationRepo, makePaperRepo(questionRow()), makeSheetRepo(null));
    await expect(service.createAnnotation({ ...anchoredInput, sheetId: SHEET_ID }))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(annotationRepo.insertAnnotation).not.toHaveBeenCalled();
  });

  it("409s when the sheet is no longer a draft", async () => {
    const annotationRepo = makeAnnotationRepo();
    const service = makeService(
      annotationRepo,
      makePaperRepo(questionRow()),
      makeSheetRepo(submissionRow({ status: "sealed" })),
    );
    await expect(service.createAnnotation({ ...anchoredInput, sheetId: SHEET_ID }))
      .rejects.toBeInstanceOf(ConflictError);
    expect(annotationRepo.insertAnnotation).not.toHaveBeenCalled();
  });

  it("keeps the batch-1 confirmed path when no sheetId is given", async () => {
    const annotationRepo = makeAnnotationRepo();
    const service = makeService(annotationRepo, makePaperRepo(questionRow()));
    await service.createAnnotation(anchoredInput);
    expect(annotationRepo.insertAnnotation).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "confirmed", sheet_id: null }),
    );
  });
});

describe("L3AnnotationService（v2 §4.7：stage 守卫与撤回）", () => {
  const SHEET_ID = "00000000-0000-4000-8000-000000000401";
  const ORIGIN_SHEET_ID = "00000000-0000-4000-8000-000000000402";
  const SOURCE_ID = "00000000-0000-4000-8000-000000000302";

  it("409s patching a submitted annotation（评审输入不可变，走撤回）", async () => {
    const annotationRepo = makeAnnotationRepo({
      updateAnnotation: vi.fn(async () => null),
      getAnnotation: vi.fn(async () => annotationRow({ stage: "submitted", sheet_id: SHEET_ID })),
    });
    const service = makeService(annotationRepo, makePaperRepo(questionRow()));
    const rejected = await service.patchAnnotation({ userId: USER_ID, id: ANNOTATION_ID, note: "改文" })
      .catch((error) => error);
    expect(rejected).toBeInstanceOf(ConflictError);
    expect((rejected as ConflictError).meta).toMatchObject({ stage: "submitted" });
  });

  it("404s patching when the guard misses and the row does not exist", async () => {
    const annotationRepo = makeAnnotationRepo({
      updateAnnotation: vi.fn(async () => null),
      getAnnotation: vi.fn(async () => null),
    });
    const service = makeService(annotationRepo, makePaperRepo(questionRow()));
    await expect(service.patchAnnotation({ userId: USER_ID, id: ANNOTATION_ID, note: "改文" }))
      .rejects.toBeInstanceOf(NotFoundError);
  });

  it("withdraw re-pins the annotation to the provided draft sheet", async () => {
    const annotationRepo = makeAnnotationRepo({
      getAnnotation: vi.fn(async () => annotationRow({ stage: "submitted", sheet_id: ORIGIN_SHEET_ID })),
      withdrawAnnotation: vi.fn(async () => annotationRow({ stage: "draft", sheet_id: SHEET_ID })),
    });
    const service = makeService(
      annotationRepo,
      makePaperRepo(questionRow()),
      makeSheetRepo(submissionRow({ id: SHEET_ID, status: "draft" })),
    );
    const result = await service.withdrawAnnotation({ userId: USER_ID, id: ANNOTATION_ID, sheetId: SHEET_ID });
    expect(result.item.stage).toBe("draft");
    expect(annotationRepo.withdrawAnnotation).toHaveBeenCalledWith(USER_ID, ANNOTATION_ID, SHEET_ID);
  });

  it("withdraw without a sheetId reopens by the original scope key and re-pins there", async () => {
    const origin = submissionRow({
      id: ORIGIN_SHEET_ID, status: "sealed", scope: "file",
      scope_key: `file:${SOURCE_ID}:reading_choice`, source_id: SOURCE_ID, question_type: "reading_choice",
    });
    const reopened = submissionRow({ id: SHEET_ID, status: "draft" });
    const annotationRepo = makeAnnotationRepo({
      getAnnotation: vi.fn(async () => annotationRow({ stage: "submitted", sheet_id: ORIGIN_SHEET_ID })),
      withdrawAnnotation: vi.fn(async () => annotationRow({ stage: "draft" })),
    });
    const sheetRepo = makeSheetRepo(null);
    (sheetRepo.getSheet as ReturnType<typeof vi.fn>).mockImplementation(
      async (_u: string, id: string) => (id === ORIGIN_SHEET_ID ? origin : null),
    );
    (sheetRepo.openSheet as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({ row: reopened, created: false }),
    );
    const service = makeService(annotationRepo, makePaperRepo(questionRow()), sheetRepo);

    await service.withdrawAnnotation({ userId: USER_ID, id: ANNOTATION_ID });
    expect(sheetRepo.openSheet).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID, scope: "file", scope_key: `file:${SOURCE_ID}:reading_choice`,
    }));
    expect(annotationRepo.withdrawAnnotation).toHaveBeenCalledWith(USER_ID, ANNOTATION_ID, SHEET_ID);
  });

  it("409s withdrawing a draft annotation（只有 submitted 可撤回）", async () => {
    const annotationRepo = makeAnnotationRepo({
      getAnnotation: vi.fn(async () => annotationRow({ stage: "draft", sheet_id: SHEET_ID })),
    });
    const service = makeService(annotationRepo, makePaperRepo(questionRow()));
    const rejected = await service.withdrawAnnotation({ userId: USER_ID, id: ANNOTATION_ID })
      .catch((error) => error);
    expect(rejected).toBeInstanceOf(ConflictError);
    expect(annotationRepo.withdrawAnnotation).not.toHaveBeenCalled();
  });

  it("404s withdrawing a missing annotation", async () => {
    const annotationRepo = makeAnnotationRepo({
      getAnnotation: vi.fn(async () => null),
    });
    const service = makeService(annotationRepo, makePaperRepo(questionRow()));
    await expect(service.withdrawAnnotation({ userId: USER_ID, id: ANNOTATION_ID }))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});
