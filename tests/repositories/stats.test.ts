/**
 * StatsRepository.getDashboardStats — 双轨统计映射的单元覆盖。
 *
 * 重点：l2Row（promoted/dueNow/weakSignal 三标量子查询）存在与缺失两条路径，
 * 以及 NULL 行回退 0（l2Row ? parseInt(...) : 0 三元分支）。
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

/** map 顺序即匹配优先级：specific → generic；未命中的走空 nextRows。 */
function mapStandardQueries(l2Row: unknown[] | null) {
  mock.setRowMap({
    ...(l2Row ? { "FROM user_word_l2_progress": l2Row } : {}),
    "l1_weak_signal": [{ count: "3" }],
    "due_at IS NOT NULL AND due_at <= now()": [{ count: "2" }],
    "interval '7 days'": [{ count: "10" }],
    "interval '30 days'": [{ count: "40" }],
    "FROM user_word_progress": [{ count: "25" }],
    "FROM review_logs": [{ count: "5" }],
    "FROM notes": [{ count: "7" }],
    "FROM words WHERE": [{ count: "1000" }],
  });
  mock.setRows([]);
}

describe("StatsRepository.getDashboardSummary", () => {
  it("maps the l2 subquery row (promoted/dueNow/weakSignal) when present", async () => {
    mapStandardQueries([{ promoted: "12", due_now: "3", weak_signal: "4" }]);
    const repos = createRepositories();

    const summary = await repos.stats.getDashboardSummary("u1", "wb1");

    expect(summary.l2).toEqual({ promoted: 12, dueNow: 3, weakSignal: 4 });
    expect(summary.totalWords).toBe(1000);
    expect(summary.trackedWords).toBe(25);
    expect(summary.notesCount).toBe(7);
  });

  it("falls back to zeros when the l2 subquery returns no row", async () => {
    // 注意：l2 SQL 含子串 "due_at IS NOT NULL AND due_at <= now()"，必须
    // 显式映射 l2 键为空行（不能省略），否则会被 due 统计的行污染。
    mapStandardQueries([]);
    const repos = createRepositories();

    const summary = await repos.stats.getDashboardSummary("u1", "wb1");

    expect(summary.l2).toEqual({ promoted: 0, dueNow: 0, weakSignal: 0 });
  });
});
