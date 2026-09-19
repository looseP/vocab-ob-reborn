/**
 * L3WritingSheetService 单测（W3，ADR《writing-workspace》§2/§3/§4）。
 * 内存 fake 注入（窄工厂 + 假 txRunner）：CAS 保存 / 提交幂等与物化 / 修改稿 /
 * 丢弃 / 详情与历史（GET 零写）。
 */
import { describe, expect, it } from "vitest";
import type { L3QuestionAttemptRow, L3SubmissionRow } from "@/domain";
import type { L3WritingTaskRow } from "@/repositories/l3-writing.types";
import type { IL3WritingRepository } from "@/repositories/l3-writing.repository";
import { L3WritingSheetService } from "@/services/l3-writing-sheet.service";
import { sha256WritingText } from "@/services/l3-writing-text";
import type { WritingRepos } from "@/services/l3-writing-task.service";

const USER = "00000000-0000-4000-8000-000000000001";
const TASK = "00000000-0000-4000-8000-000000000701";
const SHEET = "00000000-0000-4000-8000-000000000801";
const QUESTION = "00000000-0000-4000-8000-000000000101";
const PARENT = "00000000-0000-4000-8000-000000000802";
const OTHER_SHEET = "00000000-0000-4000-8000-000000000803";

function nowIso(): string {
  return new Date().toISOString();
}

function taskRow(overrides: Partial<L3WritingTaskRow> = {}): L3WritingTaskRow {
  return {
    id: TASK,
    user_id: USER,
    question_id: QUESTION,
    title: "任务",
    kind: "free",
    direction: "通用",
    status: "active",
    create_request_id: "00000000-0000-4000-8000-000000000901",
    create_input_hash: "hash",
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  };
}

function sheetRow(overrides: Partial<L3SubmissionRow> = {}): L3SubmissionRow {
  return {
    id: SHEET,
    user_id: USER,
    scope: "writing",
    scope_key: `writing:${TASK}`,
    source_id: null,
    question_type: null,
    paper_id: null,
    writing_task_id: TASK,
    parent_sheet_id: null,
    revision_no: null,
    draft_version: 0,
    status: "draft",
    answers: {},
    seal_mode: null,
    summary: null,
    sealed_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  };
}

function attemptRow(overrides: Partial<L3QuestionAttemptRow> = {}): L3QuestionAttemptRow {
  return {
    id: "00000000-0000-4000-8000-000000000951",
    user_id: USER,
    question_id: QUESTION,
    sheet_id: SHEET,
    venue: "writing",
    answer: { text: "正文" },
    self_assessment: null,
    status: "active",
    deleted_at: null,
    created_at: nowIso(),
    ...overrides,
  };
}

/** 内存 sheet 域 fake：只实现本服务路径所需方法（task 域方法抛错防误用）。 */
class FakeSheetRepos implements IL3WritingRepository {
  task: L3WritingTaskRow | null = taskRow();
  sheets = new Map<string, L3SubmissionRow>();
  attempt: L3QuestionAttemptRow | null = null;
  feedbackCount = new Map<string, number>();
  /** W9 清理用：反馈行（删除桩操作对象）。 */
  feedback: import("@/repositories/l3-writing.types").L3WritingFeedbackRow | null = null;
  touchCount = 0;
  insertAttemptCount = 0;

  constructor() {
    this.sheets.set(SHEET, sheetRow());
  }

  private nope(): never {
    throw new Error("not used in sheet tests");
  }
  async insertTask(): Promise<never> { return this.nope(); }
  async findTaskByRequestId(): Promise<never> { return this.nope(); }
  async findActiveTaskByQuestion(): Promise<never> { return this.nope(); }
  async lockQuestion(): Promise<never> { return this.nope(); }
  async updateTaskTitle(): Promise<never> { return this.nope(); }
  async setTaskStatus(): Promise<never> { return this.nope(); }
  async insertDraft(): Promise<never> { return this.nope(); }
  async countSealedByTask(): Promise<never> { return this.nope(); }
  async findLatestSealedByTask(): Promise<never> { return this.nope(); }
  async listTasks(): Promise<never> { return this.nope(); }
  async listQuestionTaskSummaries(): Promise<never> { return this.nope(); }

  async findTaskById(userId: string, taskId: string): Promise<L3WritingTaskRow | null> {
    return this.task && this.task.user_id === userId && this.task.id === taskId ? this.task : null;
  }
  async touchTask(): Promise<void> {
    this.touchCount += 1;
  }
  async lockTask(userId: string, taskId: string): Promise<L3WritingTaskRow | null> {
    return this.findTaskById(userId, taskId);
  }
  async lockSheet(userId: string, taskId: string, sheetId: string): Promise<L3SubmissionRow | null> {
    return this.findSheetById(userId, taskId, sheetId);
  }
  async findSheetById(userId: string, taskId: string, sheetId: string): Promise<L3SubmissionRow | null> {
    const s = this.sheets.get(sheetId);
    return s && s.user_id === userId && s.writing_task_id === taskId ? s : null;
  }
  async findSealedSheetById(userId: string, taskId: string, sheetId: string): Promise<L3SubmissionRow | null> {
    const s = await this.findSheetById(userId, taskId, sheetId);
    return s && s.status === "sealed" ? s : null;
  }
  async findDraftByTask(userId: string, taskId: string): Promise<L3SubmissionRow | null> {
    for (const s of this.sheets.values()) {
      if (s.user_id === userId && s.writing_task_id === taskId && s.status === "draft") return s;
    }
    return null;
  }
  async casSaveDraft(
    userId: string, taskId: string, sheetId: string, expectedVersion: number, answersJsonb: string,
  ): Promise<L3SubmissionRow | null> {
    const s = await this.findSheetById(userId, taskId, sheetId);
    if (!s || s.status !== "draft" || s.draft_version !== expectedVersion) return null;
    const next: L3SubmissionRow = {
      ...s,
      answers: JSON.parse(answersJsonb) as Record<string, never>,
      draft_version: s.draft_version + 1,
      updated_at: nowIso(),
    };
    this.sheets.set(sheetId, next);
    return next;
  }
  async findWritingAttempt(): Promise<L3QuestionAttemptRow | null> {
    return this.attempt;
  }
  async insertWritingAttempt(input: {
    user_id: string; question_id: string; sheet_id: string; answerJsonb: string;
  }): Promise<L3QuestionAttemptRow> {
    this.insertAttemptCount += 1;
    const row = attemptRow({
      id: `00000000-0000-4000-8000-00000000095${this.insertAttemptCount}`,
      question_id: input.question_id,
      sheet_id: input.sheet_id,
      answer: JSON.parse(input.answerJsonb) as Record<string, never>,
    });
    this.attempt = row;
    return row;
  }
  async createWritingDraft(input: {
    user_id: string; task_id: string; question_id: string;
    parent_sheet_id: string | null; answers: Record<string, unknown>;
  }): Promise<L3SubmissionRow> {
    const id = `00000000-0000-4000-8000-0000000009${this.sheets.size + 10}`;
    const row = sheetRow({
      id,
      parent_sheet_id: input.parent_sheet_id,
      answers: input.answers as Record<string, never>,
    });
    this.sheets.set(id, row);
    return row;
  }
  async sealWritingSheet(
    userId: string, taskId: string, sheetId: string, expectedVersion: number, revisionNo: number,
  ): Promise<L3SubmissionRow | null> {
    const s = await this.findSheetById(userId, taskId, sheetId);
    if (!s || s.status !== "draft" || s.draft_version !== expectedVersion) return null;
    const next: L3SubmissionRow = {
      ...s,
      status: "sealed",
      seal_mode: "full",
      sealed_at: nowIso(),
      revision_no: revisionNo,
      answers: {},
      draft_version: s.draft_version + 1,
      updated_at: nowIso(),
    };
    this.sheets.set(sheetId, next);
    return next;
  }
  async discardWritingDraft(
    userId: string, taskId: string, sheetId: string, expectedVersion: number,
  ): Promise<L3SubmissionRow | null> {
    const s = await this.findSheetById(userId, taskId, sheetId);
    if (!s || s.status !== "draft" || s.draft_version !== expectedVersion) return null;
    const next: L3SubmissionRow = { ...s, status: "discarded", answers: {}, updated_at: nowIso() };
    this.sheets.set(sheetId, next);
    return next;
  }
  async findMaxRevisionNo(userId: string, taskId: string): Promise<number> {
    let max = 0;
    for (const s of this.sheets.values()) {
      if (s.user_id === userId && s.writing_task_id === taskId && s.status === "sealed") {
        max = Math.max(max, s.revision_no ?? 0);
      }
    }
    return max;
  }
  // ── W9：正文清理（soft-delete attempt）+ 反馈删除桩 ────────────────────
  feedbackDeletedFor: string[] = [];
  opOrder: string[] = [];
  async softDeleteWritingAttempt(userId: string, sheetId: string): Promise<boolean> {
    const attempt = this.attempt;
    if (attempt && attempt.sheet_id === sheetId && attempt.user_id === userId && attempt.status === "active") {
      this.opOrder.push("softDeleteAttempt");
      this.attempt = { ...attempt, status: "deleted", deleted_at: nowIso() };
      return true;
    }
    return false;
  }
  l3Feedback = {
    deleteBySheet: async (_userId: string, sheetId: string) => {
      this.opOrder.push("deleteFeedback");
      const had = this.feedback != null && this.feedback.sheet_id === sheetId;
      if (had) this.feedback = null;
      this.feedbackDeletedFor.push(sheetId);
      return had;
    },
  };
  async listRevisions(
    userId: string, taskId: string,
    input: { limit: number; cursor: { updatedAt: string; id: string } | null },
  ): Promise<{ items: (L3SubmissionRow & { active_attempt_count: number; feedback_count: number })[]; total: number }> {
    let rows = [...this.sheets.values()].filter(
      (s) => s.user_id === userId && s.writing_task_id === taskId && (s.status === "sealed" || s.status === "discarded"),
    );
    rows.sort((a, b) => (a.updated_at !== b.updated_at ? (a.updated_at < b.updated_at ? 1 : -1) : a.id < b.id ? 1 : -1));
    if (input.cursor) {
      rows = rows.filter((s) => (s.updated_at !== input.cursor!.updatedAt
        ? s.updated_at < input.cursor!.updatedAt
        : s.id < input.cursor!.id));
    }
    const total = rows.length;
    const items = rows.slice(0, input.limit).map((s) => ({
      ...s,
      active_attempt_count: this.attempt && this.attempt.sheet_id === s.id && this.attempt.status === "active" ? 1 : 0,
      feedback_count: this.feedbackCount.get(s.id) ?? 0,
    }));
    return { items, total };
  }
}

function makeService(repos: FakeSheetRepos): L3WritingSheetService {
  const fakeTxRunner = (async (cb: (tx: undefined) => Promise<unknown>) => cb(undefined)) as never;
  return new L3WritingSheetService(
    (() => ({ l3Writing: repos, l3Feedback: repos.l3Feedback }) as unknown as WritingRepos) as never,
    fakeTxRunner,
  );
}

describe("W3 saveDraft（CAS + 归一）", () => {
  it("保存归一正文并返回归一 hash；版本 +1", async () => {
    const repos = new FakeSheetRepos();
    const service = makeService(repos);
    const result = await service.saveDraft(USER, TASK, SHEET, { expectedVersion: 0, text: "  A\r\nB\r" });
    expect(result.sheet.draftVersion).toBe(1);
    expect(result.textSha256).toBe(sha256WritingText("  A\nB\n"));
    const stored = repos.sheets.get(SHEET)!;
    expect((stored.answers[QUESTION] as { text: string }).text).toBe("  A\nB\n");
    expect(repos.touchCount).toBe(1);
  });

  it("旧版本保存被拒（409 DRAFT_VERSION_CONFLICT，不覆盖）", async () => {
    const repos = new FakeSheetRepos();
    const service = makeService(repos);
    await service.saveDraft(USER, TASK, SHEET, { expectedVersion: 0, text: "v1" });
    await expect(service.saveDraft(USER, TASK, SHEET, { expectedVersion: 0, text: "stale" }))
      .rejects.toMatchObject({ httpStatus: 409, meta: { code: "DRAFT_VERSION_CONFLICT" } });
    const stored = repos.sheets.get(SHEET)!;
    expect((stored.answers[QUESTION] as { text: string }).text).toBe("v1");
  });

  it("已提交稿不可保存（409）", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.set(SHEET, sheetRow({ status: "sealed", revision_no: 1, seal_mode: "full" }));
    const service = makeService(repos);
    await expect(service.saveDraft(USER, TASK, SHEET, { expectedVersion: 0, text: "x" }))
      .rejects.toMatchObject({ httpStatus: 409 });
  });

  it("已丢弃稿不可保存（409）", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.set(SHEET, sheetRow({ status: "discarded" }));
    const service = makeService(repos);
    await expect(service.saveDraft(USER, TASK, SHEET, { expectedVersion: 0, text: "x" }))
      .rejects.toMatchObject({ httpStatus: 409 });
  });
});

describe("W3 submit（单事务物化 + 幂等）", () => {
  it("空稿提交被拒（422）", async () => {
    const repos = new FakeSheetRepos();
    const service = makeService(repos);
    await expect(service.submit(USER, TASK, SHEET, { expectedVersion: 0 }))
      .rejects.toMatchObject({ httpStatus: 422 });
    expect(repos.insertAttemptCount).toBe(0);
  });

  it("版本不符提交被拒（409），不物化", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.set(SHEET, sheetRow({ answers: { [QUESTION]: { text: "正文" } }, draft_version: 2 }));
    const service = makeService(repos);
    await expect(service.submit(USER, TASK, SHEET, { expectedVersion: 1 }))
      .rejects.toMatchObject({ httpStatus: 409, meta: { code: "DRAFT_VERSION_CONFLICT" } });
    expect(repos.insertAttemptCount).toBe(0);
  });

  it("提交成功：物化 attempt、清空 answers、稿号 1、sealed", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.set(SHEET, sheetRow({ answers: { [QUESTION]: { text: "First\nDraft" } } }));
    const service = makeService(repos);
    const result = await service.submit(USER, TASK, SHEET, { expectedVersion: 0 });
    expect(result.sheet.status).toBe("sealed");
    expect(result.sheet.revisionNo).toBe(1);
    expect(result.attemptId).toBeTruthy();
    const stored = repos.sheets.get(SHEET)!;
    expect(stored.answers).toEqual({});
    expect(repos.insertAttemptCount).toBe(1);
    const attempt = repos.attempt!;
    expect((attempt.answer as { text: string }).text).toBe("First\nDraft");
  });

  it("重复提交幂等：同稿同 attemptId，不重复物化", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.set(SHEET, sheetRow({ answers: { [QUESTION]: { text: "正文" } } }));
    const service = makeService(repos);
    const first = await service.submit(USER, TASK, SHEET, { expectedVersion: 0 });
    const second = await service.submit(USER, TASK, SHEET, { expectedVersion: 0 });
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.sheet.revisionNo).toBe(1);
    expect(repos.insertAttemptCount).toBe(1);
  });

  it("稿号按 max+1 分配（跳过已存在的 3 号）", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.set(SHEET, sheetRow({ answers: { [QUESTION]: { text: "正文" } } }));
    repos.sheets.set(OTHER_SHEET, sheetRow({
      id: OTHER_SHEET, status: "sealed", revision_no: 3, seal_mode: "full", sealed_at: nowIso(),
    }));
    const service = makeService(repos);
    const result = await service.submit(USER, TASK, SHEET, { expectedVersion: 0 });
    expect(result.sheet.revisionNo).toBe(4);
  });

  it("已丢弃稿提交被拒（409）；归档任务提交被拒（409）", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.set(SHEET, sheetRow({ status: "discarded" }));
    const service = makeService(repos);
    await expect(service.submit(USER, TASK, SHEET, { expectedVersion: 0 }))
      .rejects.toMatchObject({ httpStatus: 409 });
    repos.task = taskRow({ status: "archived" });
    await expect(service.submit(USER, TASK, SHEET, { expectedVersion: 0 }))
      .rejects.toMatchObject({ httpStatus: 409 });
  });
});

describe("W3 createDraft（第二稿）", () => {
  /** 造一个 sealed 父稿（含 active attempt）。 */
  function withSealedParent(repos: FakeSheetRepos, text: string): void {
    repos.sheets.set(PARENT, sheetRow({
      id: PARENT, status: "sealed", revision_no: 1, seal_mode: "full",
      sealed_at: nowIso(), answers: {},
    }));
    repos.attempt = attemptRow({ sheet_id: PARENT, answer: { text } });
  }

  it("blank 起始：新建空稿（created=true）", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.delete(SHEET);
    const service = makeService(repos);
    const result = await service.createDraft(USER, TASK, { parentSheetId: null, seed: "blank" });
    expect(result.created).toBe(true);
    expect(result.sheet.parentSheetId).toBeNull();
    expect(result.sheet.status).toBe("draft");
  });

  it("copy：从父稿 active attempt 复制正文（新稿初始内容）", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.delete(SHEET);
    withSealedParent(repos, "父稿正文");
    const service = makeService(repos);
    const result = await service.createDraft(USER, TASK, { parentSheetId: PARENT, seed: "copy" });
    expect(result.created).toBe(true);
    const stored = repos.sheets.get(result.sheet.id)!;
    expect((stored.answers[QUESTION] as { text: string }).text).toBe("父稿正文");
    expect(stored.parent_sheet_id).toBe(PARENT);
  });

  it("已有相同 parent 的 draft：复用不覆盖（created=false）", async () => {
    const repos = new FakeSheetRepos();
    withSealedParent(repos, "父稿正文");
    repos.sheets.set(SHEET, sheetRow({ parent_sheet_id: PARENT, answers: { [QUESTION]: { text: "用户已改到一半" } } }));
    const service = makeService(repos);
    const result = await service.createDraft(USER, TASK, { parentSheetId: PARENT, seed: "copy" });
    expect(result.created).toBe(false);
    expect(result.sheet.id).toBe(SHEET);
    const stored = repos.sheets.get(SHEET)!;
    expect((stored.answers[QUESTION] as { text: string }).text).toBe("用户已改到一半");
  });

  it("已有不同 parent 的 draft：409 ACTIVE_DRAFT_EXISTS", async () => {
    const repos = new FakeSheetRepos();
    withSealedParent(repos, "父稿正文");
    repos.sheets.set(SHEET, sheetRow({ parent_sheet_id: OTHER_SHEET, answers: {} }));
    const service = makeService(repos);
    await expect(service.createDraft(USER, TASK, { parentSheetId: PARENT, seed: "copy" }))
      .rejects.toMatchObject({ httpStatus: 409, meta: { code: "ACTIVE_DRAFT_EXISTS" } });
  });

  it("parent 非 sealed → 404；parent 正文已清理 → 409", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.delete(SHEET);
    const service = makeService(repos);
    await expect(service.createDraft(USER, TASK, { parentSheetId: PARENT, seed: "copy" }))
      .rejects.toMatchObject({ httpStatus: 404 });
    withSealedParent(repos, "父稿正文");
    repos.attempt = attemptRow({ sheet_id: PARENT, status: "deleted", deleted_at: nowIso() });
    await expect(service.createDraft(USER, TASK, { parentSheetId: PARENT, seed: "copy" }))
      .rejects.toMatchObject({ httpStatus: 409 });
  });
});

describe("W3 discard", () => {
  it("成功：清空 answers、discarded、不占稿号", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.set(SHEET, sheetRow({ answers: { [QUESTION]: { text: "正文" } } }));
    const service = makeService(repos);
    const sheet = await service.discard(USER, TASK, SHEET, { expectedVersion: 0 });
    expect(sheet.status).toBe("discarded");
    expect(sheet.revisionNo).toBeNull();
    expect(repos.sheets.get(SHEET)!.answers).toEqual({});
  });

  it("sealed 稿丢弃被拒（409）；版本不符被拒（409）", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.set(SHEET, sheetRow({ status: "sealed", revision_no: 1, seal_mode: "full" }));
    const service = makeService(repos);
    await expect(service.discard(USER, TASK, SHEET, { expectedVersion: 0 }))
      .rejects.toMatchObject({ httpStatus: 409 });
    repos.sheets.set(SHEET, sheetRow({ draft_version: 2 }));
    await expect(service.discard(USER, TASK, SHEET, { expectedVersion: 0 }))
      .rejects.toMatchObject({ httpStatus: 409, meta: { code: "DRAFT_VERSION_CONFLICT" } });
  });
});

describe("W3 getSheet / listRevisions（GET 零写）", () => {
  it("draft：返回 answers 正文与 hash", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.set(SHEET, sheetRow({ answers: { [QUESTION]: { text: "草稿正文" } } }));
    const service = makeService(repos);
    const detail = await service.getSheet(USER, TASK, SHEET);
    expect(detail.text).toBe("草稿正文");
    expect(detail.textSha256).toBe(sha256WritingText("草稿正文"));
    expect(detail.contentStatus).toBe("available");
    expect(detail.feedback).toBeNull();
  });

  it("sealed：从 active attempt 取正文；attempt 软删 → cleared 占位（不 404）", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.set(SHEET, sheetRow({ status: "sealed", revision_no: 1, seal_mode: "full" }));
    repos.attempt = attemptRow({ answer: { text: "提交正文" } });
    const service = makeService(repos);
    const detail = await service.getSheet(USER, TASK, SHEET);
    expect(detail.text).toBe("提交正文");
    expect(detail.contentStatus).toBe("available");

    repos.attempt = attemptRow({ status: "deleted", deleted_at: nowIso() });
    const cleared = await service.getSheet(USER, TASK, SHEET);
    expect(cleared.text).toBeNull();
    expect(cleared.textSha256).toBeNull();
    expect(cleared.wordCount).toBe(0);
    expect(cleared.contentStatus).toBe("cleared");
  });

  it("discarded：cleared；不存在 → 404；GET 全程零写", async () => {
    const repos = new FakeSheetRepos();
    repos.sheets.set(SHEET, sheetRow({ status: "discarded", answers: {} }));
    const service = makeService(repos);
    const detail = await service.getSheet(USER, TASK, SHEET);
    expect(detail.contentStatus).toBe("cleared");
    expect(detail.sheet.revisionNo).toBeNull();
    await expect(service.getSheet(USER, TASK, OTHER_SHEET)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(service.getSheet(USER, TASK, SHEET)).resolves.toBeTruthy();
    expect(repos.touchCount).toBe(0);
    expect(repos.insertAttemptCount).toBe(0);
  });

  it("listRevisions：feedbackState 派生（ready/pending/unavailable）+ 分页", async () => {
    const repos = new FakeSheetRepos();
    const sealedId = "00000000-0000-4000-8000-000000000921";
    const discardedId = "00000000-0000-4000-8000-000000000922";
    repos.sheets.set(sealedId, sheetRow({
      id: sealedId, status: "sealed", revision_no: 1, seal_mode: "full",
      sealed_at: "2026-09-18T01:00:00.000Z", updated_at: "2026-09-18T01:00:00.000Z", answers: {},
    }));
    repos.sheets.set(discardedId, sheetRow({
      id: discardedId, status: "discarded", updated_at: "2026-09-18T00:00:00.000Z", answers: {},
    }));
    repos.attempt = attemptRow({ sheet_id: sealedId, answer: { text: "正文" } });
    repos.feedbackCount.set(sealedId, 1);
    const service = makeService(repos);
    const page = await service.listRevisions(USER, TASK, { limit: 20 });
    expect(page.total).toBe(2);
    const sealedSummary = page.items.find((i) => i.sheet.id === sealedId)!;
    expect(sealedSummary.feedbackState).toBe("ready");
    expect(sealedSummary.contentStatus).toBe("available");
    const discardedSummary = page.items.find((i) => i.sheet.id === discardedId)!;
    expect(discardedSummary.feedbackState).toBe("unavailable");
    expect(discardedSummary.contentStatus).toBe("cleared");
    expect(page.nextCursor).toBeNull();
  });
});

describe("W9 clearRevisionContent（正文清理：attempt 软删 + 反馈同事务删除）", () => {
  function sealedWithContent(repos: FakeSheetRepos): void {
    repos.sheets.set(SHEET, sheetRow({
      status: "sealed", revision_no: 1, seal_mode: "full", sealed_at: nowIso(),
    }));
    repos.attempt = attemptRow({ sheet_id: SHEET, answer: { text: "正文" } });
    repos.feedback = {
      id: "00000000-0000-4000-8000-000000000921",
      user_id: USER,
      sheet_id: SHEET,
      text_sha256: "a".repeat(64),
      schema_version: 1,
      feedback: { schemaVersion: 1 },
      version: 1,
      request_id: "00000000-0000-4000-8000-000000000902",
      last_editor: "agent-a",
      created_at: nowIso(),
      updated_at: nowIso(),
    };
  }

  it("sealed：soft-delete attempt → 删反馈（顺序），幂等可重入", async () => {
    const repos = new FakeSheetRepos();
    sealedWithContent(repos);
    const service = makeService(repos);
    const sheet = await service.clearRevisionContent(USER, TASK, SHEET);
    expect(sheet.status).toBe("sealed"); // 稿行保持 sealed（内容清理不是状态迁移）
    expect(repos.attempt!.status).toBe("deleted");
    expect(repos.feedback).toBeNull();
    expect(repos.opOrder).toEqual(["softDeleteAttempt", "deleteFeedback"]);
    expect(repos.touchCount).toBe(1);

    // 幂等重入：不报错；反馈仍为空（每次都确保删除）。
    await service.clearRevisionContent(USER, TASK, SHEET);
    expect(repos.feedback).toBeNull();
    expect(repos.feedbackDeletedFor).toEqual([SHEET, SHEET]);
  });

  it("draft / discarded → 409；不存在 → 404（零写）", async () => {
    const repos = new FakeSheetRepos();
    const service = makeService(repos);
    repos.sheets.set(SHEET, sheetRow({ status: "draft" }));
    await expect(service.clearRevisionContent(USER, TASK, SHEET)).rejects.toMatchObject({ httpStatus: 409 });
    repos.sheets.set(SHEET, sheetRow({ status: "discarded", revision_no: null }));
    await expect(service.clearRevisionContent(USER, TASK, SHEET)).rejects.toMatchObject({ httpStatus: 409 });
    repos.sheets.delete(SHEET);
    await expect(service.clearRevisionContent(USER, TASK, SHEET)).rejects.toMatchObject({ httpStatus: 404 });
    expect(repos.feedbackDeletedFor).toEqual([]);
    expect(repos.touchCount).toBe(0);
  });
});
