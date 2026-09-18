/**
 * L3WritingFeedbackService 单测（W5，ADR《writing-workspace》§5）。
 * 内存 fake 注入：context/feedback 读面守卫（draft 409 / 404 / cleared）、
 * hash/锚点/字节校验、幂等重放、版本 CAS、editor 注入、GET 零写。
 */
import { describe, expect, it } from "vitest";
import type { L3QuestionAttemptRow, L3SubmissionRow } from "@/domain";
import type { L3WritingTaskRow, L3WritingFeedbackRow } from "@/repositories/l3-writing.types";
import { L3WritingFeedbackService, canonicalJson } from "@/services/l3-writing-feedback.service";
import { sha256WritingText } from "@/services/l3-writing-text";
import type { WritingFeedbackRepos } from "@/services/l3-writing-feedback.service";
import type { WritingFeedback } from "@/domain/l3-writing";

const USER = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-000000000701";
const SHEET = "00000000-0000-4000-8000-000000000801";
const QUESTION = "00000000-0000-4000-8000-000000000101";
const REQUEST = "00000000-0000-4000-8000-000000000902";

const TEXT = "第一段。\n\n第二段有 😀 表情。";

function nowIso(): string {
  return new Date().toISOString();
}

function taskRow(overrides: Partial<L3WritingTaskRow> = {}): L3WritingTaskRow {
  return {
    id: TASK, user_id: USER, question_id: QUESTION, title: "任务", kind: "free",
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
    feedback: feedbackFixture(), version: 1, request_id: REQUEST, last_editor: "agent-a",
    created_at: nowIso(), updated_at: nowIso(), ...overrides,
  };
}

function feedbackFixture(overrides: Partial<WritingFeedback> = {}): WritingFeedback {
  return {
    schemaVersion: 1,
    summary: "结构清楚，论据可以更具体。",
    strengths: ["开头立场明确"],
    dimensions: {
      task_response: { applicable: true, comment: "回应了题目。" },
      organization: { applicable: true, comment: "段落可辨。" },
      language: { applicable: true, comment: "基本通顺。" },
      expression: { applicable: false, comment: "本稿不评表达风格。" },
    },
    priorities: [
      {
        id: "p1",
        dimension: "task_response",
        observation: "第二段缺少具体例子。",
        action: "补一个具体事例。",
        anchor: { start: 0, end: 4, quote: "第一段。" },
      },
    ],
    ...overrides,
  };
}

class FakeFeedbackRepos {
  task: L3WritingTaskRow | null = taskRow();
  sheet: L3SubmissionRow | null = sheetRow();
  attempt: L3QuestionAttemptRow = attemptRow();
  feedback: L3WritingFeedbackRow | null = null;
  touchCount = 0;

  l3Writing = {
    findTaskById: async (userId: string, taskId: string) =>
      this.task && this.task.user_id === userId && this.task.id === taskId ? this.task : null,
    lockTask: async (userId: string, taskId: string) => this.l3Writing.findTaskById(userId, taskId),
    findSheetById: async (userId: string, taskId: string, sheetId: string) =>
      this.sheet && this.sheet.user_id === userId && this.sheet.writing_task_id === taskId && this.sheet.id === sheetId
        ? this.sheet
        : null,
    lockSheet: async (userId: string, taskId: string, sheetId: string) =>
      this.l3Writing.findSheetById(userId, taskId, sheetId),
    findWritingAttempt: async () => this.attempt,
    touchTask: async () => { this.touchCount += 1; },
  };

  l3Feedback = {
    findBySheet: async () => this.feedback,
    lockBySheet: async () => this.feedback,
    insertFirst: async (input: {
      user_id: string; sheet_id: string; text_sha256: string; feedback_jsonb: string;
      request_id: string; last_editor: string;
    }) => {
      this.feedback = feedbackRow({
        text_sha256: input.text_sha256,
        feedback: JSON.parse(input.feedback_jsonb) as L3WritingFeedbackRow["feedback"],
        version: 1,
        request_id: input.request_id,
        last_editor: input.last_editor,
      });
      return this.feedback;
    },
    updateCas: async (input: {
      text_sha256: string; feedback_jsonb: string; request_id: string;
      last_editor: string; expected_version: number;
    }) => {
      if (!this.feedback || this.feedback.version !== input.expected_version) return null;
      this.feedback = {
        ...this.feedback,
        text_sha256: input.text_sha256,
        feedback: JSON.parse(input.feedback_jsonb) as L3WritingFeedbackRow["feedback"],
        version: input.expected_version + 1,
        request_id: input.request_id,
        last_editor: input.last_editor,
        updated_at: nowIso(),
      };
      return this.feedback;
    },
  };

  l3Paper = {
    findQuestionById: async () => ({ stem: "题面：谈谈你的看法。" }),
  };
}

function makeService(repos: FakeFeedbackRepos): L3WritingFeedbackService {
  const fakeTxRunner = (async (cb: (tx: undefined) => Promise<unknown>) => cb(undefined)) as never;
  return new L3WritingFeedbackService(
    (() => repos as unknown as WritingFeedbackRepos) as never,
    fakeTxRunner,
  );
}

function putInput(overrides: Record<string, unknown> = {}) {
  return {
    expectedVersion: 0,
    textSha256: sha256WritingText(TEXT),
    requestId: REQUEST,
    feedback: feedbackFixture(),
    ...overrides,
  } as Parameters<L3WritingFeedbackService["putFeedback"]>[3];
}

describe("W5 getContext（sealed 限定 + 精确稿）", () => {
  it("返回题面/形式/方向/稿次/正文/hash 与反馈版本（零写）", async () => {
    const repos = new FakeFeedbackRepos();
    const service = makeService(repos);
    const ctx = await service.getContext(USER, TASK, SHEET);
    expect(ctx.prompt).toBe("题面：谈谈你的看法。");
    expect(ctx.text).toBe(TEXT);
    expect(ctx.textSha256).toBe(sha256WritingText(TEXT));
    expect(ctx.revisionNo).toBe(1);
    expect(ctx.kind).toBe("free");
    expect(ctx.direction).toBe("通用");
    expect(ctx.feedbackVersion).toBeNull();
    expect(ctx.feedbackSchemaVersion).toBe(1);
    expect(repos.touchCount).toBe(0);
  });

  it("draft → 409；非本人/不存在 → 404；正文已清理 → 409 WRITING_CONTENT_CLEARED", async () => {
    const repos = new FakeFeedbackRepos();
    const service = makeService(repos);
    repos.sheet = sheetRow({ status: "draft" });
    await expect(service.getContext(USER, TASK, SHEET)).rejects.toMatchObject({ httpStatus: 409 });

    repos.sheet = sheetRow();
    await expect(service.getContext(USER, "00000000-0000-4000-8000-000000000799", SHEET))
      .rejects.toMatchObject({ httpStatus: 404 });

    repos.attempt = attemptRow({ status: "deleted", deleted_at: nowIso() });
    await expect(service.getContext(USER, TASK, SHEET))
      .rejects.toMatchObject({ httpStatus: 409, meta: { code: "WRITING_CONTENT_CLEARED" } });
  });
});

describe("W5 getFeedback（pending ≠ 错误）", () => {
  it("无行 → pending/feedback=null；有行 → ready + 记录（零写）", async () => {
    const repos = new FakeFeedbackRepos();
    const service = makeService(repos);
    const pending = await service.getFeedback(USER, TASK, SHEET);
    expect(pending).toEqual({ state: "pending", feedback: null });

    repos.feedback = feedbackRow();
    const ready = await service.getFeedback(USER, TASK, SHEET);
    expect(ready.state).toBe("ready");
    expect(ready.feedback?.version).toBe(1);
    expect(ready.feedback?.lastEditor).toBe("agent-a");
    expect(repos.touchCount).toBe(0);
  });

  it("draft → 409；cleared → 409", async () => {
    const repos = new FakeFeedbackRepos();
    const service = makeService(repos);
    repos.sheet = sheetRow({ status: "draft" });
    await expect(service.getFeedback(USER, TASK, SHEET)).rejects.toMatchObject({ httpStatus: 409 });
    repos.sheet = sheetRow();
    repos.attempt = attemptRow({ status: "deleted", deleted_at: nowIso() });
    await expect(service.getFeedback(USER, TASK, SHEET))
      .rejects.toMatchObject({ httpStatus: 409, meta: { code: "WRITING_CONTENT_CLEARED" } });
  });
});

describe("W5 putFeedback（绑定校验 + 幂等 + 版本 CAS）", () => {
  it("首写：版本 1、editor 注入、touchTask；重放（同 requestId 同内容）不升版", async () => {
    const repos = new FakeFeedbackRepos();
    const service = makeService(repos);
    const first = await service.putFeedback(USER, TASK, SHEET, putInput(), "agent-a");
    expect(first.version).toBe(1);
    expect(first.lastEditor).toBe("agent-a");
    expect(repos.touchCount).toBe(1);

    const replay = await service.putFeedback(USER, TASK, SHEET, putInput(), "agent-a");
    expect(replay.version).toBe(1);
    expect(repos.touchCount).toBe(1); // 重放不触写
  });

  it("同 requestId 不同内容 → 409 FEEDBACK_REQUEST_CONFLICT", async () => {
    const repos = new FakeFeedbackRepos();
    const service = makeService(repos);
    await service.putFeedback(USER, TASK, SHEET, putInput(), "agent-a");
    await expect(service.putFeedback(
      USER, TASK, SHEET,
      putInput({ feedback: feedbackFixture({ summary: "换了完全不同的评语" }) }),
      "agent-a",
    )).rejects.toMatchObject({ httpStatus: 409, meta: { code: "FEEDBACK_REQUEST_CONFLICT" } });
  });

  it("版本语义：0=首次；已有行用 0 或旧版本 → 409；正确版本 → version+1 覆写", async () => {
    const repos = new FakeFeedbackRepos();
    const service = makeService(repos);
    await service.putFeedback(USER, TASK, SHEET, putInput(), "agent-a");

    await expect(service.putFeedback(
      USER, TASK, SHEET, putInput({ requestId: "00000000-0000-4000-8000-000000000904" }), "agent-b",
    )).rejects.toMatchObject({ httpStatus: 409, meta: { code: "FEEDBACK_VERSION_CONFLICT", actualVersion: 1 } });

    const updated = await service.putFeedback(
      USER, TASK, SHEET,
      putInput({ expectedVersion: 1, requestId: "00000000-0000-4000-8000-000000000905", feedback: feedbackFixture({ summary: "改判后的新评语" }) }),
      "agent-b",
    );
    expect(updated.version).toBe(2);
    expect(updated.lastEditor).toBe("agent-b");
    expect(repos.feedback?.request_id).toBe("00000000-0000-4000-8000-000000000905");
  });

  it("hash 不符 → 422；锚点不匹配/越界 → 422 FEEDBACK_ANCHOR_MISMATCH", async () => {
    const repos = new FakeFeedbackRepos();
    const service = makeService(repos);
    await expect(service.putFeedback(
      USER, TASK, SHEET, putInput({ textSha256: "0".repeat(64) }), "agent-a",
    )).rejects.toMatchObject({ httpStatus: 422, meta: { field: "textSha256" } });

    await expect(service.putFeedback(
      USER, TASK, SHEET,
      putInput({ feedback: feedbackFixture({ priorities: [{
        id: "p1", dimension: "language", observation: "x", action: "y",
        anchor: { start: 0, end: 3, quote: "第一段。" }, // 长度不符
      }] }) }),
      "agent-a",
    )).rejects.toMatchObject({ httpStatus: 422, meta: { code: "FEEDBACK_ANCHOR_MISMATCH" } });

    await expect(service.putFeedback(
      USER, TASK, SHEET,
      putInput({ feedback: feedbackFixture({ priorities: [{
        id: "p1", dimension: "language", observation: "x", action: "y",
        anchor: { start: 0, end: 9999, quote: "第一段。" }, // 越界
      }] }) }),
      "agent-a",
    )).rejects.toMatchObject({ httpStatus: 422, meta: { code: "FEEDBACK_ANCHOR_MISMATCH" } });
  });

  it("draft / cleared 写入被拒（409）；GET 与校验失败路径零写", async () => {
    const repos = new FakeFeedbackRepos();
    const service = makeService(repos);
    repos.sheet = sheetRow({ status: "draft" });
    await expect(service.putFeedback(USER, TASK, SHEET, putInput(), "agent-a"))
      .rejects.toMatchObject({ httpStatus: 409 });
    expect(repos.feedback).toBeNull();

    repos.sheet = sheetRow();
    repos.attempt = attemptRow({ status: "deleted", deleted_at: nowIso() });
    await expect(service.putFeedback(USER, TASK, SHEET, putInput(), "agent-a"))
      .rejects.toMatchObject({ httpStatus: 409, meta: { code: "WRITING_CONTENT_CLEARED" } });
    expect(repos.feedback).toBeNull();
  });

  it("validated feedback 总 JSON 超 64KiB → 422", async () => {
    const repos = new FakeFeedbackRepos();
    const service = makeService(repos);
    const bigText = "中".repeat(20_000); // 单份 quote=60KB；两条全幅锚点 ≈120KB > 64KiB
    repos.attempt = attemptRow({ answer: { text: bigText } });
    const bigAnchor = { start: 0, end: 20_000, quote: bigText };
    const bigFeedback = feedbackFixture({
      priorities: [
        { id: "p1", dimension: "language", observation: "x", action: "y", anchor: bigAnchor },
        { id: "p2", dimension: "organization", observation: "x", action: "y", anchor: bigAnchor },
      ],
    });
    await expect(service.putFeedback(USER, TASK, SHEET, {
      expectedVersion: 0,
      textSha256: sha256WritingText(bigText),
      requestId: REQUEST,
      feedback: bigFeedback,
    }, "agent-a")).rejects.toMatchObject({ httpStatus: 422, meta: { field: "feedback" } });
    expect(repos.feedback).toBeNull();
  });

  it("canonicalJson 键序无关（幂等比较不因序列化差异误判）", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe(canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }));
  });
});
