import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "@/errors";
import type { L3QuestionAnnotationRow, L3QuestionAttemptRow, L3QuestionRow, L3SubmissionRow } from "@/domain";
import type {
  IRepositories,
  IL3AnnotationRepository,
  IL3ContextRepository,
  IL3PaperRepository,
  IL3SheetRepository,
} from "@/repositories/interfaces";
import {
  L3_SHEET_EXPORT_SCHEMA_VERSION,
  L3SheetExportService,
  renderSheetExportMarkdown,
} from "@/services/l3-sheet-export.service";

const USER = "00000000-0000-4000-8000-000000000001";
const SHEET = "00000000-0000-4000-8000-000000000401";
const SOURCE = "00000000-0000-4000-8000-000000000302";
const Q1 = "00000000-0000-4000-8000-000000000101";
const Q2 = "00000000-0000-4000-8000-000000000102";

/** 标准答案哨兵：渲染绝不可携出（导出物不是答案泄漏渠道）。 */
const ANSWER_SENTINEL = "SNEAKY_STANDARD_ANSWER";

function submissionRow(overrides: Partial<L3SubmissionRow> = {}): L3SubmissionRow {
  return {
    id: SHEET,
    user_id: USER,
    scope: "file",
    scope_key: `file:${SOURCE}:reading_choice`,
    source_id: SOURCE,
    question_type: "reading_choice",
    paper_id: null,
    status: "sealed",
    answers: {},
    seal_mode: "full",
    summary: null,
    sealed_at: "2026-09-17T02:00:00.000Z",
    created_at: "2026-09-17T00:00:00.000Z",
    updated_at: "2026-09-17T02:00:00.000Z",
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
    stem: "21. Why did the author mention the tip?",
    options: [
      { key: "A", text: "甲" },
      { key: "B", text: "乙" },
    ],
    answer: { text: ANSWER_SENTINEL },
    explanation: "官方解析（不应导出）",
    evidence: [{ start: 4, end: 15, label: ANSWER_SENTINEL }],
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

function annotationRow(overrides: Partial<L3QuestionAnnotationRow> = {}): L3QuestionAnnotationRow {
  return {
    id: "00000000-0000-4000-8000-000000000201",
    user_id: USER,
    question_id: Q1,
    ordinal: 0,
    anchor_start: 12,
    anchor_end: 20,
    excerpt: "trap phrase",
    note: "B 项偷换主语",
    entry_tags: ["推断题"],
    option_tags: { B: ["偷换概念"] },
    stage: "submitted",
    sheet_id: SHEET,
    review: null,
    status: "active",
    created_at: "2026-09-17T00:30:00.000Z",
    updated_at: "2026-09-17T01:30:00.000Z",
    ...overrides,
  };
}

describe("renderSheetExportMarkdown", () => {
  it("渲染题面/作答/注记 ==高亮== 与统计，且绝不携出标准答案与 evidence 哨兵", () => {
    const markdown = renderSheetExportMarkdown({
      sheet: submissionRow(),
      questions: [questionRow()],
      attempts: [attemptRow()],
      annotations: [annotationRow()],
      articles: [{ title: "Text 1", content: "The trap phrase hides here." }],
      exportedAt: "2026-09-17T03:00:00.000Z",
    });

    expect(markdown).toContain("# L3 题纸冻结档案");
    expect(markdown).toContain(`导出 schema 版本: ${L3_SHEET_EXPORT_SCHEMA_VERSION}`);
    expect(markdown).toContain("## 题面");
    expect(markdown).toContain("21. Why did the author mention the tip?");
    expect(markdown).toContain("## 作答记录");
    expect(markdown).toContain("选 B");
    expect(markdown).toContain("## 冻结注记（随题纸提交）");
    expect(markdown).toContain("==trap phrase==");
    expect(markdown).toContain("（锚点 12–20）");
    expect(markdown).toContain("B 项偷换主语");
    expect(markdown).toContain("## 文章");
    expect(markdown).toContain("The trap phrase hides here.");
    // 安全：标准答案 / 解析 / evidence 不得出现（哨兵逐字断言）。
    expect(markdown).not.toContain(ANSWER_SENTINEL);
    expect(markdown).not.toContain("官方解析");
  });

  it("deleted 作答显示「内容已清理」，统计保持交卷时口径", () => {
    const markdown = renderSheetExportMarkdown({
      sheet: submissionRow(),
      questions: [questionRow()],
      attempts: [
        attemptRow(),
        attemptRow({ id: "00000000-0000-4000-8000-000000000502", question_id: Q2, status: "deleted", deleted_at: "2026-09-17T04:00:00.000Z", answer: null }),
      ],
      annotations: [],
      articles: [],
      exportedAt: "2026-09-17T03:00:00.000Z",
    });
    expect(markdown).toContain("作答记录: 2 条（含 1 条已清理）");
    expect(markdown).toContain("内容已清理");
  });

  it("只留总结档渲染 summary 与占位段", () => {
    const markdown = renderSheetExportMarkdown({
      sheet: submissionRow({ status: "discarded", seal_mode: "summary", summary: "本次全对，只留元认知" }),
      questions: [],
      attempts: [],
      annotations: [],
      articles: [],
      exportedAt: "2026-09-17T03:00:00.000Z",
    });
    expect(markdown).toContain("状态: 已弃档（只留总结）");
    expect(markdown).toContain("本次总结: 本次全对，只留元认知");
    expect(markdown).toContain("（无作答记录）");
    expect(markdown).toContain("（作用域内无题）");
  });

  it("有评审时渲染 verdict 与订正建议", () => {
    const markdown = renderSheetExportMarkdown({
      sheet: submissionRow(),
      questions: [questionRow()],
      attempts: [],
      annotations: [annotationRow({
        review: { verdict: "questionable", corrected_tags: ["偷换概念", "无中生有"], comment: "选项 B 的归因值得再核对" },
      })],
      articles: [],
      exportedAt: "2026-09-17T03:00:00.000Z",
    });
    expect(markdown).toContain("评审: 存疑 — 选项 B 的归因值得再核对（订正建议: 偷换概念、无中生有）");
  });
});

// ── service 编排 ────────────────────────────────────────────────────────────

function makeSheetRepo(overrides: Partial<IL3SheetRepository> = {}): IL3SheetRepository {
  return {
    findDraftByScopeKey: vi.fn(async () => null),
    openSheet: vi.fn(),
    patchAnswers: vi.fn(),
    sealSheet: vi.fn(),
    getSheet: vi.fn(async () => submissionRow()),
    insertAttempts: vi.fn(async () => []),
    listForQuestions: vi.fn(async () => []),
    softDeleteAttempt: vi.fn(),
    listBySheet: vi.fn(async () => [attemptRow()]),
    countAnsweredBySheet: vi.fn(async () => 0),
    ...overrides,
  } as IL3SheetRepository;
}

function makePaperRepo(overrides: Partial<IL3PaperRepository> = {}): IL3PaperRepository {
  return {
    insertQuestion: vi.fn(),
    findQuestionById: vi.fn(),
    findActiveQuestionsByIds: vi.fn(async () => []),
    listActiveQuestionsForFile: vi.fn(async () => [questionRow()]),
    listPracticeFiles: vi.fn(),
    deleteQuestion: vi.fn(),
    listActivePaperRefsWithPayload: vi.fn(),
    insertPaper: vi.fn(),
    findPaperById: vi.fn(),
    listPapers: vi.fn(),
    ...overrides,
  } as unknown as IL3PaperRepository;
}

function makeAnnotationRepo(overrides: Partial<IL3AnnotationRepository> = {}): IL3AnnotationRepository {
  return {
    listForQuestions: vi.fn(async () => []),
    findByAnchor: vi.fn(),
    insertAnnotation: vi.fn(),
    updateAnnotation: vi.fn(),
    softDeleteAnnotation: vi.fn(),
    listTags: vi.fn(async () => []),
    replaceTags: vi.fn(async () => []),
    listDraftBySheet: vi.fn(async () => []),
    listAnnotationsBySheet: vi.fn(async () => [annotationRow()]),
    promoteBySheet: vi.fn(async () => []),
    insertSummaryAnnotation: vi.fn(),
    ...overrides,
  } as unknown as IL3AnnotationRepository;
}

function makeContextRepo(): IL3ContextRepository {
  return {
    findSourceById: vi.fn(async () => ({ id: SOURCE, title: "Text 1", content_text: "The trap phrase hides here." })),
  } as unknown as IL3ContextRepository;
}

function makeService(
  sheetRepo: IL3SheetRepository,
  paperRepo: IL3PaperRepository = makePaperRepo(),
  annotationRepo: IL3AnnotationRepository = makeAnnotationRepo(),
  contextRepo: IL3ContextRepository = makeContextRepo(),
): L3SheetExportService {
  return new L3SheetExportService(
    sheetRepo,
    paperRepo,
    annotationRepo,
    contextRepo,
    async (callback) => callback({} as never),
    () => ({
      l3Sheets: sheetRepo,
      l3Paper: paperRepo,
      l3Annotations: annotationRepo,
      l3Context: contextRepo,
    } as unknown as IRepositories),
  );
}

describe("L3SheetExportService.exportSheet", () => {
  it("404s for a missing or foreign sheet", async () => {
    const service = makeService(makeSheetRepo({ getSheet: vi.fn(async () => null) }));
    await expect(service.exportSheet(USER, SHEET)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("409s for a draft sheet (export requires a settled sheet)", async () => {
    const service = makeService(makeSheetRepo({ getSheet: vi.fn(async () => submissionRow({ status: "draft" })) }));
    await expect(service.exportSheet(USER, SHEET)).rejects.toBeInstanceOf(ConflictError);
  });

  it("returns a stable markdown archive with sha256 and version", async () => {
    const service = makeService(makeSheetRepo());
    const first = await service.exportSheet(USER, SHEET);
    expect(first.schemaVersion).toBe(L3_SHEET_EXPORT_SCHEMA_VERSION);
    expect(first.filename).toBe(`l3-sheet-${SHEET.slice(0, 8)}.md`);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.stats).toEqual({ attempts: 1, cleared: 0, annotations: 1 });
    expect(first.markdown).toContain("==trap phrase==");
    expect(first.markdown).not.toContain(ANSWER_SENTINEL);

    // sha256 与产物内容一一对应（消费方可先校验再消费，ADR-0025 §1）。
    expect(createHash("sha256").update(first.markdown, "utf8").digest("hex")).toBe(first.sha256);
  });
});
