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
    "due_at IS NOT NULL AND due_at <= now()": [{ due_count: "2", mastered_count: "5" }],
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
      masteredWords: 0,
      dueToday: 0,
      reviewedToday: 0,
      reviewed7d: 0,
      reviewed30d: 0,
      streakDays: 0,
      notesCount: 0,
      l2: { promoted: 0, dueNow: 0, weakSignal: 0, reviewedToday: 0 },
    });
  });

  it("进度查询同时出「今天待复习」与「已掌握」，且排除挂起词（D4 + 真口径）", async () => {
    // 2026-10-07 仪表盘深度优化：此前 dueToday 不过滤 suspended（队列却排除 ⇒ 同一件事
    // 两个数），而「已掌握」由前端用 totalWords - dueToday 硬算（实测 6754 vs 真值 14）。
    mapStandardQueries([{ promoted: "12", due_now: "3", weak_signal: "4", l2_reviewed_today: "6" }]);
    const repos = createRepositories();

    const summary = await repos.stats.getDashboardSummary("u1", "wb1");

    // 两个指标由**同一条**查询出（并行调用数不变：8 + streak）
    const progressQueries = mock.calls.filter((c) => c.text.includes("user_word_progress") && c.text.includes("FILTER"));
    expect(progressQueries).toHaveLength(1);
    const sql = progressQueries[0].text;
    expect(sql).toContain("state <> 'suspended'");
    expect(sql).toContain("state = 'review'");

    expect(summary.dueToday).toBe(2);
    expect(summary.masteredWords).toBe(5);
    // 「已掌握」绝不能等于「总数 − 今天到期」那种假口径
    expect(summary.masteredWords).not.toBe(summary.totalWords - summary.dueToday);
  });

  describe("日历两查询（M2）", () => {
  it("getDailyDueCounts：分桶映射 + 带回今天键；SQL 排除挂起、积压并入今天", async () => {
    mock.setRowMap({
      "FROM user_word_progress": [
        { date: "2026-10-08", count: "14" },
        { date: "2026-10-09", count: "3" },
      ],
    });
    mock.setRows([]);
    const repos = createRepositories();

    const result = await repos.stats.getDailyDueCounts("u1", "wb1", 30);

    expect(result.todayDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.buckets).toEqual([
      { date: "2026-10-08", count: 14 },
      { date: "2026-10-09", count: 3 },
    ]);
    const sql = mock.lastQuery!.text;
    expect(sql).toContain("state <> 'suspended'");       // 与队列同口径
    expect(sql).toContain("greatest(");                    // 积压并入「今天」
    expect(sql).toContain("make_interval");                // 日历日窗口（非滚动 N×24h）
  });

  it("getDayWords（due）：行映射 + total 取自窗口函数（与 LIMIT 无关）", async () => {
    mock.setRowMap({
      "uwp.due_at IS NOT NULL": [
        { id: "w1", slug: "abide", title: "abide", lemma: "abide", short_definition: "遵守", total: "9" },
      ],
    });
    mock.setRows([]);
    const repos = createRepositories();

    const result = await repos.stats.getDayWords("u1", "wb1", "2026-10-08", "due", 50);

    expect(result.total).toBe(9);
    expect(result.items).toEqual([
      { id: "w1", slug: "abide", title: "abide", lemma: "abide", shortDefinition: "遵守" },
    ]);
    expect(mock.lastQuery!.text).toContain("JOIN words w ON w.id = uwp.word_id");
  });

  it("getDayWords（reviewed）：按词去重的子查询分支", async () => {
    mock.setRowMap({
      "DISTINCT rl.word_id": [
        { id: "w2", slug: "ample", title: "ample", lemma: "ample", short_definition: null, total: "1" },
      ],
    });
    mock.setRows([]);
    const repos = createRepositories();

    const result = await repos.stats.getDayWords("u1", "wb1", "2026-10-07", "reviewed", 50);

    expect(result.total).toBe(1);
    expect(result.items[0].shortDefinition).toBeNull();
    expect(mock.lastQuery!.text).toContain("DISTINCT rl.word_id");
  });

  it("getDayWords：零行时 total=0（不 NaN）", async () => {
    mock.setRowMap({});
    mock.setRows([]);
    const repos = createRepositories();

    const result = await repos.stats.getDayWords("u1", "wb1", "2026-10-08", "due", 50);

    expect(result).toEqual({ total: 0, items: [] });
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

describe("StatsRepository.getDueForecast（M1 真实到期预测）", () => {
  it("把 horizon 行映射为 {horizonDays,count}（count 走 parseInt）", async () => {
    const repos = createRepositories();
    mock.setRows([
      { horizon_days: 7, count: "18" },
      { horizon_days: 14, count: "24" },
    ]);

    await expect(repos.stats.getDueForecast("u1", "wb1", [7, 14])).resolves.toEqual([
      { horizonDays: 7, count: 18 },
      { horizonDays: 14, count: 24 },
    ]);
  });

  it("单条往返，且三条口径都在 SQL 里：日历日上沿 / 累计无下沿 / 排除 suspended", async () => {
    const repos = createRepositories();
    mock.setRows([{ horizon_days: 7, count: "0" }]);

    await repos.stats.getDueForecast("u1", "wb1", [7, 14]);

    const q = mock.lastQuery!;
    // 单条往返：一次 unnest 出全部 horizon（不是每个 horizon 一发）
    expect(mock.calls).toHaveLength(1);
    expect(q.text).toContain("FROM unnest($4::int[])");
    expect(q.text).toContain("ORDER BY h.horizon_days");

    // ① 上沿 = 今天零点 + horizon 天（日历日，非滚动 168 小时）
    expect(q.text).toContain("make_interval(days => h.horizon_days)");
    // ② **不设下沿**：加 `due_at > 今天零点` 会把积压排除 —— 实测自用栈会得出
    //    due7d=0 而 dueNow=14（「未来 7 天」比「今天」还少）。这条断言锁住该决定。
    expect(q.text).not.toMatch(/due_at\s*>/);
    // ③ 排除挂起词（复习队列一律 state != 'suspended'，预测算上它们是虚报）
    expect(q.text).toContain("state <> 'suspended'");
    expect(q.text).toContain("due_at IS NOT NULL");

    // 日界复用显示时区今日零点（与 dueToday / reviewedToday 同源）
    expect(q.params[2]).toMatch(/^\d{4}-\d{2}-\d{2}T16:00:00\.000Z$/);
    expect(q.params[0]).toBe("u1");
    expect(q.params[1]).toBe("wb1");
    expect(q.params[3]).toEqual([7, 14]);
  });

  it("无桶行 → 空数组（该窗口确实没有到期词，由 service 按 0 计而不是回落推算）", async () => {
    const repos = createRepositories();
    mock.setRows([]);

    await expect(repos.stats.getDueForecast("u1", "wb1", [7])).resolves.toEqual([]);
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
