/**
 * 作文子空间响应契约测试（W6）：S§6 形状解析通过 / 越界拒绝（fail-closed）。
 */
import { describe, expect, it } from "vitest";
import {
  l3WritingDraftCreateResponseSchema,
  l3WritingFeedbackContextResponseSchema,
  l3WritingFeedbackGetResponseSchema,
  l3WritingSaveResponseSchema,
  l3WritingSheetDetailResponseSchema,
  l3WritingSheetResponseSchema,
  l3WritingSubmitResponseSchema,
  l3WritingTaskCreateResponseSchema,
  l3WritingTaskDetailResponseSchema,
  l3WritingTaskListResponseSchema,
  l3WritingTaskResponseSchema,
} from "@/http/l3-writing-response-contract";

const TASK_ID = "00000000-0000-4000-8000-000000000701";
const SHEET_ID = "00000000-0000-4000-8000-000000000801";
const QUESTION_ID = "00000000-0000-4000-8000-000000000101";
const SHA = "a".repeat(64);

const task = {
  id: TASK_ID,
  questionId: QUESTION_ID,
  title: "任务",
  prompt: "自由写作",
  kind: "free",
  direction: "通用",
  status: "active",
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};

const sheet = {
  id: SHEET_ID,
  taskId: TASK_ID,
  status: "draft",
  draftVersion: 0,
  revisionNo: null,
  parentSheetId: null,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
  sealedAt: null,
};

const feedback = {
  schemaVersion: 1,
  summary: "结构清楚。",
  strengths: ["立场明确"],
  dimensions: {
    task_response: { applicable: true, comment: "回应了题目。" },
    organization: { applicable: true, comment: "结构可辨。" },
    language: { applicable: true, comment: "基本通顺。" },
    expression: { applicable: false, comment: "本稿不评表达风格。" },
  },
  priorities: [
    { id: "p1", dimension: "task_response", observation: "缺少例子。", action: "补例。", anchor: null },
  ],
};

describe("作文响应契约（解析通过）", () => {
  it("task/sheet/列表/详情/稿次/保存/提交/创建 全形状通过", () => {
    expect(l3WritingTaskResponseSchema.safeParse(task).success).toBe(true);
    expect(l3WritingSheetResponseSchema.safeParse(sheet).success).toBe(true);
    expect(l3WritingTaskCreateResponseSchema.safeParse({ task, draft: sheet, created: true }).success).toBe(true);
    expect(l3WritingTaskCreateResponseSchema.safeParse({ task, draft: null, created: false }).success).toBe(true);
    const summary = {
      task: { id: TASK_ID, questionId: QUESTION_ID, title: "任务", kind: "free", direction: "通用", status: "active",
        createdAt: task.createdAt, updatedAt: task.updatedAt },
      draftSheetId: SHEET_ID,
      lastSheetId: null,
      latestRevisionNo: null,
    };
    expect(l3WritingTaskListResponseSchema.safeParse({ items: [summary], total: 1, nextCursor: null }).success).toBe(true);
    // summary 携带 prompt（summary 面不含题面全文）→ 拒绝。
    expect(l3WritingTaskListResponseSchema.safeParse({
      items: [{ ...summary, task: { ...summary.task, prompt: "x" } }], total: 1, nextCursor: null,
    }).success).toBe(false);

    expect(l3WritingTaskDetailResponseSchema.safeParse({
      task, draftSummary: sheet, revisionCount: 2, latestSubmittedSheetId: SHEET_ID,
    }).success).toBe(true);

    expect(l3WritingSaveResponseSchema.safeParse({ sheet, textSha256: SHA }).success).toBe(true);
    expect(l3WritingSubmitResponseSchema.safeParse({ sheet, attemptId: TASK_ID }).success).toBe(true);
    expect(l3WritingDraftCreateResponseSchema.safeParse({ sheet, created: false }).success).toBe(true);
  });

  it("反馈记录 / 读取 / 上下文 / 稿详情 全形状通过", () => {
    const record = { feedback, version: 1, textSha256: SHA, lastEditor: "agent-a", updatedAt: "2026-09-18T01:00:00.000Z" };
    expect(l3WritingFeedbackGetResponseSchema.safeParse({ state: "ready", feedback: record }).success).toBe(true);
    expect(l3WritingFeedbackGetResponseSchema.safeParse({ state: "pending", feedback: null }).success).toBe(true);

    expect(l3WritingFeedbackContextResponseSchema.safeParse({
      taskId: TASK_ID, sheetId: SHEET_ID, revisionNo: 1, kind: "free", direction: "通用",
      prompt: "自由写作", text: "定稿", textSha256: SHA, wordCount: 2,
      feedbackVersion: 0, feedbackSchemaVersion: 1,
    }).success).toBe(true);

    expect(l3WritingSheetDetailResponseSchema.safeParse({
      sheet: { ...sheet, status: "sealed", revisionNo: 1, sealedAt: "2026-09-18T01:00:00.000Z" },
      text: "定稿", textSha256: SHA, wordCount: 2, contentStatus: "available", feedback: record,
    }).success).toBe(true);
    expect(l3WritingSheetDetailResponseSchema.safeParse({
      sheet: { ...sheet, status: "sealed", revisionNo: 1 },
      text: null, textSha256: null, wordCount: 0, contentStatus: "cleared", feedback: null,
    }).success).toBe(true);
  });
});

describe("作文响应契约（越界拒绝，fail-closed）", () => {
  it("未知键 / 越界枚举 / 形状不符全部拒绝", () => {
    expect(l3WritingTaskResponseSchema.safeParse({ ...task, extra: 1 }).success).toBe(false);
    expect(l3WritingTaskResponseSchema.safeParse({ ...task, kind: "essay" }).success).toBe(false);
    expect(l3WritingTaskResponseSchema.safeParse({ ...task, id: "not-uuid" }).success).toBe(false);
    expect(l3WritingSheetResponseSchema.safeParse({ ...sheet, revisionNo: 0 }).success).toBe(false); // sealed 稿号 >0 或 null
    expect(l3WritingSaveResponseSchema.safeParse({ sheet, textSha256: "short" }).success).toBe(false);
    expect(l3WritingFeedbackGetResponseSchema.safeParse({ state: "processing", feedback: null }).success).toBe(false);
    expect(l3WritingFeedbackGetResponseSchema.safeParse({ state: "ready", feedback: null }).success).toBe(true); // ready 允许 null（读取失败即非 2xx，不由 schema 兜）
    expect(l3WritingFeedbackContextResponseSchema.safeParse({
      taskId: TASK_ID, sheetId: SHEET_ID, revisionNo: 0, kind: "free", direction: "通用",
      prompt: "p", text: "t", textSha256: SHA, wordCount: 0, feedbackVersion: 0, feedbackSchemaVersion: 1,
    }).success).toBe(false); // revisionNo 必须 >0（不得用 0 伪造上下文）
    expect(l3WritingFeedbackContextResponseSchema.safeParse({
      taskId: TASK_ID, sheetId: SHEET_ID, revisionNo: 1, kind: "free", direction: "通用",
      prompt: "p", text: "t", textSha256: SHA, wordCount: 0, feedbackVersion: -1, feedbackSchemaVersion: 1,
    }).success).toBe(false);
  });
});
