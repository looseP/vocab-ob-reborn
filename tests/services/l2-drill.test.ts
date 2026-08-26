/**
 * L2DrillService 单元测试 —— 聚焦 M5 / M6 幂等修复的回归覆盖。
 *
 * 不触达 L2ReviewService.answerWithinTx：M5/M6 的回归路径在 idempotency 命中
 * 或产出步已结算时即返回，不进入 FSRS 写入。所以无需 mock fsrsAdapter 的
 * 真实返回，只需保证 L2DrillService 构造可行（fsrsAdapter 是 no-op）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
}));

const mockRepos = {
  reviews: {
    checkIdempotency: vi.fn(),
    // FR-12 接线1：submitTaskAnswer 正常路径触达 markL1WeakSignal 校验（worker 内）
    // 此处仅供 L2ReviewService.answerWithinTx 调用面兼容，service 层不会直接调用
    markL1WeakSignal: vi.fn(),
    findProgressForOutbox: vi.fn(),
  },
  l2Progress: {
    findDrillStepForUpdate: vi.fn(),
    findDrillStepBySessionWordStep: vi.fn(),
    findForUpdate: vi.fn(),
    insertDrillStepIfAbsent: vi.fn(),
    completeDrillStep: vi.fn(),
    skipDrillStep: vi.fn(),
    updateProductionStatus: vi.fn(),
    deleteDrillStep: vi.fn(),
    findLastDrillStep: vi.fn(),
    // M7 修复所需的撤销方法
    findReviewLogForL2Undo: vi.fn(),
    applyL2UndoSnapshot: vi.fn(),
    markL2ReviewLogUndone: vi.fn(),
    insertL2UndoAuditLog: vi.fn(),
    // M8 修复所需的产出步恢复方法
    findPendingProductionStepsForResume: vi.fn(),
    findDueCards: vi.fn(),
    // FR-12 接线1：saveL2Answer 是 L2ReviewService.answerWithinTx 的核心持久化方法
    saveL2Answer: vi.fn(),
    findByWordbookWordAndUser: vi.fn(),
  },
  sessions: {
    getOrCreateToday: vi.fn(),
    assertActiveOwned: vi.fn(),
  },
  // FR-12 接线1：submitTaskAnswer 正常路径会调用 outbox.enqueue 入队 track='l2' 事件
  outbox: {
    enqueue: vi.fn(),
  },
};

vi.mock("@/repositories/factory", () => ({
  createRepositories: vi.fn(() => mockRepos),
}));

import { L2DrillService } from "@/services/l2-drill.service";
import type { ContextSnippet } from "@/domain/context-source";

const SESSION_ID = "sess-11111111-1111-4111-8111-111111111111";
const STEP_ID = "step-22222222-2222-4222-8222-222222222222";
const PROGRESS_ID = "prog-33333333-3333-4333-8333-333333333333";
const WORD_ID = "word-44444444-4444-4444-8444-444444444444";
const USER_ID = "user-55555555-5555-4555-8555-555555555555";
const WORDBOOK_ID = "wb-66666666-6666-4666-8666-666666666666";

function makeService() {
  return new L2DrillService({
    // FR-12 接线1：正常路径会调用 fsrsAdapter，需返回有效 scheduling 对象。
    // M5/M6/M7/M8 幂等路径不进入 answerWithinTx，fsrsAdapter 不会被调用。
    fsrsAdapter: vi.fn(() => ({
      difficulty: 5.0,
      dueAt: "2026-09-25T00:00:00.000Z",
      logDueAt: null,
      elapsedDays: 1,
      scheduledDays: 10,
      retrievability: 0.85,
      stability: 3.5,
      state: "review" as const,
      nextPayload: {
        due: "2026-09-25T00:00:00.000Z",
        stability: 3.5,
        difficulty: 5.0,
        state: 2,
        elapsed_days: 1,
        scheduled_days: 10,
        reps: 1,
        lapses: 0,
        learning_steps: 0,
        last_review: "2026-08-25T00:00:00.000Z",
      },
    })),
    loadWeights: vi.fn().mockResolvedValue(null),
    loadL2Weights: vi.fn().mockResolvedValue(null),
  });
}

function reset() {
  mockRepos.reviews.checkIdempotency.mockReset();
  mockRepos.reviews.markL1WeakSignal.mockReset();
  mockRepos.reviews.findProgressForOutbox.mockReset();
  mockRepos.l2Progress.findDrillStepForUpdate.mockReset();
  mockRepos.l2Progress.findDrillStepBySessionWordStep.mockReset();
  mockRepos.l2Progress.findForUpdate.mockReset();
  mockRepos.l2Progress.insertDrillStepIfAbsent.mockReset();
  mockRepos.l2Progress.completeDrillStep.mockReset();
  mockRepos.l2Progress.updateProductionStatus.mockReset();
  // M7/M8 mock 也需重置，避免跨用例污染
  mockRepos.l2Progress.deleteDrillStep.mockReset();
  mockRepos.l2Progress.findLastDrillStep.mockReset();
  mockRepos.l2Progress.findReviewLogForL2Undo.mockReset();
  mockRepos.l2Progress.applyL2UndoSnapshot.mockReset();
  mockRepos.l2Progress.markL2ReviewLogUndone.mockReset();
  mockRepos.l2Progress.insertL2UndoAuditLog.mockReset();
  mockRepos.l2Progress.findPendingProductionStepsForResume.mockReset();
  mockRepos.l2Progress.findDueCards.mockReset();
  // FR-12 接线1：重置 saveL2Answer / findByWordbookWordAndUser / outbox
  mockRepos.l2Progress.saveL2Answer.mockReset();
  mockRepos.l2Progress.findByWordbookWordAndUser.mockReset();
  mockRepos.sessions.getOrCreateToday.mockReset();
  mockRepos.sessions.assertActiveOwned.mockReset();
  mockRepos.outbox.enqueue.mockReset();
}

beforeEach(reset);

// ─── M5：submitTaskAnswer 幂等重放需返回产出步入口 ─────────────────────────

describe("submitTaskAnswer idempotent replay (M5 regression)", () => {
  it("returns production step entry when discrimination outcome=correct", async () => {
    const svc = makeService();
    // 1) 幂等命中既有 review_logs 行
    mockRepos.reviews.checkIdempotency.mockResolvedValue("log-existing");
    // 2) 重读辨析步：outcome='correct'，word_id 用于查找产出步
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      word_id: WORD_ID,
      progress_id: PROGRESS_ID,
      step_index: 0,
      step_type: "l2_discrimination",
      status: "completed",
      outcome: "correct",
      task_payload: { taskId: "t1", taskType: "cloze_mcq", prompt: "____", stepIndex: 0 },
    });
    // 3) 产出步（step_index=1）存在且 pending
    mockRepos.l2Progress.findDrillStepBySessionWordStep.mockResolvedValue({
      id: "prod-step-1",
      session_id: SESSION_ID,
      user_id: USER_ID,
      word_id: WORD_ID,
      step_index: 1,
      step_type: "l2_production",
      status: "pending",
      task_payload: {
        taskId: "production:abc",
        taskType: "production",
        prompt: "用 sustain 造句",
        stepIndex: 1,
      },
    });

    const result = await svc.submitTaskAnswer(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0, idempotencyKey: "idem-1" },
      USER_ID,
    );

    // 必须返回 production 入口（而不是 done）
    expect(result).toMatchObject({
      ok: true,
      idempotent: true,
      nextStep: { type: "production" },
    });
    if (result.nextStep.type === "production") {
      expect(result.nextStep.step.stepId).toBe("prod-step-1");
      // answerIndex 必须剥离（spec §五 红线 D8）
      expect("answerIndex" in result.nextStep.step.task).toBe(false);
      // stepIndex 必须保留（H4 回归）
      expect(result.nextStep.step.task.stepIndex).toBe(1);
    }
    // 验证幂等查询参数
    expect(mockRepos.reviews.checkIdempotency).toHaveBeenCalledWith(USER_ID, "idem-1");
    // 验证产出步查询参数（session, user, word, step_index=1）
    expect(mockRepos.l2Progress.findDrillStepBySessionWordStep).toHaveBeenCalledWith(
      SESSION_ID,
      USER_ID,
      WORD_ID,
      1,
    );
  });

  it("returns done when discrimination outcome=incorrect (no production step created)", async () => {
    const svc = makeService();
    mockRepos.reviews.checkIdempotency.mockResolvedValue("log-existing");
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      word_id: WORD_ID,
      step_index: 0,
      step_type: "l2_discrimination",
      status: "completed",
      outcome: "incorrect",
    });
    // 产出步不应被查询（outcome != correct）
    mockRepos.l2Progress.findDrillStepBySessionWordStep.mockResolvedValue(null);

    const result = await svc.submitTaskAnswer(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 1, idempotencyKey: "idem-2" },
      USER_ID,
    );

    expect(result).toEqual({
      ok: true,
      idempotent: true,
      nextStep: { type: "done" },
    });
    expect(mockRepos.l2Progress.findDrillStepBySessionWordStep).not.toHaveBeenCalled();
  });

  it("returns done when discrimination outcome=correct but production step missing/settled", async () => {
    const svc = makeService();
    mockRepos.reviews.checkIdempotency.mockResolvedValue("log-existing");
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      word_id: WORD_ID,
      step_index: 0,
      step_type: "l2_discrimination",
      status: "completed",
      outcome: "correct",
    });
    // 产出步已 completed（用户已自评过）→ 不再返回入口
    mockRepos.l2Progress.findDrillStepBySessionWordStep.mockResolvedValue({
      id: "prod-step-1",
      step_index: 1,
      step_type: "l2_production",
      status: "completed",
      outcome: "self_passed",
    });

    const result = await svc.submitTaskAnswer(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0, idempotencyKey: "idem-3" },
      USER_ID,
    );

    expect(result).toEqual({
      ok: true,
      idempotent: true,
      nextStep: { type: "done" },
    });
  });

  it("returns done when discrimination step not found (defensive)", async () => {
    const svc = makeService();
    mockRepos.reviews.checkIdempotency.mockResolvedValue("log-existing");
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue(null);

    const result = await svc.submitTaskAnswer(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0, idempotencyKey: "idem-4" },
      USER_ID,
    );

    expect(result).toEqual({
      ok: true,
      idempotent: true,
      nextStep: { type: "done" },
    });
    expect(mockRepos.l2Progress.findDrillStepBySessionWordStep).not.toHaveBeenCalled();
  });
});

// ─── M6：submitSelfAssessment 幂等契约对齐 ─────────────────────────────────

describe("submitSelfAssessment idempotency (M6 regression)", () => {
  it("accepts idempotencyKey in service signature and forwards to checkIdempotency", async () => {
    const svc = makeService();
    // 幂等命中
    mockRepos.reviews.checkIdempotency.mockResolvedValue("log-existing");
    // 不应触达产出步查询或更新

    const result = await svc.submitSelfAssessment(
      { sessionId: SESSION_ID, stepId: STEP_ID, verdict: "passed", idempotencyKey: "idem-self-1" },
      USER_ID,
    );

    expect(result).toEqual({ ok: true, productionStatus: "passed" });
    expect(mockRepos.reviews.checkIdempotency).toHaveBeenCalledWith(USER_ID, "idem-self-1");
    // 幂等命中后不应再触达 step 查询或更新
    expect(mockRepos.l2Progress.findDrillStepForUpdate).not.toHaveBeenCalled();
    expect(mockRepos.l2Progress.updateProductionStatus).not.toHaveBeenCalled();
    expect(mockRepos.l2Progress.completeDrillStep).not.toHaveBeenCalled();
  });

  it("returns inferred verdict when step already completed with self_passed", async () => {
    const svc = makeService();
    // 无 idempotencyKey —— 模拟前端失忆重入或网络重试
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      wordbook_id: WORDBOOK_ID,
      word_id: WORD_ID,
      step_index: 1,
      step_type: "l2_production",
      status: "completed",
      outcome: "self_passed",
    });

    // 哪怕用户这次提交 "weak"，防御式幂等返回原 outcome 推出的 verdict
    const result = await svc.submitSelfAssessment(
      { sessionId: SESSION_ID, stepId: STEP_ID, verdict: "weak" },
      USER_ID,
    );

    expect(result).toEqual({ ok: true, productionStatus: "passed" });
    expect(mockRepos.l2Progress.updateProductionStatus).not.toHaveBeenCalled();
    expect(mockRepos.l2Progress.completeDrillStep).not.toHaveBeenCalled();
  });

  it("returns inferred verdict when step already completed with self_weak", async () => {
    const svc = makeService();
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      wordbook_id: WORDBOOK_ID,
      word_id: WORD_ID,
      step_index: 1,
      step_type: "l2_production",
      status: "completed",
      outcome: "self_weak",
    });

    const result = await svc.submitSelfAssessment(
      { sessionId: SESSION_ID, stepId: STEP_ID, verdict: "passed" },
      USER_ID,
    );

    expect(result).toEqual({ ok: true, productionStatus: "weak" });
    expect(mockRepos.l2Progress.updateProductionStatus).not.toHaveBeenCalled();
  });

  it("proceeds normally when step is pending and no idempotencyKey", async () => {
    const svc = makeService();
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      wordbook_id: WORDBOOK_ID,
      word_id: WORD_ID,
      step_index: 1,
      step_type: "l2_production",
      status: "pending",
      outcome: null,
    });
    mockRepos.l2Progress.updateProductionStatus.mockResolvedValue(undefined);
    mockRepos.l2Progress.completeDrillStep.mockResolvedValue(undefined);

    const result = await svc.submitSelfAssessment(
      { sessionId: SESSION_ID, stepId: STEP_ID, verdict: "passed" },
      USER_ID,
    );

    expect(result).toEqual({ ok: true, productionStatus: "passed" });
    expect(mockRepos.l2Progress.updateProductionStatus).toHaveBeenCalledWith(
      USER_ID,
      WORDBOOK_ID,
      WORD_ID,
      "passed",
    );
    expect(mockRepos.l2Progress.completeDrillStep).toHaveBeenCalledWith(STEP_ID, USER_ID, {
      outcome: "self_passed",
    });
  });
});

// ─── M7：undo 幂等 + 辨析步撤销 ─────────────────────────────────────────

describe("undo (M7 regression)", () => {
  it("returns idempotent:true when idempotencyKey hits existing audit log", async () => {
    const svc = makeService();
    mockRepos.reviews.checkIdempotency.mockResolvedValue("log-existing");

    const result = await svc.undo(SESSION_ID, USER_ID, "idem-undo-1");

    expect(result).toEqual({ ok: true, idempotent: true });
    // 不应触达 drill step 查询/删除
    expect(mockRepos.l2Progress.findLastDrillStep).not.toHaveBeenCalled();
    expect(mockRepos.l2Progress.deleteDrillStep).not.toHaveBeenCalled();
  });

  it("throws when nothing to undo", async () => {
    const svc = makeService();
    mockRepos.l2Progress.findLastDrillStep.mockResolvedValue(null);
    await expect(svc.undo(SESSION_ID, USER_ID)).rejects.toThrow(/Nothing to undo/);
  });

  it("deletes pending step directly (no audit, no FSRS rollback)", async () => {
    const svc = makeService();
    mockRepos.l2Progress.findLastDrillStep.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      wordbook_id: WORDBOOK_ID,
      word_id: WORD_ID,
      progress_id: PROGRESS_ID,
      step_index: 0,
      step_type: "l2_discrimination",
      status: "pending",
      outcome: null,
      review_log_id: null,
    });
    mockRepos.l2Progress.deleteDrillStep.mockResolvedValue(undefined);

    const result = await svc.undo(SESSION_ID, USER_ID);
    expect(result).toEqual({ ok: true });
    expect(mockRepos.l2Progress.deleteDrillStep).toHaveBeenCalledWith(STEP_ID, USER_ID);
    // 不应触达快照回写 / 审计日志
    expect(mockRepos.l2Progress.applyL2UndoSnapshot).not.toHaveBeenCalled();
    expect(mockRepos.l2Progress.insertL2UndoAuditLog).not.toHaveBeenCalled();
  });

  it("undoes completed production step (clears status + deletes step)", async () => {
    const svc = makeService();
    mockRepos.l2Progress.findLastDrillStep.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      wordbook_id: WORDBOOK_ID,
      word_id: WORD_ID,
      progress_id: PROGRESS_ID,
      step_index: 1,
      step_type: "l2_production",
      status: "completed",
      outcome: "self_passed",
      review_log_id: null,
    });
    mockRepos.l2Progress.updateProductionStatus.mockResolvedValue(undefined);
    mockRepos.l2Progress.deleteDrillStep.mockResolvedValue(undefined);
    // 兄弟步查找（产出步 step_index=1，siblingIndex=0 → 早返回，不查 DB）
    mockRepos.l2Progress.findDrillStepBySessionWordStep.mockResolvedValue(null);
    mockRepos.l2Progress.insertL2UndoAuditLog.mockResolvedValue(undefined);

    const result = await svc.undo(SESSION_ID, USER_ID, "idem-prod-1");
    expect(result).toEqual({ ok: true });
    expect(mockRepos.l2Progress.updateProductionStatus).toHaveBeenCalledWith(
      USER_ID,
      WORDBOOK_ID,
      WORD_ID,
      null,
    );
    expect(mockRepos.l2Progress.deleteDrillStep).toHaveBeenCalledWith(STEP_ID, USER_ID);
    // 审计行应被插入（含 idempotencyKey）
    expect(mockRepos.l2Progress.insertL2UndoAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        wordId: WORD_ID,
        wordbookId: WORDBOOK_ID,
        progressId: PROGRESS_ID,
        sessionId: SESSION_ID,
        reviewLogId: "",
        restoredState: "l2_production_undo",
        idempotencyKey: "idem-prod-1",
      }),
    );
  });

  it("undoes completed discrimination step (snapshot rollback + audit)", async () => {
    const svc = makeService();
    const REVIEW_LOG_ID = "log-77777777-7777-4777-8777-777777777777";
    mockRepos.l2Progress.findLastDrillStep.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      wordbook_id: WORDBOOK_ID,
      word_id: WORD_ID,
      progress_id: PROGRESS_ID,
      step_index: 0,
      step_type: "l2_discrimination",
      status: "completed",
      outcome: "correct",
      review_log_id: REVIEW_LOG_ID,
    });
    mockRepos.l2Progress.findReviewLogForL2Undo.mockResolvedValue({
      wordId: WORD_ID,
      wordbookId: WORDBOOK_ID,
      undone: false,
      previousSnapshot: {
        l2_stability: 3.5,
        l2_difficulty: 5.0,
        l2_state: "review",
        l2_due_at: "2026-01-01T00:00:00Z",
        recent_ratings: ["good", "again"],
      },
    });
    mockRepos.l2Progress.applyL2UndoSnapshot.mockResolvedValue(1);
    mockRepos.l2Progress.markL2ReviewLogUndone.mockResolvedValue(1);
    mockRepos.l2Progress.deleteDrillStep.mockResolvedValue(undefined);
    // 兄弟步（step_index=1，pending）应被查找并删除
    const siblingStep = {
      id: "sib-1",
      status: "pending",
    };
    mockRepos.l2Progress.findDrillStepBySessionWordStep.mockResolvedValue(siblingStep);
    mockRepos.l2Progress.insertL2UndoAuditLog.mockResolvedValue(undefined);

    const result = await svc.undo(SESSION_ID, USER_ID, "idem-disc-1");
    expect(result).toEqual({ ok: true });
    // 1) 快照回写
    expect(mockRepos.l2Progress.applyL2UndoSnapshot).toHaveBeenCalledWith(
      PROGRESS_ID,
      USER_ID,
      expect.objectContaining({
        l2_state: "review",
        l2_stability: 3.5,
      }),
    );
    // 2) 标 review_log undone
    expect(mockRepos.l2Progress.markL2ReviewLogUndone).toHaveBeenCalledWith(REVIEW_LOG_ID, USER_ID);
    // 3) 删辨析 drill step
    expect(mockRepos.l2Progress.deleteDrillStep).toHaveBeenCalledWith(STEP_ID, USER_ID);
    // 4) 删 pending 产出步
    expect(mockRepos.l2Progress.deleteDrillStep).toHaveBeenCalledWith("sib-1", USER_ID);
    // 5) 插幂等审计行
    expect(mockRepos.l2Progress.insertL2UndoAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        wordId: WORD_ID,
        wordbookId: WORDBOOK_ID,
        progressId: PROGRESS_ID,
        sessionId: SESSION_ID,
        reviewLogId: REVIEW_LOG_ID,
        restoredState: "review",
        idempotencyKey: "idem-disc-1",
      }),
    );
  });

  it("throws when discrimination step missing review_log_id", async () => {
    const svc = makeService();
    mockRepos.l2Progress.findLastDrillStep.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      wordbook_id: WORDBOOK_ID,
      word_id: WORD_ID,
      progress_id: PROGRESS_ID,
      step_index: 0,
      step_type: "l2_discrimination",
      status: "completed",
      outcome: "incorrect",
      review_log_id: null,
    });
    await expect(svc.undo(SESSION_ID, USER_ID)).rejects.toThrow(/missing the L2 review log id/);
  });

  it("throws when L2 progress row vanished (snapshot rollback affected 0 rows)", async () => {
    const svc = makeService();
    const REVIEW_LOG_ID = "log-77777777-7777-4777-8777-777777777777";
    mockRepos.l2Progress.findLastDrillStep.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      wordbook_id: WORDBOOK_ID,
      word_id: WORD_ID,
      progress_id: PROGRESS_ID,
      step_index: 0,
      step_type: "l2_discrimination",
      status: "completed",
      outcome: "incorrect",
      review_log_id: REVIEW_LOG_ID,
    });
    mockRepos.l2Progress.findReviewLogForL2Undo.mockResolvedValue({
      wordId: WORD_ID,
      wordbookId: WORDBOOK_ID,
      undone: false,
      previousSnapshot: { l2_state: "review" },
    });
    mockRepos.l2Progress.applyL2UndoSnapshot.mockResolvedValue(0); // 进度行没了
    await expect(svc.undo(SESSION_ID, USER_ID)).rejects.toThrow(/progress row vanished/);
  });

  it("returns idempotent:true when review log already undone (defensive)", async () => {
    const svc = makeService();
    const REVIEW_LOG_ID = "log-77777777-7777-4777-8777-777777777777";
    mockRepos.l2Progress.findLastDrillStep.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      wordbook_id: WORDBOOK_ID,
      word_id: WORD_ID,
      progress_id: PROGRESS_ID,
      step_index: 0,
      step_type: "l2_discrimination",
      status: "completed",
      outcome: "correct",
      review_log_id: REVIEW_LOG_ID,
    });
    mockRepos.l2Progress.findReviewLogForL2Undo.mockResolvedValue({
      wordId: WORD_ID,
      wordbookId: WORDBOOK_ID,
      undone: true, // 已撤销
      previousSnapshot: {},
    });
    const result = await svc.undo(SESSION_ID, USER_ID);
    expect(result).toEqual({ ok: true, idempotent: true });
    // 不应触达快照回写
    expect(mockRepos.l2Progress.applyL2UndoSnapshot).not.toHaveBeenCalled();
  });
});

// ─── M8：getQueue 恢复 pending 产出步 ───────────────────────────────────

describe("getQueue pending production resume (M8 regression)", () => {
  it("surfaces pending production steps from the current session", async () => {
    const svc = makeService();
    const session = { id: SESSION_ID, mode: "l2_drill" };
    mockRepos.sessions.getOrCreateToday.mockResolvedValue(session);
    // 没有到期 L2 卡，但有 1 个 pending 产出步
    mockRepos.l2Progress.findDueCards.mockResolvedValue([]);
    const PROD_STEP_ID = "prod-88888888-8888-4888-8888-888888888888";
    mockRepos.l2Progress.findPendingProductionStepsForResume.mockResolvedValue([
      {
        step: {
          id: PROD_STEP_ID,
          session_id: SESSION_ID,
          user_id: USER_ID,
          wordbook_id: WORDBOOK_ID,
          word_id: WORD_ID,
          progress_id: PROGRESS_ID,
          step_index: 1,
          step_type: "l2_production",
          status: "pending",
          task_payload: {
            taskId: "production:abc",
            taskType: "production",
            prompt: "用 sustain 造句",
            stepIndex: 1,
            hintTranslation: "维持",
          },
        },
        progress: {
          id: PROGRESS_ID,
          l2_due_at: "2026-12-01T00:00:00Z",
          l2_review_count: 3,
          l2_paused: false,
        },
        word: {
          id: WORD_ID,
          slug: "sustain",
          title: "sustain",
          lemma: "sustain",
          pos: "verb",
          ipa: "/səˈsteɪn/",
          cefr: "B2",
          short_definition: "维持",
          corpus_items: [],
          synonym_items: [],
          antonym_items: [],
        },
      },
    ]);

    const result = await svc.getQueue(USER_ID, WORDBOOK_ID);

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.stepId).toBe(PROD_STEP_ID);
    expect(item.word.lemma).toBe("sustain");
    expect(item.singleStep).toBe(true);
    expect(item.l2ReviewCount).toBe(3);
    // H4 回归：stepIndex 必须保留
    expect(item.task.stepIndex).toBe(1);
    // D8 红线：answerIndex 不应出现（产出步本来就没有，但 stripAnswer 也不应注入）
    expect("answerIndex" in item.task).toBe(false);
  });

  it("skips paused cards when surfacing pending production steps", async () => {
    const svc = makeService();
    const session = { id: SESSION_ID, mode: "l2_drill" };
    mockRepos.sessions.getOrCreateToday.mockResolvedValue(session);
    mockRepos.l2Progress.findDueCards.mockResolvedValue([]);
    mockRepos.l2Progress.findPendingProductionStepsForResume.mockResolvedValue([
      {
        step: {
          id: "prod-paused",
          session_id: SESSION_ID,
          word_id: WORD_ID,
          progress_id: PROGRESS_ID,
          step_index: 1,
          step_type: "l2_production",
          status: "pending",
          task_payload: { taskId: "t", taskType: "production", prompt: "x", stepIndex: 1 },
        },
        progress: {
          id: PROGRESS_ID,
          l2_due_at: null,
          l2_review_count: 0,
          l2_paused: true, // 暂停卡不应出队
        },
        word: {
          id: WORD_ID,
          slug: "s",
          title: "s",
          lemma: "s",
          pos: null,
          ipa: null,
          cefr: null,
          short_definition: null,
          corpus_items: [],
          synonym_items: [],
          antonym_items: [],
        },
      },
    ]);

    const result = await svc.getQueue(USER_ID, WORDBOOK_ID);
    expect(result.items).toEqual([]);
  });

  it("dedupes: skips due card when its word already has a pending production step", async () => {
    const svc = makeService();
    const session = { id: SESSION_ID, mode: "l2_drill" };
    mockRepos.sessions.getOrCreateToday.mockResolvedValue(session);
    // 模拟同词既在 pending 产出步补集、又在到期卡列表中
    mockRepos.l2Progress.findPendingProductionStepsForResume.mockResolvedValue([
      {
        step: {
          id: "prod-dup",
          session_id: SESSION_ID,
          word_id: WORD_ID,
          progress_id: PROGRESS_ID,
          step_index: 1,
          step_type: "l2_production",
          status: "pending",
          task_payload: { taskId: "t", taskType: "production", prompt: "x", stepIndex: 1 },
        },
        progress: {
          id: PROGRESS_ID,
          l2_due_at: null,
          l2_review_count: 0,
          l2_paused: false,
        },
        word: {
          id: WORD_ID,
          slug: "s",
          title: "s",
          lemma: "s",
          pos: null,
          ipa: null,
          cefr: null,
          short_definition: null,
          corpus_items: [],
          synonym_items: [],
          antonym_items: [],
        },
      },
    ]);
    // 同词到期卡（不应被出队，因 pending 产出步已包含）
    mockRepos.l2Progress.findDueCards.mockResolvedValue([
      {
        progress: { id: PROGRESS_ID, wordbook_id: WORDBOOK_ID },
        word: {
          id: WORD_ID,
          slug: "s",
          title: "s",
          lemma: "s",
          pos: null,
          ipa: null,
          cefr: null,
          short_definition: null,
          corpus_items: [],
          synonym_items: [],
          antonym_items: [],
        },
      },
    ]);
    mockRepos.l2Progress.insertDrillStepIfAbsent.mockResolvedValue({
      id: "step-new",
      status: "pending",
    });

    const result = await svc.getQueue(USER_ID, WORDBOOK_ID);
    // 只应有 1 个 item（pending 产出步）；到期卡被去重跳过
    expect(result.items).toHaveLength(1);
    expect(result.items[0].stepId).toBe("prod-dup");
    // insertDrillStepIfAbsent 不应被调用（同词已跳过）
    expect(mockRepos.l2Progress.insertDrillStepIfAbsent).not.toHaveBeenCalled();
  });
});

// ─── FR-12 接线1：submitTaskAnswer 正常路径入队 track='l2' 事件 ────────────
// L2ReviewService.answerWithinTx 在 saveL2Answer 后必须 enqueue REVIEW_ANSWER_RECORDED
// 事件，且 payload.track='l2'，让 worker 走 l2_weak_signal 分支而非 L1 联动链。

describe("submitTaskAnswer enqueues track='l2' outbox event (FR-12 wiring)", () => {
  it("calls outbox.enqueue with track='l2' on correct answer path", async () => {
    const svc = makeService();
    // 1) 无幂等键命中 → 走正常路径
    mockRepos.reviews.checkIdempotency.mockResolvedValue(null);
    // 2) 辨析步 pending
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      wordbook_id: WORDBOOK_ID,
      word_id: WORD_ID,
      progress_id: PROGRESS_ID,
      step_index: 0,
      step_type: "l2_discrimination",
      status: "pending",
      task_id: "cloze:abc",
      task_type: "cloze_mcq",
      task_payload: {
        taskId: "cloze:abc",
        taskType: "cloze_mcq",
        prompt: "____ glance",
        options: ["fleeting", "eternal", "vivid", "solemn"],
        answerIndex: 0,
        stepIndex: 0,
      },
    });
    // 3) L2 progress 行未暂停
    mockRepos.l2Progress.findForUpdate.mockResolvedValue({
      progress: {
        id: PROGRESS_ID,
        user_id: USER_ID,
        wordbook_id: WORDBOOK_ID,
        word_id: WORD_ID,
        l2_paused: false,
        l2_desired_retention: 0.9,
        l2_scheduler_payload: {
          due: "2026-08-20T00:00:00Z",
          stability: 3,
          difficulty: 5,
          state: 2,
        },
        l2_due_at: "2026-08-20T00:00:00Z",
        l2_last_reviewed_at: null,
        l2_review_count: 2,
        l2_stability: 3,
        l2_difficulty: 5,
        l2_state: "review",
        l2_content_hash_snapshot: "l2:word:prog",
        recent_ratings: ["good", "good"],
      },
      word: {
        id: WORD_ID,
        slug: "sustain",
        title: "sustain",
        lemma: "sustain",
        pos: "verb",
        ipa: "/səˈsteɪn/",
        cefr: "B2",
        short_definition: "维持",
        corpus_items: [{ text: "sustain growth", translation: "维持增长" }],
        synonym_items: [{ word: "maintain", semanticDiff: "更通用" }],
        antonym_items: [],
      },
    });
    // 4) saveL2Answer 返回 reviewLogId
    mockRepos.l2Progress.saveL2Answer.mockResolvedValue({
      reviewLogId: "log-l2-fr12-1",
    });
    // 5) completeDrillStep + insertDrillStepIfAbsent（建产出步）
    mockRepos.l2Progress.completeDrillStep.mockResolvedValue(undefined);
    mockRepos.l2Progress.insertDrillStepIfAbsent.mockResolvedValue({
      id: "prod-step-fr12",
      status: "pending",
    });
    // 6) sessions.assertActiveOwned 通过
    mockRepos.sessions.assertActiveOwned.mockResolvedValue(undefined);
    // 7) outbox.enqueue 返回
    mockRepos.outbox.enqueue.mockResolvedValue({ id: "event-fr12", inserted: true });

    const result = await svc.submitTaskAnswer(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0, idempotencyKey: "idem-fr12-1" },
      USER_ID,
    );

    // 必须入队一个事件
    expect(mockRepos.outbox.enqueue).toHaveBeenCalledTimes(1);
    const enqueueArgs = mockRepos.outbox.enqueue.mock.calls[0][0];
    expect(enqueueArgs.eventType).toBe("review.answer.recorded.v1");
    expect(enqueueArgs.aggregateType).toBe("review_log");
    expect(enqueueArgs.aggregateId).toBe("log-l2-fr12-1");
    // payload.track 必须是 'l2'（FR-12 接线核心断言）
    expect(enqueueArgs.payload.track).toBe("l2");
    expect(enqueueArgs.payload.userId).toBe(USER_ID);
    expect(enqueueArgs.payload.wordId).toBe(WORD_ID);
    expect(enqueueArgs.payload.wordbookId).toBe(WORDBOOK_ID);
    expect(enqueueArgs.payload.reviewLogId).toBe("log-l2-fr12-1");
    // 正常路径返回 correct + production 下一步
    expect(result.outcome).toBe("correct");
    expect(result.nextStep.type).toBe("production");
  });

  it("calls outbox.enqueue with track='l2' on incorrect answer path", async () => {
    const svc = makeService();
    mockRepos.reviews.checkIdempotency.mockResolvedValue(null);
    // task_payload.answerIndex=0，choiceIndex=1 → incorrect
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      wordbook_id: WORDBOOK_ID,
      word_id: WORD_ID,
      progress_id: PROGRESS_ID,
      step_index: 0,
      step_type: "l2_discrimination",
      status: "pending",
      task_id: "cloze:abc",
      task_type: "cloze_mcq",
      task_payload: {
        taskId: "cloze:abc",
        taskType: "cloze_mcq",
        prompt: "____ glance",
        options: ["fleeting", "eternal", "vivid", "solemn"],
        answerIndex: 0,
        stepIndex: 0,
      },
    });
    mockRepos.l2Progress.findForUpdate.mockResolvedValue({
      progress: {
        id: PROGRESS_ID,
        user_id: USER_ID,
        wordbook_id: WORDBOOK_ID,
        word_id: WORD_ID,
        l2_paused: false,
        l2_desired_retention: 0.9,
        l2_scheduler_payload: {
          due: "2026-08-20T00:00:00Z",
          stability: 3,
          difficulty: 5,
          state: 2,
        },
        l2_due_at: "2026-08-20T00:00:00Z",
        l2_last_reviewed_at: null,
        l2_review_count: 2,
        l2_stability: 3,
        l2_difficulty: 5,
        l2_state: "review",
        l2_content_hash_snapshot: "l2:word:prog",
        recent_ratings: ["good", "good"],
      },
      word: {
        id: WORD_ID,
        slug: "sustain",
        title: "sustain",
        lemma: "sustain",
        pos: "verb",
        ipa: "/səˈsteɪn/",
        cefr: "B2",
        short_definition: "维持",
        corpus_items: [],
        synonym_items: [],
        antonym_items: [],
      },
    });
    mockRepos.l2Progress.saveL2Answer.mockResolvedValue({
      reviewLogId: "log-l2-fr12-2",
    });
    mockRepos.l2Progress.completeDrillStep.mockResolvedValue(undefined);
    mockRepos.sessions.assertActiveOwned.mockResolvedValue(undefined);
    mockRepos.outbox.enqueue.mockResolvedValue({ id: "event-fr12", inserted: true });

    // choiceIndex=1 ≠ answerIndex=0 → incorrect
    const result = await svc.submitTaskAnswer(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 1, idempotencyKey: "idem-fr12-2" },
      USER_ID,
    );

    expect(mockRepos.outbox.enqueue).toHaveBeenCalledTimes(1);
    const enqueueArgs = mockRepos.outbox.enqueue.mock.calls[0][0];
    expect(enqueueArgs.payload.track).toBe("l2");
    expect(enqueueArgs.payload.reviewLogId).toBe("log-l2-fr12-2");
    // incorrect 路径返回 done（无产出步）
    expect(result.outcome).toBe("incorrect");
    expect(result.nextStep.type).toBe("done");
  });

  it("does NOT enqueue when idempotency key hits (replay path)", async () => {
    const svc = makeService();
    // 幂等命中 → 走重放路径，不进入 answerWithinTx，不 enqueue
    mockRepos.reviews.checkIdempotency.mockResolvedValue("log-existing");
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
      id: STEP_ID,
      session_id: SESSION_ID,
      user_id: USER_ID,
      word_id: WORD_ID,
      progress_id: PROGRESS_ID,
      step_index: 0,
      step_type: "l2_discrimination",
      status: "completed",
      outcome: "incorrect", // 非正确 → 直接 done
    });

    const result = await svc.submitTaskAnswer(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0, idempotencyKey: "idem-fr12-3" },
      USER_ID,
    );

    expect(result).toEqual({
      ok: true,
      idempotent: true,
      nextStep: { type: "done" },
    });
    // 幂等重放不应入队新事件
    expect(mockRepos.outbox.enqueue).not.toHaveBeenCalled();
    expect(mockRepos.l2Progress.saveL2Answer).not.toHaveBeenCalled();
  });
});

// ─── M1：L3 语境查询超时 fail-fast ────────────────────────────────────────
// 辨析提交（correct → 建产出步前）持着 l2_progress 行锁 + 独立 L3 事务占
// 第二个连接。慢/挂起 L3 查询必须 1.5s 超时返回 []（参照例句回退 corpus），
// 不能卡死辨析提交。未注入 telemetry 时超时同样走空返回。

describe("fetchContextSnippets L3 timeout fail-fast (M1 regression)", () => {
  it("returns [] when L3 context lookup hangs, without blocking the answer", async () => {
    vi.useFakeTimers();
    try {
      const svc = new L2DrillService({
        fsrsAdapter: vi.fn(() => ({
          difficulty: 5.0,
          dueAt: "2026-09-25T00:00:00.000Z",
          logDueAt: null,
          elapsedDays: 1,
          scheduledDays: 10,
          retrievability: 0.85,
          stability: 3.5,
          state: "review" as const,
          nextPayload: {
            due: "2026-09-25T00:00:00.000Z",
            stability: 3.5,
            difficulty: 5.0,
            state: 2,
            elapsed_days: 1,
            scheduled_days: 10,
            reps: 1,
            lapses: 0,
            learning_steps: 0,
            last_review: "2026-08-25T00:00:00.000Z",
          },
        })),
        loadWeights: vi.fn().mockResolvedValue(null),
        loadL2Weights: vi.fn().mockResolvedValue(null),
        // 挂起永不 settle：只能靠 1.5s 业务超时兜底
        contextSource: {
          getContextSnippets: vi.fn(() => new Promise<ContextSnippet[]>(() => {})),
        },
      });

      mockRepos.reviews.checkIdempotency.mockResolvedValue(null);
      mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
        id: STEP_ID,
        session_id: SESSION_ID,
        user_id: USER_ID,
        wordbook_id: WORDBOOK_ID,
        word_id: WORD_ID,
        progress_id: PROGRESS_ID,
        step_index: 0,
        step_type: "l2_discrimination",
        status: "pending",
        task_id: "cloze:abc",
        task_type: "cloze_mcq",
        task_payload: {
          taskId: "cloze:abc",
          taskType: "cloze_mcq",
          prompt: "____ glance",
          options: ["fleeting", "eternal", "vivid", "solemn"],
          answerIndex: 0,
          stepIndex: 0,
        },
      });
      mockRepos.l2Progress.findForUpdate.mockResolvedValue({
        progress: {
          id: PROGRESS_ID,
          user_id: USER_ID,
          wordbook_id: WORDBOOK_ID,
          word_id: WORD_ID,
          l2_paused: false,
          l2_desired_retention: 0.9,
          l2_scheduler_payload: { due: "2026-08-20T00:00:00Z", stability: 3, difficulty: 5, state: 2 },
          l2_due_at: "2026-08-20T00:00:00Z",
          l2_last_reviewed_at: null,
          l2_review_count: 2,
          l2_stability: 3,
          l2_difficulty: 5,
          l2_state: "review",
          l2_content_hash_snapshot: "l2:word:prog",
          recent_ratings: ["good", "good"],
        },
        word: {
          id: WORD_ID,
          slug: "sustain",
          title: "sustain",
          lemma: "sustain",
          pos: "verb",
          ipa: null,
          cefr: null,
          short_definition: "维持",
          corpus_items: [{ text: "Sunlight sustains life.", translation: "太阳光维持生命" }],
          synonym_items: [{ word: "maintain", semanticDiff: "更通用" }],
          antonym_items: [],
        },
      });
      mockRepos.l2Progress.saveL2Answer.mockResolvedValue({ reviewLogId: "log-m1" });
      mockRepos.l2Progress.completeDrillStep.mockResolvedValue(undefined);
      mockRepos.l2Progress.insertDrillStepIfAbsent.mockResolvedValue({ id: "prod-m1", status: "pending" });
      mockRepos.sessions.assertActiveOwned.mockResolvedValue(undefined);
      mockRepos.outbox.enqueue.mockResolvedValue({ id: "event-m1", inserted: true });

      // 发起提交（内部 await 挂起 L3 查询，被 guard 卡住）
      const submitting = svc.submitTaskAnswer(
        { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0, idempotencyKey: "idem-m1" },
        USER_ID,
      );
      // 推进 1.5s → guard reject → fail-fast 返回 []
      await vi.advanceTimersByTimeAsync(1500);
      const result = await submitting;

      // 辨析提交不被 L3 挂起阻塞，正常 correct + 进入产出步
      expect(result.outcome).toBe("correct");
      expect(result.nextStep.type).toBe("production");
      // 产出步 payload 无 L3 元数据（回退 corpus 参照例句，语义不变）
      const prodPayload = mockRepos.l2Progress.insertDrillStepIfAbsent.mock.calls[0][0]
        .task_payload as Record<string, unknown>;
      expect(prodPayload.sourceTitle).toBeUndefined();
      expect(prodPayload.contextId).toBeUndefined();
      expect(prodPayload.referenceExample).toBe("Sunlight sustains life.");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── getQueue 主循环（到期卡建步出队）───────────────────────────────────
describe("getQueue due-cards loop", () => {
  const word = {
    id: WORD_ID,
    slug: "sustain",
    title: "sustain",
    lemma: "sustain",
    pos: "verb",
    ipa: null,
    cefr: null,
    short_definition: "维持",
    corpus_items: [{ text: "Sunlight can sustain life.", translation: "阳光维持生命" }],
    synonym_items: [
      { word: "maintain", semanticDiff: "保持现状" },
      { word: "support", semanticDiff: "物理支撑" },
      { word: "endure", semanticDiff: "忍受" },
    ],
    antonym_items: [],
  };

  it("builds a step-0 task, inserts it, and surfaces the card", async () => {
    const svc = makeService();
    const session = { id: SESSION_ID, mode: "l2_drill" };
    mockRepos.sessions.getOrCreateToday.mockResolvedValue(session);
    mockRepos.l2Progress.findPendingProductionStepsForResume.mockResolvedValue([]);
    mockRepos.l2Progress.findDueCards.mockResolvedValue([
      { progress: { id: PROGRESS_ID, wordbook_id: WORDBOOK_ID }, word },
    ]);
    mockRepos.l2Progress.insertDrillStepIfAbsent.mockResolvedValue({
      id: "step-0",
      status: "pending",
    });

    const result = await svc.getQueue(USER_ID, WORDBOOK_ID);

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.stepId).toBe("step-0");
    expect(item.singleStep).toBe(false);
    expect(item.word.lemma).toBe("sustain");
    // 建步调用参数
    expect(mockRepos.l2Progress.insertDrillStepIfAbsent).toHaveBeenCalledTimes(1);
    const insertArgs = mockRepos.l2Progress.insertDrillStepIfAbsent.mock.calls[0][0];
    expect(insertArgs.session_id).toBe(SESSION_ID);
    expect(insertArgs.step_index).toBe(0);
    expect(["cloze_mcq", "synonym_discrimination"]).toContain(insertArgs.task_type);
  });

  it("skips cards whose step is already settled (completed)", async () => {
    const svc = makeService();
    const session = { id: SESSION_ID, mode: "l2_drill" };
    mockRepos.sessions.getOrCreateToday.mockResolvedValue(session);
    mockRepos.l2Progress.findPendingProductionStepsForResume.mockResolvedValue([]);
    mockRepos.l2Progress.findDueCards.mockResolvedValue([
      { progress: { id: PROGRESS_ID, wordbook_id: WORDBOOK_ID }, word },
    ]);
    // 已结算的步（如再次到期重现）→ 不出队
    mockRepos.l2Progress.insertDrillStepIfAbsent.mockResolvedValue({
      id: "step-settled",
      status: "completed",
    });

    const result = await svc.getQueue(USER_ID, WORDBOOK_ID);
    expect(result.items).toEqual([]);
  });

  it("skips pending production steps without a task_payload", async () => {
    const svc = makeService();
    const session = { id: SESSION_ID, mode: "l2_drill" };
    mockRepos.sessions.getOrCreateToday.mockResolvedValue(session);
    mockRepos.l2Progress.findDueCards.mockResolvedValue([]);
    mockRepos.l2Progress.findPendingProductionStepsForResume.mockResolvedValue([
      {
        step: {
          id: "prod-no-payload",
          session_id: SESSION_ID,
          word_id: WORD_ID,
          progress_id: PROGRESS_ID,
          step_index: 1,
          step_type: "l2_production",
          status: "pending",
          task_payload: null, // 无负载 → 跳过
        },
        progress: { id: PROGRESS_ID, l2_due_at: null, l2_review_count: 0, l2_paused: false },
        word: {
          id: WORD_ID, slug: "s", title: "s", lemma: "s",
          pos: null, ipa: null, cefr: null, short_definition: null,
          corpus_items: [], synonym_items: [], antonym_items: [],
        },
      },
    ]);

    const result = await svc.getQueue(USER_ID, WORDBOOK_ID);
    expect(result.items).toEqual([]);
  });
});

// ─── submitTaskAnswer 错误分支 ───────────────────────────────────────────
describe("submitTaskAnswer error branches", () => {
  const step = {
    id: STEP_ID,
    session_id: SESSION_ID,
    user_id: USER_ID,
    wordbook_id: WORDBOOK_ID,
    word_id: WORD_ID,
    progress_id: PROGRESS_ID,
    step_index: 0,
    step_type: "l2_discrimination" as const,
    status: "pending" as const,
    task_id: "cloze:x",
    task_type: "cloze_mcq",
    task_payload: { taskId: "cloze:x", taskType: "cloze_mcq", prompt: "____", options: ["a","b","c","d"], answerIndex: 0, stepIndex: 0 },
  };

  it("throws NotFoundError when step belongs to another session", async () => {
    const svc = makeService();
    mockRepos.reviews.checkIdempotency.mockResolvedValue(null);
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({ ...step, session_id: "other-session" });
    await expect(
      svc.submitTaskAnswer({ sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0 }, USER_ID),
    ).rejects.toThrow(/Drill step/);
  });

  it("throws NotFoundError when step not found", async () => {
    const svc = makeService();
    mockRepos.reviews.checkIdempotency.mockResolvedValue(null);
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue(null);
    await expect(
      svc.submitTaskAnswer({ sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0 }, USER_ID),
    ).rejects.toThrow(/Drill step/);
  });

  it("throws BusinessRuleError when step already settled", async () => {
    const svc = makeService();
    mockRepos.reviews.checkIdempotency.mockResolvedValue(null);
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({ ...step, status: "completed" });
    await expect(
      svc.submitTaskAnswer({ sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0 }, USER_ID),
    ).rejects.toThrow(/already settled/);
  });

  it("throws BusinessRuleError when submitting a production step via task-answer", async () => {
    const svc = makeService();
    mockRepos.reviews.checkIdempotency.mockResolvedValue(null);
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({ ...step, step_type: "l2_production", step_index: 1 });
    await expect(
      svc.submitTaskAnswer({ sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0 }, USER_ID),
    ).rejects.toThrow(/self-assessment endpoint/);
  });

  it("throws NotFoundError when L2 progress row missing", async () => {
    const svc = makeService();
    mockRepos.reviews.checkIdempotency.mockResolvedValue(null);
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue(step);
    mockRepos.l2Progress.findForUpdate.mockResolvedValue(null);
    await expect(
      svc.submitTaskAnswer({ sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0 }, USER_ID),
    ).rejects.toThrow(/L2 progress/);
  });

  it("marks step skipped and returns skipped when card is paused (race)", async () => {
    const svc = makeService();
    mockRepos.reviews.checkIdempotency.mockResolvedValue(null);
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue(step);
    mockRepos.l2Progress.findForUpdate.mockResolvedValue({
      progress: { id: PROGRESS_ID, l2_paused: true },
      word: { id: WORD_ID },
    });
    mockRepos.l2Progress.skipDrillStep.mockResolvedValue(undefined);

    const result = await svc.submitTaskAnswer(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0 },
      USER_ID,
    );
    expect(result).toEqual({ ok: true, skipped: true, nextStep: { type: "done" } });
    expect(mockRepos.l2Progress.skipDrillStep).toHaveBeenCalledWith(STEP_ID, USER_ID);
    // 不应触发 FSRS 应答
    expect(mockRepos.l2Progress.saveL2Answer).not.toHaveBeenCalled();
  });
});

// ─── submitSelfAssessment 错误分支 ───────────────────────────────────────
describe("submitSelfAssessment error branches", () => {
  const prodStep = {
    id: STEP_ID,
    session_id: SESSION_ID,
    user_id: USER_ID,
    wordbook_id: WORDBOOK_ID,
    word_id: WORD_ID,
    progress_id: PROGRESS_ID,
    step_index: 1,
    step_type: "l2_production" as const,
    status: "pending" as const,
    outcome: null,
    task_payload: { taskId: "p", taskType: "production", prompt: "x", stepIndex: 1 },
  };

  it("throws NotFoundError when step not found", async () => {
    const svc = makeService();
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue(null);
    await expect(
      svc.submitSelfAssessment({ sessionId: SESSION_ID, stepId: STEP_ID, verdict: "passed" }, USER_ID),
    ).rejects.toThrow(/Drill step/);
  });

  it("throws BusinessRuleError when step is not a production step", async () => {
    const svc = makeService();
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
      ...prodStep,
      step_type: "l2_discrimination",
      step_index: 0,
    });
    await expect(
      svc.submitSelfAssessment({ sessionId: SESSION_ID, stepId: STEP_ID, verdict: "passed" }, USER_ID),
    ).rejects.toThrow(/production steps only/);
  });

  it("throws BusinessRuleError when step is settled but not self-verdict", async () => {
    const svc = makeService();
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
      ...prodStep,
      status: "completed",
      outcome: "correct",
    });
    await expect(
      svc.submitSelfAssessment({ sessionId: SESSION_ID, stepId: STEP_ID, verdict: "passed" }, USER_ID),
    ).rejects.toThrow(/already settled/);
  });

  it("records verdict telemetry when telemetry is injected", async () => {
    const telemetry = { observeL2ProductionVerdict: vi.fn(), observeL3ContextLookup: vi.fn() };
    const svc = new L2DrillService({
      fsrsAdapter: vi.fn(),
      loadWeights: vi.fn().mockResolvedValue(null),
      loadL2Weights: vi.fn().mockResolvedValue(null),
      telemetry: telemetry as any,
    });
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue({
      ...prodStep,
      task_payload: { taskId: "p", taskType: "production", prompt: "x", stepIndex: 1, sourceTitle: "Notes", contextId: "ctx" },
    });
    mockRepos.l2Progress.updateProductionStatus.mockResolvedValue(undefined);
    mockRepos.l2Progress.completeDrillStep.mockResolvedValue(undefined);

    const result = await svc.submitSelfAssessment(
      { sessionId: SESSION_ID, stepId: STEP_ID, verdict: "weak" },
      USER_ID,
    );
    expect(result).toEqual({ ok: true, productionStatus: "weak" });
    // 带 L3 语境 → hasL3Context=true
    expect(telemetry.observeL2ProductionVerdict).toHaveBeenCalledWith("weak", true);
  });
});

// ─── undo 辨析步撤销失败分支 ─────────────────────────────────────────────
describe("undo discrimination failure branches", () => {
  const REVIEW_LOG_ID = "log-77777777-7777-4777-8777-777777777777";
  const discStep = {
    id: STEP_ID,
    session_id: SESSION_ID,
    user_id: USER_ID,
    wordbook_id: WORDBOOK_ID,
    word_id: WORD_ID,
    progress_id: PROGRESS_ID,
    step_index: 0,
    step_type: "l2_discrimination" as const,
    status: "completed" as const,
    outcome: "correct",
    review_log_id: REVIEW_LOG_ID,
  };

  it("throws when the L2 review log cannot be found", async () => {
    const svc = makeService();
    mockRepos.l2Progress.findLastDrillStep.mockResolvedValue(discStep);
    mockRepos.l2Progress.findReviewLogForL2Undo.mockResolvedValue(null);
    await expect(svc.undo(SESSION_ID, USER_ID)).rejects.toThrow(/not found or already undone/);
  });

  it("throws when markL2ReviewLogUndone affects zero rows", async () => {
    const svc = makeService();
    mockRepos.l2Progress.findLastDrillStep.mockResolvedValue(discStep);
    mockRepos.l2Progress.findReviewLogForL2Undo.mockResolvedValue({
      wordId: WORD_ID,
      wordbookId: WORDBOOK_ID,
      undone: false,
      previousSnapshot: { l2_state: "review" },
    });
    mockRepos.l2Progress.applyL2UndoSnapshot.mockResolvedValue(1);
    mockRepos.l2Progress.markL2ReviewLogUndone.mockResolvedValue(0);
    await expect(svc.undo(SESSION_ID, USER_ID)).rejects.toThrow(/not owned/);
  });

  it("derives restoredState from previousSnapshot.l2_state on successful undo", async () => {
    const svc = makeService();
    mockRepos.l2Progress.findLastDrillStep.mockResolvedValue(discStep);
    mockRepos.l2Progress.findReviewLogForL2Undo.mockResolvedValue({
      wordId: WORD_ID,
      wordbookId: WORDBOOK_ID,
      undone: false,
      previousSnapshot: { l2_state: "learning" },
    });
    mockRepos.l2Progress.applyL2UndoSnapshot.mockResolvedValue(1);
    mockRepos.l2Progress.markL2ReviewLogUndone.mockResolvedValue(1);
    mockRepos.l2Progress.findDrillStepBySessionWordStep.mockResolvedValue(null);
    mockRepos.l2Progress.deleteDrillStep.mockResolvedValue(undefined);
    mockRepos.l2Progress.insertL2UndoAuditLog.mockResolvedValue(undefined);

    const result = await svc.undo(SESSION_ID, USER_ID, "idem-disc-state");
    expect(result).toEqual({ ok: true });
    expect(mockRepos.l2Progress.insertL2UndoAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ restoredState: "learning", idempotencyKey: "idem-disc-state" }),
    );
  });
});

// ─── fetchContextSnippets telemetry（P2-5 命中率/延迟采集）────────────────
describe("fetchContextSnippets telemetry (P2-5)", () => {
  function makeTelemetryService(contextSource: any) {
    const telemetry = { observeL2ProductionVerdict: vi.fn(), observeL3ContextLookup: vi.fn() };
    const svc = new L2DrillService({
      fsrsAdapter: vi.fn(() => ({
        difficulty: 5.0, dueAt: "2026-09-25T00:00:00.000Z", logDueAt: null,
        elapsedDays: 1, scheduledDays: 10, retrievability: 0.85, stability: 3.5,
        state: "review" as const,
        nextPayload: { due: "2026-09-25T00:00:00.000Z", stability: 3.5, difficulty: 5.0, state: 2 },
      })),
      loadWeights: vi.fn().mockResolvedValue(null),
      loadL2Weights: vi.fn().mockResolvedValue(null),
      contextSource,
      telemetry: telemetry as any,
    });
    return { svc, telemetry };
  }

  const discriminationStep = {
    id: STEP_ID,
    session_id: SESSION_ID,
    user_id: USER_ID,
    wordbook_id: WORDBOOK_ID,
    word_id: WORD_ID,
    progress_id: PROGRESS_ID,
    step_index: 0,
    step_type: "l2_discrimination" as const,
    status: "pending" as const,
    task_id: "cloze:x",
    task_type: "cloze_mcq",
    task_payload: { taskId: "cloze:x", taskType: "cloze_mcq", prompt: "____", options: ["a","b","c","d"], answerIndex: 0, stepIndex: 0 },
  };
  const l2Progress = {
    progress: {
      id: PROGRESS_ID, user_id: USER_ID, wordbook_id: WORDBOOK_ID, word_id: WORD_ID,
      l2_paused: false, l2_desired_retention: 0.9, l2_scheduler_payload: { due: "2026-08-20T00:00:00Z", stability: 3, difficulty: 5, state: 2 },
      l2_due_at: "2026-08-20T00:00:00Z", l2_last_reviewed_at: null, l2_review_count: 2,
      l2_stability: 3, l2_difficulty: 5, l2_state: "review", l2_content_hash_snapshot: "h", recent_ratings: [],
    },
    word: {
      id: WORD_ID, slug: "sustain", title: "sustain", lemma: "sustain", pos: "verb",
      ipa: null, cefr: null, short_definition: "维持",
      corpus_items: [{ text: "Sunlight sustains life.", translation: "阳光维持生命" }],
      synonym_items: [], antonym_items: [],
    },
  };

  it("records hit when context source returns snippets and writes source metadata", async () => {
    const { svc, telemetry } = makeTelemetryService({
      getContextSnippets: vi.fn().mockResolvedValue([
        { text: "We must sustain the momentum.", contextId: "ctx-1", sourceTitle: "Notes" },
      ]),
    });
    mockRepos.reviews.checkIdempotency.mockResolvedValue(null);
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue(discriminationStep);
    mockRepos.l2Progress.findForUpdate.mockResolvedValue(l2Progress);
    mockRepos.l2Progress.saveL2Answer.mockResolvedValue({ reviewLogId: "log-t" });
    mockRepos.l2Progress.completeDrillStep.mockResolvedValue(undefined);
    mockRepos.l2Progress.insertDrillStepIfAbsent.mockResolvedValue({ id: "prod-t", status: "pending" });
    mockRepos.sessions.assertActiveOwned.mockResolvedValue(undefined);
    mockRepos.outbox.enqueue.mockResolvedValue({ id: "e", inserted: true });

    const result = await svc.submitTaskAnswer(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0, idempotencyKey: "idem-t" },
      USER_ID,
    );
    expect(result.outcome).toBe("correct");
    expect(telemetry.observeL3ContextLookup).toHaveBeenCalledWith("hit", expect.any(Number));
    // L3 语境写入产出步 payload
    const prodPayload = mockRepos.l2Progress.insertDrillStepIfAbsent.mock.calls[0][0].task_payload;
    expect(prodPayload.sourceTitle).toBe("Notes");
    expect(prodPayload.contextId).toBe("ctx-1");
  });

  it("records miss when context source returns empty", async () => {
    const { svc, telemetry } = makeTelemetryService({ getContextSnippets: vi.fn().mockResolvedValue([]) });
    mockRepos.reviews.checkIdempotency.mockResolvedValue(null);
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue(discriminationStep);
    mockRepos.l2Progress.findForUpdate.mockResolvedValue(l2Progress);
    mockRepos.l2Progress.saveL2Answer.mockResolvedValue({ reviewLogId: "log-m" });
    mockRepos.l2Progress.completeDrillStep.mockResolvedValue(undefined);
    mockRepos.l2Progress.insertDrillStepIfAbsent.mockResolvedValue({ id: "prod-m", status: "pending" });
    mockRepos.sessions.assertActiveOwned.mockResolvedValue(undefined);
    mockRepos.outbox.enqueue.mockResolvedValue({ id: "e", inserted: true });

    await svc.submitTaskAnswer(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0, idempotencyKey: "idem-m" },
      USER_ID,
    );
    expect(telemetry.observeL3ContextLookup).toHaveBeenCalledWith("miss", expect.any(Number));
  });

  it("records error and degrades to corpus when context source throws", async () => {
    const { svc, telemetry } = makeTelemetryService({
      getContextSnippets: vi.fn().mockRejectedValue(new Error("l3 down")),
    });
    mockRepos.reviews.checkIdempotency.mockResolvedValue(null);
    mockRepos.l2Progress.findDrillStepForUpdate.mockResolvedValue(discriminationStep);
    mockRepos.l2Progress.findForUpdate.mockResolvedValue(l2Progress);
    mockRepos.l2Progress.saveL2Answer.mockResolvedValue({ reviewLogId: "log-e" });
    mockRepos.l2Progress.completeDrillStep.mockResolvedValue(undefined);
    mockRepos.l2Progress.insertDrillStepIfAbsent.mockResolvedValue({ id: "prod-e", status: "pending" });
    mockRepos.sessions.assertActiveOwned.mockResolvedValue(undefined);
    mockRepos.outbox.enqueue.mockResolvedValue({ id: "e", inserted: true });

    const result = await svc.submitTaskAnswer(
      { sessionId: SESSION_ID, stepId: STEP_ID, choiceIndex: 0, idempotencyKey: "idem-e" },
      USER_ID,
    );
    expect(result.outcome).toBe("correct"); // L3 故障不阻塞辨析提交
    expect(telemetry.observeL3ContextLookup).toHaveBeenCalledWith("error", expect.any(Number));
    // 回退 corpus 参照例句
    const prodPayload = mockRepos.l2Progress.insertDrillStepIfAbsent.mock.calls[0][0].task_payload;
    expect(prodPayload.referenceExample).toBe("Sunlight sustains life.");
  });
});
