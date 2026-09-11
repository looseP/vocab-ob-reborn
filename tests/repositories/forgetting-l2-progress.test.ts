/**
 * ADR-0020 一键遗忘 · L2ProgressRepository 书级批量暂停/恢复 SQL 契约。
 */
import { describe, it, expect, vi } from "vitest";
import { L2ProgressRepository } from "@/repositories/l2-progress.repository";

describe("L2ProgressRepository · 一键遗忘（ADR-0020）", () => {
  describe("batchPauseByWordbook", () => {
    it("书内非锚点行置 manual 暂停，不触碰 stability/due", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([{ id: "p1" }, { id: "p2" }]);

      const affected = await repo.batchPauseByWordbook({
        userId: "user-1",
        wordbookId: "wb-1",
        keepWordIds: ["keep-a"],
      });

      expect(affected).toBe(2);
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("UPDATE user_word_l2_progress");
      expect(sql).toContain("l2_paused = true");
      expect(sql).toContain("l2_paused_at = now()");
      expect(sql).toContain("l2_paused_reason = 'manual'");
      expect(sql).toContain("word_id <> ALL($3::uuid[])");
      expect(sql).toContain("user_id = $1");
      expect(sql).toContain("wordbook_id = $2::uuid");
      // 红线：遗忘=挂起，不重置 stability、不推 due
      expect(sql).not.toContain("l2_stability");
      expect(sql).not.toContain("l2_due_at");
      expect(params).toEqual(["user-1", "wb-1", ["keep-a"]]);
    });

    it("keepWordIds 为空数组时仍传参（挂起全书非暂停行）", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await repo.batchPauseByWordbook({ userId: "user-1", wordbookId: "wb-1", keepWordIds: [] });
      const params = spy.mock.calls[0][1] as unknown[];
      expect(params[2]).toEqual([]);
    });
  });

  describe("batchUnpauseManual", () => {
    it("只 unpause manual 暂停，回到 l2_due_at=now()", async () => {
      const repo = new L2ProgressRepository();
      const spy = vi.spyOn(repo as any, "query").mockResolvedValue([{ id: "p1" }]);

      const affected = await repo.batchUnpauseManual("user-1", "wb-1");

      expect(affected).toBe(1);
      const [sql, params] = spy.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("l2_paused = false");
      expect(sql).toContain("l2_paused_at = NULL");
      expect(sql).toContain("l2_paused_reason = NULL");
      expect(sql).toContain("l2_due_at = now()");
      expect(sql).toContain("user_id = $1");
      expect(sql).toContain("wordbook_id = $2::uuid");
      // 只恢复本功能的 manual 暂停，不动 l1_cascade_failure 等其他原因
      expect(sql).toContain("l2_paused_reason = 'manual'");
      expect(params).toEqual(["user-1", "wb-1"]);
    });

    it("无匹配行 → 0", async () => {
      const repo = new L2ProgressRepository();
      vi.spyOn(repo as any, "query").mockResolvedValue([]);
      await expect(repo.batchUnpauseManual("user-1", "wb-1")).resolves.toBe(0);
    });
  });
});
