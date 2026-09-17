import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError } from "@/errors";
import type {
  L3QuestionAnnotationRow,
  L3QuestionAssessmentRow,
  L3QuestionAttemptRow,
  L3QuestionRow,
  L3SubmissionRow,
} from "@/domain";
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
  decorateArticle,
  renderSheetExportMarkdown,
  type L3SheetExportInput,
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
    anchor_start: 4,
    anchor_end: 15,
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

function assessmentRow(overrides: Partial<L3QuestionAssessmentRow> = {}): L3QuestionAssessmentRow {
  return {
    id: "00000000-0000-4000-8000-000000000701",
    user_id: USER,
    question_id: Q1,
    content_md: "本题判据有效；标记命中原文关键句。",
    last_editor: "agent",
    created_at: "2026-09-17T02:00:00.000Z",
    updated_at: "2026-09-17T02:30:00.000Z",
    ...overrides,
  };
}

const ARTICLE = { id: SOURCE, title: "Text 1", content: "The trap phrase hides here." };

function exportInput(overrides: Partial<L3SheetExportInput> = {}): L3SheetExportInput {
  return {
    sheet: submissionRow(),
    questions: [questionRow()],
    attempts: [attemptRow()],
    annotations: [annotationRow()],
    assessments: [],
    articles: [ARTICLE],
    answers: {},
    withAnswers: true,
    exportedAt: "2026-09-17T03:00:00.000Z",
    ...overrides,
  };
}

/** v2 sha256 复算：删除「- 内容校验:」行后重算（自描述约定）。 */
function recomputeSha256(markdown: string): string {
  const stripped = markdown.split("\n").filter((line) => !line.startsWith("- 内容校验:")).join("\n");
  return createHash("sha256").update(stripped, "utf8").digest("hex");
}

function extractJsonBlock(markdown: string): Record<string, unknown> {
  const match = markdown.match(/```json\n([\s\S]*?)\n```/);
  expect(match).toBeTruthy();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

describe("decorateArticle（原文高亮与注记编号，v2 §4.6/§6）", () => {
  const content = "The trap phrase hides here.";

  it("marks 与注记锚点并集高亮；注记结束处 [n] 编号", () => {
    const decorated = decorateArticle(
      content,
      [{ start: 16, end: 21 }], // "hides"
      [{ number: 1, start: 4, end: 15 }], // "trap phrase"
    );
    expect(decorated).toBe("The ==trap phrase== [1] ==hides== here.");
  });

  it("相邻区间相邻时不合并（各段独立渲染）", () => {
    const decorated = decorateArticle(content, [{ start: 0, end: 3 }], [{ number: 2, start: 4, end: 8 }]);
    expect(decorated).toBe("==The== ==trap== [2] phrase hides here.");
  });

  it("越界区间按边界裁剪；无区间原样返回", () => {
    expect(decorateArticle(content, [{ start: -5, end: 3 }], [])).toBe("==The== trap phrase hides here.");
    expect(decorateArticle(content, [{ start: 20, end: 999 }], [])).toBe("The trap phrase hide==s here.==");
    expect(decorateArticle(content, [], [])).toBe(content);
  });
});

describe("renderSheetExportMarkdown（v2）", () => {
  it("渲染 v2 页眉/原文标记/题面/作答与痕迹/注记清单/统计/json 块，且绝不携出标准答案与 evidence 哨兵", () => {
    const { markdown, sha256 } = renderSheetExportMarkdown(exportInput({
      attempts: [attemptRow({ self_assessment: { flags: { doubt: true, recheck: true }, optionFlags: ["A"], marks: [{ scope: "passage", start: 16, end: 21 }] } })],
    }));

    expect(markdown).toContain("# L3 题纸档案（v2）");
    expect(markdown).toContain(`导出 schema 版本: ${L3_SHEET_EXPORT_SCHEMA_VERSION}`);
    expect(markdown).toContain("- 状态: 已定格（完整记录）");
    expect(markdown).toContain("- 内容校验: sha256:");
    // 原文与标记：注记锚点高亮 + [1] 编号；self_assessment.marks 高亮
    expect(markdown).toContain("## 原文与标记");
    expect(markdown).toContain("The ==trap phrase== [1] ==hides== here.");
    // 题面
    expect(markdown).toContain("## 题面");
    expect(markdown).toContain("21. Why did the author mention the tip?");
    // 作答与痕迹（sealed + withAnswers）：choice + 当场痕迹
    expect(markdown).toContain("## 作答与痕迹");
    expect(markdown).toContain("选 B");
    expect(markdown).toContain("当场痕迹: 存疑 / 待复查 ｜ 选项存疑 A ｜ 重点标记 1 处");
    // 注记清单（stage + 编号）
    expect(markdown).toContain("## 注记清单");
    expect(markdown).toContain("### [1] 待检验 · 题: 21. Why");
    expect(markdown).toContain("==trap phrase==");
    // 统计（sealed）
    expect(markdown).toContain("## 统计");
    expect(markdown).toContain("作答记录: 1 条");
    // json 块可解析且不含答案
    const json = extractJsonBlock(markdown);
    expect(json.exportSchemaVersion).toBe(2);
    expect(json.withAnswers).toBe(true);
    // 安全：标准答案 / 解析 / evidence 不得出现（哨兵逐字断言，含 json 块）。
    expect(markdown).not.toContain(ANSWER_SENTINEL);
    expect(markdown).not.toContain("官方解析");
    // sha256 复算一致（删校验行后重算）
    expect(recomputeSha256(markdown)).toBe(sha256);
  });

  it("评析段渲染（last_editor 留痕 + 正文）", () => {
    const { markdown } = renderSheetExportMarkdown(exportInput({ assessments: [assessmentRow()] }));
    expect(markdown).toContain("## 评析");
    expect(markdown).toContain("（agent 编辑 · 2026-09-17T02:30:00.000Z）");
    expect(markdown).toContain("本题判据有效；标记命中原文关键句。");
    const json = extractJsonBlock(markdown);
    expect(json.assessments).toEqual([{
      questionId: Q1,
      contentMd: "本题判据有效；标记命中原文关键句。",
      lastEditor: "agent",
      updatedAt: "2026-09-17T02:30:00.000Z",
    }]);
  });

  it("draft 快照：页眉标注导出时刻 + withAnswers=false 不含作答但痕迹（marks）恒渲染", () => {
    const { markdown } = renderSheetExportMarkdown(exportInput({
      sheet: submissionRow({ status: "draft", seal_mode: null, answers: { [Q1]: { choice: "B" } } }),
      attempts: [],
      answers: { [Q1]: { choice: "B", marks: [{ scope: "passage", start: 4, end: 15 }] } },
      withAnswers: false,
    }));
    expect(markdown).toContain("- 状态: 草稿快照（导出时刻）");
    expect(markdown).toContain("- 作答痕迹: 不含");
    expect(markdown).toContain("（未包含作答痕迹）");
    expect(markdown).not.toContain("选 B");
    // 痕迹恒渲染：marks 高亮仍在原文段
    expect(markdown).toContain("The ==trap phrase== [1] hides here.");
    // draft 不渲染统计段
    expect(markdown).not.toContain("## 统计");
    const json = extractJsonBlock(markdown);
    expect(json.withAnswers).toBe(false);
    expect(json.answers).toEqual({});
    expect(json.attempts).toEqual([]);
  });

  it("draft 快照 + withAnswers=true：渲染逐题答案与痕迹，json 携带 answers", () => {
    const { markdown } = renderSheetExportMarkdown(exportInput({
      sheet: submissionRow({ status: "draft", seal_mode: null }),
      attempts: [],
      answers: { [Q1]: { choice: "B", flags: { recheck: true }, optionFlags: ["A"], marks: [{ scope: "stem", start: 4, end: 11 }] } },
      withAnswers: true,
    }));
    expect(markdown).toContain("选 B ｜ 待复查 ｜ 选项存疑 A ｜ 重点标记 1 处");
    const json = extractJsonBlock(markdown);
    expect(json.answers).toEqual({ [Q1]: { choice: "B", flags: { recheck: true }, optionFlags: ["A"], marks: [{ scope: "stem", start: 4, end: 11 }] } });
  });

  it("deleted 作答显示「内容已清理」，统计保持交卷时口径", () => {
    const { markdown } = renderSheetExportMarkdown(exportInput({
      attempts: [
        attemptRow(),
        attemptRow({ id: "00000000-0000-4000-8000-000000000502", question_id: Q2, status: "deleted", deleted_at: "2026-09-17T04:00:00.000Z", answer: null }),
      ],
      annotations: [],
    }));
    expect(markdown).toContain("作答记录: 2 条（含 1 条已清理）");
    expect(markdown).toContain("内容已清理");
  });

  it("有评审时渲染 verdict 与订正建议", () => {
    const { markdown } = renderSheetExportMarkdown(exportInput({
      annotations: [annotationRow({
        review: { verdict: "questionable", corrected_tags: ["偷换概念", "无中生有"], comment: "选项 B 的归因值得再核对" },
      })],
    }));
    expect(markdown).toContain("评审: 存疑 — 选项 B 的归因值得再核对（订正建议: 偷换概念、无中生有）");
  });
});

describe("renderSheetExportMarkdown · 边界臂全覆盖", () => {
  it("答案形状（string/choices/text/未知）与评审边界（非对象/数组/未知 verdict/空注释/空订正）妥善降级", () => {
    const { markdown } = renderSheetExportMarkdown(exportInput({
      sheet: submissionRow({ seal_mode: null }),
      attempts: [
        attemptRow({ id: "a-str", answer: "free text answer" }),
        attemptRow({ id: "a-choices", answer: { choices: ["A", "C"] } }),
        attemptRow({ id: "a-text", answer: { text: "translated text" } }),
        attemptRow({ id: "a-weird", answer: { unknownShape: true } }),
      ],
      annotations: [
        annotationRow({ id: "ann-1", review: 42 }),
        annotationRow({ id: "ann-2", review: [] }),
        annotationRow({ id: "ann-3", review: { verdict: "custom_verdict" } }),
        annotationRow({ id: "ann-4", review: { verdict: "sound", comment: "   ", corrected_tags: [] } }),
        annotationRow({ id: "ann-5", review: { verdict: "wrong", corrected_tags: ["X"] } }),
        annotationRow({ id: "ann-6", excerpt: null, anchor_start: null, anchor_end: null, note: "无锚点注记" }),
        annotationRow({ id: "ann-7", excerpt: "orphan", anchor_start: null, anchor_end: null, note: "半锚点防御" }),
      ],
      articles: [{ id: null, title: null, content: null }],
    }));
    expect(markdown).toContain("free text answer");
    expect(markdown).toContain("多选 AC");
    expect(markdown).toContain("translated text");
    expect(markdown).toContain("已作答");
    expect(markdown).toContain("（未命名材料）");
    expect(markdown).toContain("（无正文）");
    expect(markdown).toContain("无锚点注记");
    expect(markdown).toContain("半锚点防御");
    expect(markdown).toContain("评审: 成立");
    expect(markdown).toContain("评审: custom_verdict");
    expect(markdown).toContain("评审: 有误（订正建议: X）");
    expect(markdown).toContain("（待检验）");
  });

  it("self_assessment 脏值（非对象/数组/空 flags）优雅降级；有效 marks（含 stem）计数进痕迹摘要", () => {
    const dirty = renderSheetExportMarkdown(exportInput({
      attempts: [
        attemptRow({ id: "t-1", self_assessment: "dirty" }),
        attemptRow({ id: "t-2", self_assessment: [] }),
        attemptRow({ id: "t-3", self_assessment: { flags: {}, optionFlags: [] } }),
      ],
      annotations: [],
    }));
    expect(dirty.markdown).not.toContain("当场痕迹");
    expect(dirty.markdown).toContain("选 B");

    const stemMarked = renderSheetExportMarkdown(exportInput({
      attempts: [
        attemptRow({ self_assessment: { marks: [{ scope: "stem", start: 1, end: 2 }] } }),
      ],
      annotations: [],
    }));
    // stem marks 不进原文高亮（非 passage），但计数进当场痕迹摘要（对 agent 是信息）。
    expect(stemMarked.markdown).toContain("当场痕迹: 重点标记 1 处");
    expect(stemMarked.markdown).not.toContain("====");
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
    getAnnotation: vi.fn(async () => null),
    withdrawAnnotation: vi.fn(async () => null),
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
  assessments: L3QuestionAssessmentRow[] = [],
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
      l3Assessments: { listByQuestions: vi.fn(async () => assessments) },
    } as unknown as IRepositories),
  );
}

const PAPER_ID = "00000000-0000-4000-8000-000000000303";

function paperRow(): import("@/domain").L3PaperRow {
  return {
    id: PAPER_ID,
    user_id: USER,
    title: "2025 英语一",
    direction: null,
    metadata: {},
    payload: {
      version: 1,
      sections: [
        { key: "s1", title: "Text 1", questionType: "reading_choice", sourceId: SOURCE, fileKey: null, questionIds: [Q1] },
        { key: "s2", title: "Text 2", questionType: "reading_choice", sourceId: null, fileKey: "fk-2", questionIds: [] },
        { key: "s3", title: "Text 1b", questionType: "reading_choice", sourceId: SOURCE, fileKey: null, questionIds: [] },
      ],
    },
    payload_version: 1,
    status: "active",
    created_by: "owner",
    input_hash: null,
    created_at: "2026-09-17T00:00:00.000Z",
    updated_at: "2026-09-17T00:00:00.000Z",
  };
}

describe("L3SheetExportService.exportSheet（v2 三状态分流）", () => {
  it("paper venue：作用域按 payload 顺序解析，文章去重且跳过无来源 section", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({
        scope: "paper", source_id: null, question_type: null, paper_id: PAPER_ID, seal_mode: null,
      })),
      listBySheet: vi.fn(async () => []),
    });
    const paperRepo = makePaperRepo({
      findPaperById: vi.fn(async () => paperRow()),
      findActiveQuestionsByIds: vi.fn(async () => [questionRow()]),
    });
    const annotationRepo = makeAnnotationRepo({ listAnnotationsBySheet: vi.fn(async () => []) });
    const service = makeService(sheetRepo, paperRepo, annotationRepo);

    const result = await service.exportSheet(USER, SHEET);
    expect(result.markdown).toContain("范围: 整卷");
    expect(result.markdown).toContain("（无作答记录）");
    // 文章按 section 去重：同一 source 在「原文与标记」段只出现一次（json 全量块另计）。
    const articleSection = result.markdown.split("## 原文与标记")[1]!.split("## 题面")[0]!;
    expect(articleSection.match(/The trap phrase hides here\./g)).toHaveLength(1);
  });

  it("404s for a missing or foreign sheet", async () => {
    const service = makeService(makeSheetRepo({ getSheet: vi.fn(async () => null) }));
    await expect(service.exportSheet(USER, SHEET)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("discarded 题纸 409（其产物是注记本身，不属题纸导出）", async () => {
    const service = makeService(makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({ status: "discarded", seal_mode: "incremental" })),
    }));
    const rejected = await service.exportSheet(USER, SHEET).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ConflictError);
    expect((rejected as ConflictError).meta).toMatchObject({ status: "discarded" });
  });

  it("draft 快照：默认不含作答（防自我剧透）但痕迹可见；显式 withAnswers=true 含答案", async () => {
    const sheetRepo = makeSheetRepo({
      getSheet: vi.fn(async () => submissionRow({
        status: "draft", seal_mode: null,
        answers: { [Q1]: { choice: "B", marks: [{ scope: "passage", start: 4, end: 15 }] } },
      })),
      listBySheet: vi.fn(async () => []),
    });
    const service = makeService(sheetRepo);

    const snapshot = await service.exportSheet(USER, SHEET);
    expect(snapshot.markdown).toContain("- 状态: 草稿快照（导出时刻）");
    expect(snapshot.markdown).not.toContain("选 B");
    expect(snapshot.markdown).toContain("The ==trap phrase==");
    expect(extractJsonBlock(snapshot.markdown).answers).toEqual({});

    const withAnswers = await service.exportSheet(USER, SHEET, { withAnswers: true });
    expect(withAnswers.markdown).toContain("选 B");
    expect(extractJsonBlock(withAnswers.markdown).answers).toEqual({
      [Q1]: { choice: "B", marks: [{ scope: "passage", start: 4, end: 15 }] },
    });
  });

  it("sealed：默认含作答（withAnswers=true）；显式 false 剥离但痕迹仍在", async () => {
    const sheetRepo = makeSheetRepo({
      listBySheet: vi.fn(async () => [attemptRow({
        self_assessment: { marks: [{ scope: "passage", start: 16, end: 21 }] },
      })]),
    });
    const service = makeService(sheetRepo);

    const archive = await service.exportSheet(USER, SHEET);
    expect(archive.markdown).toContain("选 B");
    expect(archive.markdown).toContain("==hides==");

    const stripped = await service.exportSheet(USER, SHEET, { withAnswers: false });
    expect(stripped.markdown).not.toContain("选 B");
    expect(stripped.markdown).toContain("（未包含作答痕迹）");
    expect(stripped.markdown).toContain("==hides==");
    const json = extractJsonBlock(stripped.markdown);
    expect(json.attempts).toEqual([]);
    expect(json.withAnswers).toBe(false);
  });

  it("评析数据源：service 注入的批量评析进入渲染与 stats", async () => {
    const service = makeService(makeSheetRepo(), makePaperRepo(), makeAnnotationRepo(), makeContextRepo(), [assessmentRow()]);
    const result = await service.exportSheet(USER, SHEET);
    expect(result.markdown).toContain("## 评析");
    expect(result.stats.assessments).toBe(1);
  });

  it("returns a stable archive with recomputable sha256 and version 2", async () => {
    const service = makeService(makeSheetRepo());
    const first = await service.exportSheet(USER, SHEET);
    expect(first.schemaVersion).toBe(L3_SHEET_EXPORT_SCHEMA_VERSION);
    expect(first.schemaVersion).toBe(2);
    expect(first.filename).toBe(`l3-sheet-${SHEET.slice(0, 8)}.md`);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.stats).toEqual({ attempts: 1, cleared: 0, annotations: 1, assessments: 0 });
    expect(first.markdown).toContain("==trap phrase==");
    expect(first.markdown).not.toContain(ANSWER_SENTINEL);

    // v2 sha256 复算：删除「- 内容校验:」行后重算一致（自描述约定）。
    expect(recomputeSha256(first.markdown)).toBe(first.sha256);
  });
});
