import { describe, it, expect, vi } from "vitest";

vi.mock("@/db/transaction", () => ({
  withTransaction: vi.fn(async (cb: any) => cb({})),
}));

import { L2ProgressRepository } from "@/repositories/l2-progress.repository";

describe("L2ProgressRepository", () => {
  it("findByWordbookWordAndUser returns null when not found", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    const result = await repo.findByWordbookWordAndUser("user-1", "wb-1", "word-1");
    expect(result).toBeNull();
  });

  it("findByWordbookWordAndUser scopes the query by (user_id, wordbook_id, word_id)", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    await repo.findByWordbookWordAndUser("user-1", "wb-1", "word-1");
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("user_id = $1");
    expect(sql).toContain("wordbook_id = $2::uuid");
    expect(sql).toContain("word_id = $3::uuid");
    expect(params).toEqual(["user-1", "wb-1", "word-1"]);
  });

  it("insert creates L2 progress row with wordbook_id", async () => {
    const repo = new L2ProgressRepository();
    const mockRow = { id: "l2-1", l2_state: "review", l2_stability: 5.25 };
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(mockRow);
    const result = await repo.insert({
      user_id: "user-1",
      wordbook_id: "wb-1",
      word_id: "word-1",
      l2_stability: 5.25,
      l2_difficulty: 7.0,
      l2_state: "review",
      l2_desired_retention: 0.9,
      l2_due_at: new Date().toISOString(),
      l2_inherited_from_l1: true,
      l2_weights_source: "inherited",
    });
    expect(result.id).toBe("l2-1");
    // Verify the INSERT carries wordbook_id.
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("wordbook_id");
    expect(params[0]).toBe("user-1");
    expect(params[1]).toBe("wb-1");
    expect(params[2]).toBe("word-1");
  });

  // ── finalizeL2ContentHash (word-level, content-driven) ──────────────────

  it("finalizeL2ContentHash calls the schema-qualified migration-owned RPC", async () => {
    const repo = new L2ProgressRepository();
    const queryOneSpy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ updated_count: 1 });

    await repo.finalizeL2ContentHash("word-1", "l2hash", "fullhash");

    expect(queryOneSpy).toHaveBeenCalledTimes(1);
    expect(queryOneSpy).toHaveBeenCalledWith(
      expect.stringContaining("SELECT public.finalize_l2_content_hash($1::uuid, $2::text, $3::text) AS updated_count"),
      ["word-1", "l2hash", "fullhash"],
    );
  });

  it("finalizeL2ContentHash returns the RPC updated_count", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue({ updated_count: 2 });

    await expect(repo.finalizeL2ContentHash("word-1", "l2hash", "fullhash")).resolves.toBe(2);
  });

  it("finalizeL2ContentHash returns zero when the RPC returns no row", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);

    await expect(repo.finalizeL2ContentHash("word-1", "l2hash", "fullhash")).resolves.toBe(0);
  });

  // ── pause / unpause (wordbook-scoped) ──────────────────────────────────

  it("pause sets l2_paused=true with reason, scoped by wordbook", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([]);
    await repo.pause("user-1", "wb-1", "word-1", "l1_cascade_failure");
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("l2_paused = true");
    expect(sql).toContain("l2_paused_reason");
    expect(sql).toContain("wordbook_id = $2::uuid");
    expect(sql).toContain("word_id = $3::uuid");
    expect(params).toEqual(["user-1", "wb-1", "word-1", "l1_cascade_failure"]);
  });

  it("unpauseByReason sets l2_paused=false and l2_due_at=now(), scoped by wordbook", async () => {
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "query").mockResolvedValue([]);
    await repo.unpauseByReason("user-1", "wb-1", "word-1", "l1_cascade_failure");
    const [sql, params] = (repo as any).query.mock.calls[0];
    expect(sql).toContain("l2_paused = false");
    expect(sql).toContain("l2_due_at = now()");
    expect(sql).toContain("wordbook_id = $2::uuid");
    expect(sql).toContain("word_id = $3::uuid");
    expect(params).toEqual(["user-1", "wb-1", "word-1", "l1_cascade_failure"]);
  });

  // ── Cross-wordbook isolation ───────────────────────────────────────────

  it("pause does NOT touch a different wordbook's L2 progress (cross-wordbook isolation)", async () => {
    const repo = new L2ProgressRepository();
    const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
    // Pause wb-A for user-1/word-1.
    await repo.pause("user-1", "wb-A", "word-1", "l1_cascade_failure");
    // The WHERE clause must include wordbook_id so wb-B's row is untouched.
    const [sql] = querySpy.mock.calls[0];
    expect(sql).toMatch(/wordbook_id = \$2::uuid/);
    // Sanity: only one UPDATE issued for this call.
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it("findByWordbookWordAndUser would not return another wordbook's row (parameter binding)", async () => {
    // Simulate the DB having a row for (user-1, wb-B, word-1) but the query
    // asks for wb-A — the mock returns null because the WHERE includes
    // wordbook_id, proving the lookup is wordbook-scoped.
    const repo = new L2ProgressRepository();
    vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
    const result = await repo.findByWordbookWordAndUser("user-1", "wb-A", "word-1");
    expect(result).toBeNull();
    const [sql, params] = (repo as any).queryOne.mock.calls[0];
    expect(sql).toContain("wordbook_id = $2::uuid");
    expect(params[1]).toBe("wb-A");
  });

  // ── M5 回归：findDrillStepBySessionWordStep ───────────────────────────
  // 此前 submitTaskAnswer 幂等重放一律返回 { type: "done" }，丢失产出步入口。
  // 修复后调用方需用此方法按 (session, user, word, step_index) 精确定位产出步。
  describe("findDrillStepBySessionWordStep (M5 regression)", () => {
    it("scopes by (session_id, user_id, word_id, step_index) without FOR UPDATE", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
      await repo.findDrillStepBySessionWordStep("sess-1", "user-1", "word-1", 1);
      expect(spy).toHaveBeenCalledTimes(1);
      const [sql, params] = spy.mock.calls[0];
      expect(sql).toContain("session_id = $1::uuid");
      expect(sql).toContain("user_id = $2::uuid");
      expect(sql).toContain("word_id = $3::uuid");
      expect(sql).toContain("step_index = $4");
      expect(sql).not.toContain("FOR UPDATE");
      expect(params).toEqual(["sess-1", "user-1", "word-1", 1]);
    });

    it("returns the located row as-is", async () => {
      const repo = new L2ProgressRepository();
      const row = { id: "step-2", status: "pending", step_index: 1 };
      vi.spyOn(repo as any, "queryOne").mockResolvedValue(row);
      const result = await repo.findDrillStepBySessionWordStep("sess-1", "user-1", "word-1", 1);
      expect(result).toEqual(row);
    });

    it("returns null when not found", async () => {
      const repo = new L2ProgressRepository();
      vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
      const result = await repo.findDrillStepBySessionWordStep("sess-1", "user-1", "word-1", 1);
      expect(result).toBeNull();
    });
  });

  // ── M8 回归：findPendingProductionStepsForResume ─────────────────────
  // 此前 getQueue 只看 findDueCards，若辨析步已 correct 但产出步未自评，
  // 用户刷新后会 lost-in-session。修复后用此方法补 pending 产出步。
  describe("findPendingProductionStepsForResume (M8 regression)", () => {
    it("scopes by (session_id, user_id) + step_type='l2_production' + status='pending'", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await repo.findPendingProductionStepsForResume("sess-1", "user-1");
      expect(spy).toHaveBeenCalledTimes(1);
      const [sql, params] = spy.mock.calls[0];
      expect(sql).toContain("session_id = $1::uuid");
      expect(sql).toContain("user_id = $2::uuid");
      expect(sql).toContain("step_type = 'l2_production'");
      expect(sql).toContain("status = 'pending'");
      // 不应上锁：调用方在 getQueue 中是只读补集
      expect(sql).not.toContain("FOR UPDATE");
      expect(params).toEqual(["sess-1", "user-1"]);
    });

    it("JOINs user_word_l2_progress + words and returns empty array when no rows", async () => {
      const repo = new L2ProgressRepository();
      vi.spyOn(repo as any, "query").mockResolvedValue([]);
      const result = await repo.findPendingProductionStepsForResume("sess-1", "user-1");
      expect(result).toEqual([]);
    });

    it("maps prefixed columns to {step, progress, word} structure", async () => {
      const repo = new L2ProgressRepository();
      const row = {
        // step 字段（无前缀，来自 s.*）
        id: "step-1",
        session_id: "sess-1",
        user_id: "user-1",
        wordbook_id: "wb-1",
        word_id: "word-1",
        progress_id: "prog-1",
        step_index: 1,
        step_type: "l2_production",
        status: "pending",
        task_payload: { taskId: "t", taskType: "production", prompt: "x", stepIndex: 1 },
        // progress 字段（p_ 前缀）
        p_id: "prog-1",
        p_user_id: "user-1",
        p_wordbook_id: "wb-1",
        p_word_id: "word-1",
        p_l2_stability: 3.5,
        p_l2_difficulty: 5.0,
        p_l2_state: "review",
        p_l2_due_at: "2026-01-01T00:00:00Z",
        p_l2_review_count: 2,
        p_l2_paused: false,
        // word 字段（w_ 前缀）
        w_id: "word-1",
        w_slug: "sustain",
        w_title: "sustain",
        w_lemma: "sustain",
      };
      vi.spyOn(repo as any, "query").mockResolvedValue([row]);
      const result = await repo.findPendingProductionStepsForResume("sess-1", "user-1");
      expect(result).toHaveLength(1);
      expect(result[0].step.id).toBe("step-1");
      expect(result[0].progress.id).toBe("prog-1");
      expect(result[0].word.id).toBe("word-1");
      expect(result[0].word.slug).toBe("sustain");
    });
  });

  // ── M7 回归：L2 撤销链路方法族 ───────────────────────────────────────
  // 此前 undo 只覆盖 l2_production 撤销，辨析步撤销丢失。修复后新增
  // findReviewLogForL2Undo / applyL2UndoSnapshot / markL2ReviewLogUndone /
  // insertL2UndoAuditLog 四方法，让 L2 undo 与 L1 undoReviewLog 等价。
  describe("findReviewLogForL2Undo (M7 regression)", () => {
    it("scopes by (id, user_id) + track='l2' + FOR UPDATE", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
      await repo.findReviewLogForL2Undo("log-1", "user-1");
      expect(spy).toHaveBeenCalledTimes(1);
      const [sql, params] = spy.mock.calls[0];
      expect(sql).toContain("FROM review_logs");
      expect(sql).toContain("id = $1::uuid");
      expect(sql).toContain("user_id = $2::uuid");
      expect(sql).toContain("track = 'l2'");
      // 必须加 FOR UPDATE，避免并发撤销竞态
      expect(sql).toContain("FOR UPDATE");
      expect(params).toEqual(["log-1", "user-1"]);
    });

    it("returns null when not found", async () => {
      const repo = new L2ProgressRepository();
      vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
      const result = await repo.findReviewLogForL2Undo("log-1", "user-1");
      expect(result).toBeNull();
    });

    it("maps snake_case columns to camelCase fields", async () => {
      const repo = new L2ProgressRepository();
      vi.spyOn(repo as any, "queryOne").mockResolvedValue({
        word_id: "word-1",
        wordbook_id: "wb-1",
        undone: false,
        previous_snapshot: { l2_state: "review", l2_stability: 3.5 },
      });
      const result = await repo.findReviewLogForL2Undo("log-1", "user-1");
      expect(result).toEqual({
        wordId: "word-1",
        wordbookId: "wb-1",
        undone: false,
        previousSnapshot: { l2_state: "review", l2_stability: 3.5 },
      });
    });
  });

  describe("applyL2UndoSnapshot (M7 regression)", () => {
    it("updates user_word_l2_progress with COALESCE on snapshot fields", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([{ id: "prog-1" }]);
      const result = await repo.applyL2UndoSnapshot("prog-1", "user-1", {
        l2_stability: 3.5,
        l2_difficulty: 5.0,
        l2_state: "review",
        l2_due_at: "2026-01-01T00:00:00Z",
        recent_ratings: ["good"],
      });
      expect(result).toBe(1);
      const [sql, params]: [string, unknown[]] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("UPDATE user_word_l2_progress");
      expect(sql).toContain("l2_stability = COALESCE");
      expect(sql).toContain("l2_difficulty = COALESCE");
      expect(sql).toContain("l2_state = COALESCE");
      expect(sql).toContain("l2_due_at = COALESCE");
      expect(sql).toContain("recent_ratings = COALESCE");
      expect(sql).toContain("id = $1::uuid");
      expect(sql).toContain("user_id = $2::uuid");
      expect(params[0]).toBe("prog-1");
      expect(params[1]).toBe("user-1");
      expect(params[2]).toBe(3.5); // l2_stability
      expect(params[3]).toBe(5.0); // l2_difficulty
    });

    it("returns 0 when progress row not found or not owned", async () => {
      const repo = new L2ProgressRepository();
      vi.spyOn(repo as any, "query").mockResolvedValue([]);
      const result = await repo.applyL2UndoSnapshot("prog-1", "user-1", {});
      expect(result).toBe(0);
    });

    it("handles null snapshot fields by passing null to COALESCE", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([{ id: "prog-1" }]);
      await repo.applyL2UndoSnapshot("prog-1", "user-1", {});
      const params = spy.mock.calls[0][1] as unknown[];
      // 缺失字段应转为 null，让 COALESCE 保留既有 DB 值
      expect(params[2]).toBeNull(); // l2_stability
      expect(params[3]).toBeNull(); // l2_difficulty
      expect(params[4]).toBeNull(); // l2_state
    });
  });

  describe("markL2ReviewLogUndone (M7 regression)", () => {
    it("sets undone=true + undone_at=now(), scoped by track='l2' and undone=false", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([{ id: "log-1" }]);
      const result = await repo.markL2ReviewLogUndone("log-1", "user-1");
      expect(result).toBe(1);
      const [sql, params]: [string, unknown[]] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("UPDATE review_logs");
      expect(sql).toContain("undone = true");
      expect(sql).toContain("undone_at = now()");
      expect(sql).toContain("id = $1::uuid");
      expect(sql).toContain("user_id = $2::uuid");
      expect(sql).toContain("track = 'l2'");
      expect(sql).toContain("undone = false");
      expect(params).toEqual(["log-1", "user-1"]);
    });

    it("returns 0 when log already undone or not owned", async () => {
      const repo = new L2ProgressRepository();
      vi.spyOn(repo as any, "query").mockResolvedValue([]);
      const result = await repo.markL2ReviewLogUndone("log-1", "user-1");
      expect(result).toBe(0);
    });
  });

  describe("insertL2UndoAuditLog (M7 regression)", () => {
    it("inserts audit row with track='l2', rating=NULL, metadata={action:'undo'}", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await repo.insertL2UndoAuditLog({
        userId: "user-1",
        wordId: "word-1",
        wordbookId: "wb-1",
        progressId: "prog-1",
        sessionId: "sess-1",
        reviewLogId: "log-1",
        restoredState: "review",
        idempotencyKey: "idem-1",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const [sql, params]: [string, unknown[]] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("INSERT INTO review_logs");
      expect(sql).toContain("track");
      expect(sql).toContain("'l2'");
      expect(params[0]).toBe("user-1");
      expect(params[1]).toBe("word-1");
      expect(params[2]).toBe("wb-1");
      expect(params[3]).toBe("prog-1");
      expect(params[4]).toBe("sess-1");
      // rating=NULL 由 SQL 文本硬编码，不出现在 params 中
      expect(params[5]).toBe("review"); // restoredState
      // metadata 应包含 action:'undo' 和 undone_log_id
      const metadata = JSON.parse(params[6] as string);
      expect(metadata.action).toBe("undo");
      expect(metadata.undone_log_id).toBe("log-1");
      expect(params[8]).toBe("idem-1"); // idempotency_key
    });

    it("accepts null idempotencyKey", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await repo.insertL2UndoAuditLog({
        userId: "user-1",
        wordId: "word-1",
        wordbookId: "wb-1",
        progressId: "prog-1",
        sessionId: "sess-1",
        reviewLogId: "log-1",
        restoredState: "review",
        idempotencyKey: null,
      });
      const params = spy.mock.calls[0][1] as unknown[];
      expect(params[8]).toBeNull();
    });
  });

  // ── M3 回归：insertDrillStepIfAbsent 冲突回读 user 过滤 ───────────────
  // 回读 SQL 之前只按 (session, word, step_index) 过滤，未带 user_id。
  // 若攻击者持有他人 session_id，可回读到他人行的 task_payload（DB 存储
  // 含 answerIndex）→ 答案泄漏路径。修复后回读必须 user-scoped。
  describe("insertDrillStepIfAbsent conflict re-read scoped by user (M3 regression)", () => {
    it("re-read query filters by user_id to prevent cross-user task_payload leaks", async () => {
      const repo = new L2ProgressRepository();
      // 第一次调用 = INSERT...RETURNING（唯一约束冲突 → 无行返回）
      // 第二次调用 = 冲突回读 SELECT（必须带 user_id）
      const row = { id: "step-dup", status: "pending", step_index: 0 };
      const spy = vi
        .spyOn(repo as any, "queryOne")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(row);

      const result = await repo.insertDrillStepIfAbsent({
        session_id: "sess-1",
        user_id: "user-1",
        wordbook_id: "wb-1",
        word_id: "word-1",
        progress_id: "prog-1",
        step_index: 0,
        step_type: "l2_discrimination",
        task_id: "cloze:x",
        task_type: "cloze_mcq",
        task_payload: { taskId: "cloze:x" },
      });

      expect(result).toEqual(row);
      expect(spy).toHaveBeenCalledTimes(2);
      const [sql, params] = spy.mock.calls[1];
      expect(sql).toContain("user_id = $1::uuid");
      expect(sql).toContain("session_id = $2::uuid");
      expect(sql).toContain("word_id = $3::uuid");
      expect(sql).toContain("step_index = $4");
      expect(params).toEqual(["user-1", "sess-1", "word-1", 0]);
    });
  });

  // ── insert（含 l2_scheduler_payload 序列化）───────────────────────────
  describe("insert payload handling", () => {
    it("serializes l2_scheduler_payload when provided", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: "l2-2" });
      await repo.insert({
        user_id: "user-1",
        wordbook_id: "wb-1",
        word_id: "word-1",
        l2_stability: 5.25,
        l2_difficulty: 7.0,
        l2_state: "review",
        l2_desired_retention: 0.9,
        l2_due_at: "2026-01-01T00:00:00Z",
        l2_inherited_from_l1: true,
        l2_weights_source: "inherited",
        l2_scheduler_payload: { due: "2026-01-01T00:00:00Z", stability: 5.25, difficulty: 7.0, state: 2 },
      });
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("l2_scheduler_payload");
      expect(params[10]).toBe(JSON.stringify({ due: "2026-01-01T00:00:00Z", stability: 5.25, difficulty: 7.0, state: 2 }));
    });

    it("passes null l2_scheduler_payload when absent", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: "l2-3" });
      await repo.insert({
        user_id: "user-1",
        wordbook_id: "wb-1",
        word_id: "word-1",
        l2_stability: 5.25,
        l2_difficulty: 7.0,
        l2_state: "review",
        l2_desired_retention: 0.9,
        l2_due_at: "2026-01-01T00:00:00Z",
        l2_inherited_from_l1: true,
        l2_weights_source: "inherited",
      });
      const params = spy.mock.calls[0][1] as unknown[];
      expect(params[10]).toBeNull();
    });

    it("throws when insert returns no row", async () => {
      const repo = new L2ProgressRepository();
      vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
      await expect(
        repo.insert({
          user_id: "user-1",
          wordbook_id: "wb-1",
          word_id: "word-1",
          l2_stability: 1,
          l2_difficulty: 1,
          l2_state: "review",
          l2_desired_retention: 0.9,
          l2_due_at: "2026-01-01T00:00:00Z",
          l2_inherited_from_l1: true,
          l2_weights_source: "inherited",
        }),
      ).rejects.toThrow(/no row/);
    });
  });

  // ── findDueCards（L2 到期口径队列）────────────────────────────────────
  describe("findDueCards", () => {
    it("filters unpaused due cards and maps joined rows to {progress, word}", async () => {
      const repo = new L2ProgressRepository();
      const row = {
        id: "p1",
        l2_paused: false,
        l2_due_at: "2026-01-01T00:00:00Z",
        w_id: "word-1",
        w_slug: "sustain",
        w_title: "sustain",
        w_lemma: "sustain",
        w_pos: "verb",
        w_ipa: null,
        w_cefr: "B2",
        w_short_definition: "维持",
        w_corpus_items: [],
        w_synonym_items: [],
        w_antonym_items: [],
      };
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([row]);
      const result = await repo.findDueCards("user-1", "wb-1", 10);
      expect(result).toHaveLength(1);
      expect(result[0].progress.id).toBe("p1");
      expect(result[0].word.lemma).toBe("sustain");
      expect(result[0].word.pos).toBe("verb");
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("l2_paused = false");
      expect(sql).toContain("l2_due_at <= now()");
      expect(sql).toContain("ORDER BY p.l2_due_at ASC");
      expect(params).toEqual(["user-1", "wb-1", 10]);
    });

    it("returns empty array when no due cards", async () => {
      const repo = new L2ProgressRepository();
      vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await expect(repo.findDueCards("user-1", "wb-1", 10)).resolves.toEqual([]);
    });
  });

  // ── findForUpdate（SELECT FOR UPDATE + JOIN words）────────────────────
  describe("findForUpdate", () => {
    it("returns mapped {progress, word} when found", async () => {
      const repo = new L2ProgressRepository();
      const row = {
        id: "p1",
        l2_state: "review",
        w_id: "word-1",
        w_slug: "sustain",
        w_title: "sustain",
        w_lemma: "sustain",
        w_pos: null,
        w_ipa: null,
        w_cefr: null,
        w_short_definition: null,
        w_corpus_items: [],
        w_synonym_items: [],
        w_antonym_items: [],
      };
      const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(row);
      const result = await repo.findForUpdate("p1", "user-1");
      expect(result?.progress.id).toBe("p1");
      expect(result?.word.slug).toBe("sustain");
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("FOR UPDATE OF p");
      expect(params).toEqual(["p1", "user-1"]);
    });

    it("returns null when not found", async () => {
      const repo = new L2ProgressRepository();
      vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
      await expect(repo.findForUpdate("p1", "user-1")).resolves.toBeNull();
    });
  });

  // ── saveL2Answer（L2 应答持久化 + track='l2' review log）──────────────
  describe("saveL2Answer", () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        progressId: "prog-1",
        userId: "user-1",
        wordbookId: "wb-1",
        wordId: "word-1",
        rating: "good" as const,
        state: "review",
        stability: 3.5,
        difficulty: 5.0,
        retrievability: 0.8,
        dueAt: "2026-09-01T00:00:00Z",
        lastReviewedAt: "2026-08-25T00:00:00Z",
        intervalDays: 7,
        scheduledDays: 10,
        elapsedDays: 1,
        nextPayload: { due: "2026-09-01T00:00:00Z", stability: 3.5, difficulty: 5.0, state: 2 },
        contentHashSnapshot: "hash",
        previousSnapshot: { l2_stability: 2.0 },
        logMetadata: { mode: "l2_drill", step_index: 0 },
        sessionId: "sess-1",
        idempotencyKey: "idem-1",
        ...overrides,
      };
    }

    it("keeps nextPayload when usable and writes the update + track='l2' log", async () => {
      const repo = new L2ProgressRepository();
      const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
      vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: "log-1" });
      const result = await repo.saveL2Answer(makeInput());
      expect(result).toEqual({ reviewLogId: "log-1" });
      // UPDATE 参数：$9 = 序列化后的 usable payload（原样保留）
      const updateParams = querySpy.mock.calls[0][1] as unknown[];
      expect(updateParams[8]).toBe(JSON.stringify({ due: "2026-09-01T00:00:00Z", stability: 3.5, difficulty: 5.0, state: 2 }));
      // INSERT review_logs：track='l2'
      const logSql = (repo as any).queryOne.mock.calls[0][0] as string;
      expect(logSql).toContain("'l2'");
      const logParams = (repo as any).queryOne.mock.calls[0][1] as unknown[];
      expect(logParams[0]).toBe("user-1");
      expect(logParams[7]).toBe(1); // elapsed_days
      expect(logParams[8]).toBe(10); // scheduled_days
    });

    it("rebuilds payload from scalar columns when nextPayload is unusable (empty object)", async () => {
      const repo = new L2ProgressRepository();
      const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
      vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: "log-2" });
      await repo.saveL2Answer(makeInput({ nextPayload: {} }));
      const updateParams = querySpy.mock.calls[0][1] as unknown[];
      const payload = JSON.parse(updateParams[8] as string);
      expect(payload.due).toBe("2026-09-01T00:00:00Z");
      expect(payload.stability).toBe(3.5);
      expect(payload.difficulty).toBe(5.0);
      expect(payload.state).toBe(2);
      expect(payload.reps).toBe(1);
      expect(payload.elapsed_days).toBe(0);
    });

    it("rebuilds payload when nextPayload is null", async () => {
      const repo = new L2ProgressRepository();
      const querySpy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
      vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: "log-3" });
      await repo.saveL2Answer(makeInput({ nextPayload: null }));
      const updateParams = querySpy.mock.calls[0][1] as unknown[];
      const payload = JSON.parse(updateParams[8] as string);
      expect(payload.state).toBe(2);
    });

    it("throws when review log insert returns no row", async () => {
      const repo = new L2ProgressRepository();
      vi.spyOn(repo as any, "query").mockResolvedValue([]);
      vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
      await expect(repo.saveL2Answer(makeInput())).rejects.toThrow(/no id/);
    });
  });

  // ── updateProductionStatus / drill step 写方法 ────────────────────────
  describe("production status + drill step writes", () => {
    it("updateProductionStatus sets l2_production_status scoped by user+wordbook+word", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await repo.updateProductionStatus("user-1", "wb-1", "word-1", "passed");
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("l2_production_status = $4");
      expect(params).toEqual(["user-1", "wb-1", "word-1", "passed"]);
    });

    it("insertDrillStepIfAbsent returns inserted row on success", async () => {
      const repo = new L2ProgressRepository();
      const row = { id: "step-new", status: "pending", step_index: 0 };
      const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValueOnce(row);
      const result = await repo.insertDrillStepIfAbsent({
        session_id: "sess-1",
        user_id: "user-1",
        wordbook_id: "wb-1",
        word_id: "word-1",
        progress_id: "prog-1",
        step_index: 0,
        step_type: "l2_discrimination",
      });
      expect(result).toEqual(row);
      expect(spy).toHaveBeenCalledTimes(1); // 未走冲突回读
      const [sql] = spy.mock.calls[0] as [string];
      expect(sql).toContain("ON CONFLICT (session_id, word_id, step_index) DO NOTHING");
    });

    it("insertDrillStepIfAbsent throws when neither insert nor re-read returns a row", async () => {
      const repo = new L2ProgressRepository();
      vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
      await expect(
        repo.insertDrillStepIfAbsent({
          session_id: "sess-1",
          user_id: "user-1",
          wordbook_id: "wb-1",
          word_id: "word-1",
          progress_id: "prog-1",
          step_index: 0,
          step_type: "l2_discrimination",
        }),
      ).rejects.toThrow(/no row/);
    });

    it("findDrillStepForUpdate scopes by id+user_id with FOR UPDATE", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
      await repo.findDrillStepForUpdate("step-1", "user-1");
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("FOR UPDATE");
      expect(sql).toContain("user_id = $2::uuid");
      expect(params).toEqual(["step-1", "user-1"]);
    });

    it("findLastDrillStep orders by created_at/step_index desc and limits 1", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
      await repo.findLastDrillStep("sess-1", "user-1");
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("ORDER BY created_at DESC, step_index DESC");
      expect(sql).toContain("LIMIT 1");
      expect(params).toEqual(["sess-1", "user-1"]);
    });

    it("completeDrillStep updates status/outcome/mapped_rating/review_log_id", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await repo.completeDrillStep("step-1", "user-1", {
        outcome: "correct",
        mappedRating: "good",
        reviewLogId: "log-1",
      });
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("status = 'completed'");
      expect(sql).toContain("mapped_rating = $4");
      expect(params).toEqual(["step-1", "user-1", "correct", "good", "log-1"]);
    });

    it("skipDrillStep only updates pending rows", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await repo.skipDrillStep("step-1", "user-1");
      const [sql] = spy.mock.calls[0] as [string];
      expect(sql).toContain("status = 'skipped'");
      expect(sql).toContain("status = 'pending'");
    });

    it("deleteDrillStep deletes scoped by id+user_id", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await repo.deleteDrillStep("step-1", "user-1");
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("DELETE FROM l2_drill_session_steps");
      expect(params).toEqual(["step-1", "user-1"]);
    });
  });
});
