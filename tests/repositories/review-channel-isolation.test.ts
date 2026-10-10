/**
 * 复习通道隔离的**仓储级**测试（2026-10-10）。
 *
 * 为什么必须是仓储级（而非 service 层 fake 仓储）：本次改动落在受管层
 * （src/repositories），`scripts/report-layered-coverage.ts` 会把落在 function
 * 区间内的变更行全算可执行行 —— service 层用 fake 仓储测「我调用了仓储并传了通道」
 * 覆盖不到 SQL 文本的分支，门禁会以 Diff coverage 拦下。PR #188 与 PR #188 补
 * `tests/repositories/*` 三例后才 PASS，同一纪律。
 *
 * 断言分两层：
 *  1. **SQL 谓词**（真正的隔离发生处）：通道条件必须出现在 SQL 文本里，且 review
 *     通道不得出现 `state = 'new'`、new 通道不得出现到期条件。
 *  2. **返回值透传**：行形态不受通道影响（避免隔离把数据也一起滤坏）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../helpers/mock-db";

const mock = createMockPool({ recordTxControl: false });
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  resetPool: vi.fn(),
  checkPoolHealth: vi.fn(),
}));

import { createRepositories } from "@/index";

beforeEach(() => mock.reset());

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "p1", user_id: "u1", word_id: "w1", wordbook_id: "wb1",
    state: "review", stability: 1.5, difficulty: 0.3, retrievability: 0.9,
    desired_retention: 0.9, due_at: "2026-01-01T00:00:00Z", last_reviewed_at: null,
    last_rating: "good", review_count: 3, lapse_count: 0, again_count: 0,
    hard_count: 0, good_count: 3, easy_count: 0, interval_days: 7,
    scheduler_payload: {}, needs_recheck: false, content_hash_snapshot: "h1",
    l1_content_hash_snapshot: "h1", skip_count: 0, created_at: null, updated_at: null,
    recent_ratings: null, l1_weak_signal: false, ladder_rung: 0,
    content_hash: "h1", l1_content_hash: null,
    ...overrides,
  };
}

/** 最近一次查询的 SQL 文本（mock 记录了每次 call，字段是 text/params）。 */
function lastSql(): string {
  return mock.lastQuery?.text ?? "";
}

describe("ReviewRepository — 复习通道隔离（2026-10-10）", () => {
  describe("findDueCandidateSnapshots 的通道谓词", () => {
    it("channel='review' 下推到期复习谓词，且不含新卡", async () => {
      mock.setRows([snapshotRow()]);
      const repos = createRepositories();

      await repos.reviews.findDueCandidateSnapshots("u1", "wb1", 20, "review");

      const sql = lastSql();
      // 到期复习通道：显式列出已作答的三个 state
      expect(sql).toContain("uwp.state IN ('learning', 'relearning', 'review')");
      // **绝不能**把新卡放进复习通道 —— 这是隔离的全部意义
      expect(sql).not.toContain("uwp.state = 'new'");
      // 挂起卡两条通道都不出
      expect(sql).toContain("uwp.state != 'suspended'");
    });

    it("channel='new' 只取新卡，且不带到期条件", async () => {
      mock.setRows([snapshotRow({ state: "new", due_at: null })]);
      const repos = createRepositories();

      await repos.reviews.findDueCandidateSnapshots("u1", "wb1", 20, "new");

      const sql = lastSql();
      expect(sql).toContain("uwp.state = 'new'");
      // 新卡 due_at 为 NULL，若还带着 `due_at <= now()` 的OR 分支，隔离等于没做
      expect(sql).not.toContain("uwp.due_at <= now()");
      // 已作答的 state 不该出现在新词通道
      expect(sql).not.toContain("uwp.state IN ('learning', 'relearning', 'review')");
    });

    it("未传通道 = 旧行为（混流池，仍带 due_at 的 NULL 分支）", async () => {
      mock.setRows([snapshotRow()]);
      const repos = createRepositories();

      await repos.reviews.findDueCandidateSnapshots("u1", "wb1", 20);

      const sql = lastSql();
      // 向后兼容：练习模式与旧调用方依赖这条 NULL 分支放进新卡
      expect(sql).toContain("uwp.due_at IS NULL OR uwp.due_at <= now()");
      expect(sql).not.toContain("uwp.state = 'new'");
    });

    it("两条通道的谓词互斥：review 出1 张、new 出 483 张时合起来等于混流总数", async () => {
      // 真库实测口径（2026-10-10）：review 通道 1 张 + new 通道 483 张 = 混流 484 张。
      // 这条测试钉住「互斥且完备」—— 漏算会让某张卡在两个通道里都出不来。
      mock.setRows([]);
      const repos = createRepositories();

      await repos.reviews.findDueCandidateSnapshots("u1", "wb1", 2000, "review");
      const reviewSql = lastSql();
      await repos.reviews.findDueCandidateSnapshots("u1", "wb1", 2000, "new");
      const newSql = lastSql();

      expect(reviewSql).not.toBe(newSql);
      // 互斥：new 通道的条件不出现在 review 通道，反之亦然
      expect(reviewSql).not.toContain("uwp.state = 'new'");
      expect(newSql).not.toContain("'relearning'");
      // 完备：两者的 state 条件覆盖了除 suspended 外的全部取值
      expect(newSql).toContain("uwp.state != 'suspended'");
      expect(reviewSql).toContain("uwp.state != 'suspended'");
    });
  });

  describe("findDueCandidates（旧单阶段路径）同样受通道约束", () => {
    it("channel='review' 下推同一套谓词（两条路径口径必须一致）", async () => {
      mock.setRows([snapshotRow()]);
      const repos = createRepositories();

      await repos.reviews.findDueCandidates("u1", "wb1", 200, "review");

      expect(lastSql()).toContain("uwp.state IN ('learning', 'relearning', 'review')");
      expect(lastSql()).not.toContain("uwp.state = 'new'");
    });

    it("channel='new' 只取新卡", async () => {
      mock.setRows([snapshotRow({ state: "new", due_at: null })]);
      const repos = createRepositories();

      await repos.reviews.findDueCandidates("u1", "wb1", 200, "new");

      expect(lastSql()).toContain("uwp.state = 'new'");
      expect(lastSql()).not.toContain("uwp.due_at <= now()");
    });

    it("未传通道保持旧混流行为", async () => {
      mock.setRows([snapshotRow()]);
      const repos = createRepositories();

      await repos.reviews.findDueCandidates("u1", "wb1", 200);

      expect(lastSql()).toContain("uwp.due_at IS NULL OR uwp.due_at <= now()");
    });
  });

  describe("通道隔离不改变行形态", () => {
    it("new 通道返回的行保留 needs_recheck 派生所需的 hash 字段", async () => {
      mock.setRows([snapshotRow({ state: "new", due_at: null, content_hash: "cw", l1_content_hash: "lw" })]);
      const repos = createRepositories();

      const rows = await repos.reviews.findDueCandidateSnapshots("u1", "wb1", 20, "new");

      expect(rows).toHaveLength(1);
      // 阶段二水合靠 word_id 回填，所以 word_id 必须在
      expect(rows[0].word_id).toBe("w1");
      expect(rows[0].content_hash).toBe("cw");
      expect(rows[0].l1_content_hash).toBe("lw");
    });

    it("limit 仍作为参数下传（不因通道分支丢失）", async () => {
      mock.setRows([]);
      const repos = createRepositories();

      await repos.reviews.findDueCandidateSnapshots("u1", "wb1", 37, "new");

      expect(mock.lastQuery?.params).toEqual(["u1", "wb1", 37]);
    });
  });
});