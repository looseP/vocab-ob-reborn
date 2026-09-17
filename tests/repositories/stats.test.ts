/**
 * StatsRepository.getDashboardStats — 双轨统计映射的单元覆盖。
 *
 * 重点：l2Row（promoted/dueNow/weakSignal/reviewedToday 四标量子查询）存在与缺失
 * 两条路径，以及 NULL 行回退 0（l2Row ? parseInt(...) : 0 三元分支）。
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
    // streak 查询返回 streak_days（而非 count）；先于通用 review_logs 键匹配。
    "streak_days": [{ streak_days: 5 }],
    "FROM review_logs": [{ count: "5" }],
    "FROM note_entries": [{ count: "7" }],
    "FROM words WHERE": [{ count: "1000" }],
  });
  mock.setRows([]);
}

describe("StatsRepository.getDashboardSummary", () => {
  it("maps the l2 subquery row (promoted/dueNow/weakSignal/reviewedToday) when present", async () => {
    mapStandardQueries([{ promoted: "12", due_now: "3", weak_signal: "4", l2_reviewed_today: "6" }]);
    const repos = createRepositories();

    const summary = await repos.stats.getDashboardSummary("u1", "wb1");

    expect(summary.l2).toEqual({ promoted: 12, dueNow: 3, weakSignal: 4, reviewedToday: 6 });
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

    expect(summary.l2).toEqual({ promoted: 0, dueNow: 0, weakSignal: 0, reviewedToday: 0 });
  });

  it("maps the three review-window answer counters", async () => {
    // reviewedToday 走通用 "FROM review_logs" 键；7d/30d 先命中 interval 键。
    mapStandardQueries([{ promoted: "12", due_now: "3", weak_signal: "4", l2_reviewed_today: "6" }]);
    const repos = createRepositories();

    const summary = await repos.stats.getDashboardSummary("u1", "wb1");

    expect(summary.reviewedToday).toBe(5);
    expect(summary.reviewed7d).toBe(10);
    expect(summary.reviewed30d).toBe(40);
    // 活动口径：streak 仍按"有日志的天数"计（同 row-map 命中 5）
    expect(summary.streakDays).toBe(5);
  });

  it("falls back to zeros when every dashboard query returns no row", async () => {
    // 覆盖 8 条 queryOne 的 `? parseInt(...) : 0` 空行回退臂（含 streak 的 false 臂）。
    mock.setRowMap({});
    mock.setRows([]);
    const repos = createRepositories();

    const summary = await repos.stats.getDashboardSummary("u1", "wb1");

    expect(summary).toEqual({
      totalWords: 0,
      trackedWords: 0,
      dueToday: 0,
      reviewedToday: 0,
      reviewed7d: 0,
      reviewed30d: 0,
      streakDays: 0,
      notesCount: 0,
      l2: { promoted: 0, dueNow: 0, weakSignal: 0, reviewedToday: 0 },
    });
  });

  it("locks the answer/activity split: window counters filter rating, streak does not", async () => {
    mapStandardQueries([{ promoted: "12", due_now: "3", weak_signal: "4", l2_reviewed_today: "6" }]);
    const repos = createRepositories();

    await repos.stats.getDashboardSummary("u1", "wb1");

    const logQueries = mock.calls
      .map((call) => call.text)
      .filter((text) => text.includes("FROM review_logs"));

    // 作答口径：三个窗口计数（顶层 count(*)）各带 rating IS NOT NULL
    // （非作答事件如 L2 seed 不计入）。排除 l2 子查询——它也含 count(*) FROM review_logs。
    const counterQueries = logQueries.filter(
      (text) => text.includes("count(*) FROM review_logs") && !text.includes("user_word_l2_progress"),
    );
    expect(counterQueries).toHaveLength(3);
    for (const sql of counterQueries) {
      expect(sql).toContain("rating IS NOT NULL");
    }

    // 活动口径（streakDays）：按显示时区切日，且**故意不过滤** rating
    const streakQueries = logQueries.filter((text) => text.includes("review_day"));
    expect(streakQueries).toHaveLength(1);
    expect(streakQueries[0]).toContain("AT TIME ZONE");
    expect(streakQueries[0]).not.toContain("rating IS NOT NULL");
  });

  it("computes the L2-only today counter inside the l2 subquery (book-scoped)", async () => {
    mapStandardQueries([{ promoted: "12", due_now: "3", weak_signal: "4", l2_reviewed_today: "6" }]);
    const repos = createRepositories();

    const summary = await repos.stats.getDashboardSummary("u1", "wb1");
    expect(summary.l2.reviewedToday).toBe(6);

    const l2Query = mock.calls.find((call) => call.text.includes("l2_reviewed_today"))!;
    // L2-only 作答口径（CONTEXT.md「Counter scope」）：按书、今日、仅 L2 作答。
    expect(l2Query.text).toContain("track = 'l2'");
    expect(l2Query.text).toContain("rating IS NOT NULL");
    expect(l2Query.text).toContain("wordbook_id = $2::uuid");
    expect(l2Query.text).toContain("reviewed_at >= $3");
    // 与全轨 reviewedToday 复用同一 Asia/Shanghai 日界变量（todayIso = $3）。
    expect(typeof l2Query.params[2]).toBe("string");
    expect(l2Query.params[2]).toMatch(/^\d{4}-\d{2}-\d{2}T16:00:00\.000Z$/);
  });
});

describe("StatsRepository.getRatingDistribution", () => {
  it("maps the four known ratings and ignores unknown / NULL rating rows", async () => {
    const repos = createRepositories();
    mock.setRows([
      { rating: "again", count: "1" },
      { rating: "good", count: "4" },
      { rating: "unknown", count: "2" },
      { rating: null, count: "1" },
    ]);

    await expect(repos.stats.getRatingDistribution("u1", "wb1")).resolves.toEqual({
      again: 1, hard: 0, good: 4, easy: 0,
    });

    const q = mock.lastQuery!;
    expect(q.text).toContain("AND rating IS NOT NULL");
    expect(q.text).toContain("GROUP BY rating");
  });
});
