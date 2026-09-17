/**
 * ADR-0020 一键遗忘 · ReviewRepository SQL/参数契约（书级挂起 / 精确批次恢复）。
 *
 * 这些测试锁定的是"遗忘=挂起"的红线在 SQL 层的表达：绝不 DELETE、绝不改
 * stability、绝不推 due_at；批量挂起与恢复都按 (user, wordbook) 钉死作用域。
 */
import { describe, it, expect, vi } from "vitest";
import { ReviewRepository } from "@/repositories/review.repository";

describe("ReviewRepository · 一键遗忘（ADR-0020）", () => {
  describe("findForgettingPreviewRows", () => {
    it("JOIN words 取锚点元数据，numeric 归一并映射 recent_ratings/aliases", async () => {
      const repo = new ReviewRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([
        {
          word_id: "w1",
          state: "review",
          stability: "30.0000",
          retrievability: "0.950000",
          recent_ratings: ["good", "easy"],
          lapse_count: 2,
          morphology: "pre+dict",
          mnemonic: "预测=提前说",
          semantic_chain: "dict → predict",
          aliases: ["predicts"],
        },
        {
          word_id: "w2",
          state: "new",
          stability: null,
          retrievability: null,
          recent_ratings: null,
          lapse_count: null,
          morphology: null,
          mnemonic: null,
          semantic_chain: null,
          aliases: null,
        },
      ]);

      const rows = await repo.findForgettingPreviewRows("user-1", "wb-1");

      expect(rows).toEqual([
        {
          wordId: "w1",
          state: "review",
          stability: 30,
          retrievability: 0.95,
          recentRatings: ["good", "easy"],
          lapseCount: 2,
          morphology: "pre+dict",
          mnemonic: "预测=提前说",
          semanticChain: "dict → predict",
          aliases: ["predicts"],
        },
        {
          wordId: "w2",
          state: "new",
          stability: null,
          retrievability: null,
          recentRatings: [],
          lapseCount: 0,
          morphology: null,
          mnemonic: null,
          semanticChain: null,
          aliases: [],
        },
      ]);

      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("JOIN words w ON w.id = uwp.word_id");
      expect(sql).toContain("w.metadata->>'morphology_root'");
      expect(sql).toContain("w.metadata->>'mnemonic_text'");
      expect(sql).toContain("w.metadata->>'semantic_chain'");
      expect(sql).toContain("w.aliases");
      // 按书 scope + 只读（无写关键字）
      expect(sql).toContain("uwp.user_id = $1");
      expect(sql).toContain("uwp.wordbook_id = $2::uuid");
      expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
      expect(params).toEqual(["user-1", "wb-1"]);
    });

    it("空书 → 空数组", async () => {
      const repo = new ReviewRepository();
      vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await expect(repo.findForgettingPreviewRows("user-1", "wb-1")).resolves.toEqual([]);
    });
  });

  describe("countBulkSuspendCandidates", () => {
    it("计数条件与批量挂起完全一致，且 keepWordIds 作为 $3 传入", async () => {
      const repo = new ReviewRepository();
      const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ count: "7" });

      const count = await repo.countBulkSuspendCandidates({
        userId: "user-1",
        wordbookId: "wb-1",
        keepWordIds: ["keep-a", "keep-b"],
      });

      expect(count).toBe(7);
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("COUNT(*)");
      expect(sql).toContain("state NOT IN ('suspended', 'new')");
      expect(sql).toContain("word_id <> ALL($3::uuid[])");
      expect(sql).toContain("user_id = $1");
      expect(sql).toContain("wordbook_id = $2::uuid");
      expect(params).toEqual(["user-1", "wb-1", ["keep-a", "keep-b"]]);
    });

    it("无行时返回 0", async () => {
      const repo = new ReviewRepository();
      vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
      await expect(
        repo.countBulkSuspendCandidates({ userId: "user-1", wordbookId: "wb-1", keepWordIds: [] }),
      ).resolves.toBe(0);
    });
  });

  describe("bulkSuspendByWordbook", () => {
    it("单语句挂起非锚点行并写 rating=NULL 的 bulk_forget 日志（保真旧 state）", async () => {
      const repo = new ReviewRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([{ id: "log-1" }, { id: "log-2" }]);

      const affected = await repo.bulkSuspendByWordbook({
        userId: "user-1",
        wordbookId: "wb-1",
        keepWordIds: ["keep-a"],
        batchId: "batch-1",
      });

      expect(affected).toBe(2);
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      // 语义：只改 state（挂起），不删行、不改 stability、不推 due
      expect(sql).toContain("INSERT INTO review_logs");
      expect(sql).toContain("SET state = 'suspended'");
      expect(sql).not.toContain("DELETE");
      expect(sql).not.toContain("stability");
      expect(sql).not.toContain("due_at");
      // 候选条件
      expect(sql).toContain("state NOT IN ('suspended', 'new')");
      expect(sql).toContain("word_id <> ALL($3::uuid[])");
      expect(sql).toContain("user_id = $1");
      expect(sql).toContain("wordbook_id = $2::uuid");
      // rating 硬编码 NULL（非作答事件），metadata + 旧 state 快照
      expect(sql).toMatch(/NULL,\s*c\.previous_state/);
      expect(sql).toContain("jsonb_build_object('action', 'bulk_forget', 'batchId', $4::text)");
      expect(sql).toContain("jsonb_build_object('state', c.previous_state)");
      expect(sql).toContain("previous_progress_snapshot");
      expect(params).toEqual(["user-1", "wb-1", ["keep-a"], "batch-1"]);
    });

    it("无候选行 → 返回 0", async () => {
      const repo = new ReviewRepository();
      vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await expect(
        repo.bulkSuspendByWordbook({
          userId: "user-1",
          wordbookId: "wb-1",
          keepWordIds: [],
          batchId: "batch-1",
        }),
      ).resolves.toBe(0);
    });
  });

  describe("findBulkForgetBatch", () => {
    it("按 (user, wordbook, batchId) 定位 bulk_forget 日志", async () => {
      const repo = new ReviewRepository();
      const spy = vi.spyOn(repo as any, "queryOne").mockResolvedValue({ id: "log-1" });

      await expect(
        repo.findBulkForgetBatch({ userId: "user-1", wordbookId: "wb-1", batchId: "batch-1" }),
      ).resolves.toBe(true);

      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("FROM review_logs");
      expect(sql).toContain("metadata->>'action' = 'bulk_forget'");
      expect(sql).toContain("metadata->>'batchId' = $3");
      expect(sql).toContain("user_id = $1");
      expect(sql).toContain("wordbook_id = $2::uuid");
      expect(params).toEqual(["user-1", "wb-1", "batch-1"]);
    });

    it("未找到 → false", async () => {
      const repo = new ReviewRepository();
      vi.spyOn(repo as any, "queryOne").mockResolvedValue(null);
      await expect(
        repo.findBulkForgetBatch({ userId: "user-1", wordbookId: "wb-1", batchId: "missing" }),
      ).resolves.toBe(false);
    });
  });

  describe("restoreBulkForget", () => {
    it("只按本批次日志回写 state 快照，scope 钉死 (user, wordbook)", async () => {
      const repo = new ReviewRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([{ id: "p1" }, { id: "p2" }]);

      const restored = await repo.restoreBulkForget({
        userId: "user-1",
        wordbookId: "wb-1",
        batchId: "batch-1",
      });

      expect(restored).toBe(2);
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("UPDATE user_word_progress");
      expect(sql).toContain("rl.previous_progress_snapshot->>'state'");
      expect(sql).toContain("rl.metadata->>'action' = 'bulk_forget'");
      expect(sql).toContain("rl.metadata->>'batchId' = $3");
      // 跨书/跨用户误写防护：progress 侧同时钉 user + wordbook
      expect(sql).toContain("uwp.user_id = $1");
      expect(sql).toContain("uwp.wordbook_id = $2::uuid");
      // 只回写 state，不碰 stability/due
      expect(sql).not.toContain("stability");
      expect(sql).not.toContain("due_at");
      expect(params).toEqual(["user-1", "wb-1", "batch-1"]);
    });

    it("无匹配行 → 0", async () => {
      const repo = new ReviewRepository();
      vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await expect(
        repo.restoreBulkForget({ userId: "user-1", wordbookId: "wb-1", batchId: "batch-1" }),
      ).resolves.toBe(0);
    });
  });
});
