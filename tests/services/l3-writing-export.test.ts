/**
 * L3WritingExportService 单测（W9，ADR《writing-workspace》§7；S§7 逐条验收）。
 * 覆盖：sealed 从 attempt / draft 带 draftVersion / cleared·discarded 409 /
 * 反引号+中文+emoji 的 JSON 可提取与 hash 可复算 / 文件名安全 / 只含本稿反馈 /
 * 一致性错误面。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { L3QuestionAttemptRow, L3SubmissionRow } from "@/domain";
import type { L3WritingTaskRow, L3WritingFeedbackRow } from "@/repositories/l3-writing.types";
import {
  L3WritingExportService,
  fenceFor,
  renderWritingExportMarkdown,
} from "@/services/l3-writing-export.service";
import { sha256WritingText } from "@/services/l3-writing-text";

const USER = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-000000000701";
const SHEET = "00000000-0000-4000-8000-000000000801";
const OTHER_SHEET = "00000000-0000-4000-8000-000000000802";
const QUESTION = "00000000-0000-4000-8000-000000000101";

const TEXT = "第一段有 `单反引号` 与 ``` 三连围栏\n\n第二段 😀 emoji 中文。";

function nowIso(): string {
  return "2026-09-18T02:00:00.000Z";
}

function taskRow(overrides: Partial<L3WritingTaskRow> = {}): L3WritingTaskRow {
  return {
    id: TASK, user_id: USER, question_id: QUESTION, title: "谈谈你的看法", kind: "free",
    direction: "通用", status: "active", create_request_id: "00000000-0000-4000-8000-000000000903",
    create_input_hash: "hash", created_at: nowIso(), updated_at: nowIso(), ...overrides,
  };
}

function sheetRow(overrides: Partial<L3SubmissionRow> = {}): L3SubmissionRow {
  return {
    id: SHEET, user_id: USER, scope: "writing", scope_key: `writing:${TASK}`,
    source_id: null, question_type: null, paper_id: null, writing_task_id: TASK,
    parent_sheet_id: null, revision_no: 1, draft_version: 2, status: "sealed",
    answers: {}, seal_mode: "full", summary: null, sealed_at: nowIso(),
    created_at: nowIso(), updated_at: nowIso(), ...overrides,
  };
}

function attemptRow(overrides: Partial<L3QuestionAttemptRow> = {}): L3QuestionAttemptRow {
  return {
    id: "00000000-0000-4000-8000-000000000951", user_id: USER, question_id: QUESTION,
    sheet_id: SHEET, venue: "writing", answer: { text: TEXT }, self_assessment: null,
    status: "active", deleted_at: null, created_at: nowIso(), ...overrides,
  };
}

function feedbackRow(overrides: Partial<L3WritingFeedbackRow> = {}): L3WritingFeedbackRow {
  return {
    id: "00000000-0000-4000-8000-000000000921", user_id: USER, sheet_id: SHEET,
    text_sha256: sha256WritingText(TEXT), schema_version: 1,
    feedback: {
      schemaVersion: 1, summary: "s", strengths: [],
      dimensions: {
        task_response: { applicable: true, comment: "c" },
        organization: { applicable: true, comment: "c" },
        language: { applicable: true, comment: "c" },
        expression: { applicable: false, comment: "本稿不评。" },
      },
      priorities: [],
    },
    version: 1, request_id: "00000000-0000-4000-8000-000000000902", last_editor: "agent-a",
    created_at: nowIso(), updated_at: nowIso(), ...overrides,
  };
}

class FakeExportRepos {
  task: L3WritingTaskRow | null = taskRow();
  sheet: L3SubmissionRow | null = sheetRow();
  attempt: L3QuestionAttemptRow | null = attemptRow();
  feedback: L3WritingFeedbackRow | null = null;
  question: { id: string; stem: string } | null = { id: QUESTION, stem: "谈谈你的看法。" };

  l3Writing = {
    findTaskById: async (userId: string, taskId: string) =>
      this.task && this.task.user_id === userId && this.task.id === taskId ? this.task : null,
    findSheetById: async (userId: string, taskId: string, sheetId: string) =>
      this.sheet && this.sheet.user_id === userId && this.sheet.writing_task_id === taskId && this.sheet.id === sheetId
        ? this.sheet
        : null,
    findWritingAttempt: async (_userId: string, sheetId: string) =>
      this.attempt && this.attempt.sheet_id === sheetId ? this.attempt : null,
  };

  l3Paper = {
    findQuestionById: async () => this.question,
  };

  l3Feedback = {
    findBySheet: async (_userId: string, sheetId: string) =>
      this.feedback && this.feedback.sheet_id === sheetId ? this.feedback : null,
  };
}

function makeService(repos: FakeExportRepos): L3WritingExportService {
  const fakeTxRunner = (async (cb: (tx: undefined) => Promise<unknown>) => cb(undefined)) as never;
  return new L3WritingExportService((() => repos as never) as never, fakeTxRunner);
}

/** 提取最后一个 JSON 围栏块（行锚定：闭栏=行首同长反引号串；对齐真实提取器）。 */
function extractLastJsonBlock(markdown: string): Record<string, unknown> {
  const matches = [...markdown.matchAll(/(?:^|\n)(`{3,})json\n([\s\S]*?)\n\1\n?/g)];
  expect(matches.length).toBeGreaterThan(0);
  const last = matches[matches.length - 1]!;
  return JSON.parse(last[2]!) as Record<string, unknown>;
}

/** 复算：删除内容校验行后哈希（题纸导出同规则）。 */
function recomputeSha(markdown: string): string {
  const without = markdown.replace(/^- 内容校验: sha256:[0-9a-f]{64}（删除本行后可复算）\n/m, "");
  return createHash("sha256").update(without, "utf8").digest("hex");
}

describe("W9 导出：sealed（attempt 正文 + 反馈绑定 + 可复算哈希）", () => {
  it("JSON 可提取、hash 可复算、反引号围栏安全、文件名安全", async () => {
    const repos = new FakeExportRepos();
    repos.feedback = feedbackRow();
    const service = makeService(repos);
    const result = await service.exportSheet(USER, TASK, SHEET);

    expect(result.schemaVersion).toBe(1);
    expect(result.filename).toMatch(/^writing-[0-9a-f-]{36}\.md$/);
    expect(result.sha256).toBe(recomputeSha(result.markdown));

    const payload = extractLastJsonBlock(result.markdown);
    expect(payload.exportSchemaVersion).toBe(1);
    expect(payload.kind).toBe("writing_sheet");
    expect((payload.task as { prompt: string }).prompt).toBe("谈谈你的看法。");
    expect((payload.sheet as { revisionNo: number }).revisionNo).toBe(1);
    expect(payload.text).toBe(TEXT);
    expect(payload.textSha256).toBe(sha256WritingText(TEXT));
    expect((payload.feedback as { version: number }).version).toBe(1);

    // 正文含 ``` 时围栏加长（4 连），不会被内容提前闭合。
    expect(fenceFor(TEXT)).toBe("````");
    expect(result.markdown).toContain("````");
    expect(result.markdown).toContain("## 正文");
  });

  it("只含本稿反馈（其他稿反馈不混入）", async () => {
    const repos = new FakeExportRepos();
    repos.feedback = feedbackRow({ sheet_id: OTHER_SHEET });
    const service = makeService(repos);
    const result = await service.exportSheet(USER, TASK, SHEET);
    expect(extractLastJsonBlock(result.markdown).feedback).toBeNull();
  });
});

describe("W9 导出：draft（带实际 draftVersion）", () => {
  it("draft 快照：JSON.sheet.draftVersion 与正文来自 answers", async () => {
    const repos = new FakeExportRepos();
    repos.sheet = sheetRow({
      status: "draft", revision_no: null, draft_version: 3, seal_mode: null, sealed_at: null,
      answers: { [QUESTION]: { text: "半稿正文" } },
    });
    const service = makeService(repos);
    const result = await service.exportSheet(USER, TASK, SHEET);
    const payload = extractLastJsonBlock(result.markdown);
    const sheet = payload.sheet as { status: string; draftVersion: number };
    expect(sheet.status).toBe("draft");
    expect(sheet.draftVersion).toBe(3);
    expect(payload.text).toBe("半稿正文");
    expect(result.markdown).toContain("draftVersion=3");
  });
});

describe("W9 导出：终态与一致性守卫", () => {
  it("cleared（attempt 软删/缺失）→ 409 WRITING_CONTENT_CLEARED（不泄漏反馈）", async () => {
    const repos = new FakeExportRepos();
    repos.attempt = attemptRow({ status: "deleted", deleted_at: nowIso() });
    repos.feedback = feedbackRow(); // 即使残留反馈也不导出（应已被清理，防泄漏）
    const service = makeService(repos);
    await expect(service.exportSheet(USER, TASK, SHEET)).rejects.toMatchObject({
      httpStatus: 409,
      meta: { code: "WRITING_CONTENT_CLEARED" },
    });
  });

  it("discarded → 409 WRITING_CONTENT_CLEARED", async () => {
    const repos = new FakeExportRepos();
    repos.sheet = sheetRow({ status: "discarded", revision_no: null });
    const service = makeService(repos);
    await expect(service.exportSheet(USER, TASK, SHEET)).rejects.toMatchObject({
      httpStatus: 409,
      meta: { code: "WRITING_CONTENT_CLEARED" },
    });
  });

  it("任务/稿不存在 → 404；题面缺失 / 稿号非法 / 正文结构损坏 → 500 一致性错误", async () => {
    const repos = new FakeExportRepos();
    const service = makeService(repos);

    repos.task = null;
    await expect(service.exportSheet(USER, TASK, SHEET)).rejects.toMatchObject({ httpStatus: 404 });
    repos.task = taskRow();

    repos.question = null;
    await expect(service.exportSheet(USER, TASK, SHEET)).rejects.toMatchObject({
      httpStatus: 500, meta: { code: "WRITING_DATA_INCONSISTENT" },
    });
    repos.question = { id: QUESTION, stem: "谈谈你的看法。" };

    repos.sheet = sheetRow({ revision_no: null });
    await expect(service.exportSheet(USER, TASK, SHEET)).rejects.toMatchObject({
      httpStatus: 500, meta: { code: "WRITING_DATA_INCONSISTENT" },
    });
    repos.sheet = sheetRow();

    repos.attempt = attemptRow({ answer: { text: 42 } });
    await expect(service.exportSheet(USER, TASK, SHEET)).rejects.toMatchObject({
      httpStatus: 500, meta: { code: "WRITING_DATA_INCONSISTENT" },
    });
  });
});

describe("W9 渲染纯函数（双段渲染可复算）", () => {
  it("renderWritingExportMarkdown：sha256 与「删除校验行」复算一致且确定性", () => {
    const input = {
      payload: {
        exportSchemaVersion: 1 as const,
        kind: "writing_sheet" as const,
        exportedAt: "2026-09-18T02:00:00.000Z",
        task: { id: TASK },
        sheet: { id: SHEET } as never,
        text: "A `code` B",
        textSha256: sha256WritingText("A `code` B"),
        feedback: null,
      },
      taskTitle: "标题",
      kind: "自由写作",
      direction: "通用",
      revisionLabel: "第 1 稿",
      parentSheetId: null,
      feedbackLabel: "（尚无）",
      text: "A `code` B",
      prompt: "题面",
    };
    const first = renderWritingExportMarkdown(input);
    const second = renderWritingExportMarkdown(input);
    expect(first.sha256).toBe(second.sha256);
    expect(recomputeSha(first.markdown)).toBe(first.sha256);
  });
});
