/**
 * 队列全景读面的**仓储级**测试（countQueueBuckets + listQueueCards，2026-10-10）。
 *
 * 为什么必须仓储级：这两个方法在受管层 `src/repositories/review.repository.ts`
 * 合计约 75 行可执行变更，是本次 diff coverage 缺口的主体
 * （PR #220 第三轮 CI：290/432 = 67.13% < 85%）。
 *
 * 为什么这两个方法值得真仓储测试（而不只看service 层）：
 *  1. **桶谓词白名单是安全边界** —— `QUEUE_BUCKET_PREDICATE` 必须挡住用户输入，
 *     拼进 SQL 就是注��。仓储测试能直接断言 SQL 文本里出现了哪些谓词；
 *  2. **计数的 NULL 归一化** —— `COUNT(*) FILTER (...)` 在无匹配时返回 0 而非 NULL，
 *     但 `queryOne` 无行时 row 是 undefined ⇒ count() 必须兜住，否则仪表盘出NaN
 *     （这个坑本仓踩过：getDashboardSummary 出过 NaN）；
 *  3. **needsRecheck 的双来源派生** —— 行上人工标记 || 内容陈旧度（ADR-0021），
 *     service 层 fake 仓储看不出派生是否与候选队列同口径。
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

function countRow(overrides: Record<string, string> = {}) {
  return {
    total: "5",
    suspended: "1",
    new_count: "3",
    learning: "0",
    due: "1",
    review: "1",
    due_now: "1",
    ...overrides,
  };
}

function listRow(overrides: Record<string, unknown> = {}) {
  return {
    state: "review",
    due_at: "2026-01-01T00:00:00Z",
    review_count: 3,
    lapse_count: 0,
    stability: 2.5,
    interval_days: 7,
    last_reviewed_at: "2025-12-25T00:00:00Z",
    last_rating: "good",
    needs_recheck: false,
    content_hash_snapshot: "h1",
    l1_content_hash_snapshot: "l1-1",
    w_id: "w-1",
    slug: "abound",
    title: "Abound",
    lemma: "abound",
    short_definition: "exist in large numbers",
    pos: "verb",
    cefr: "C1",
    content_hash: "h1",
    l1_content_hash: "l1-1",
    total_count: "42",
    ...overrides,
  };
}

function repo() {
  return createRepositories().reviews;
}

describe("countQueueBuckets — 队列桶计数", () => {
  it("把 SQL 的 snake_case 列名映射成前端要的 camelCase", async () => {
    mock.setRows([countRow()]);

    const counts = await repo().countQueueBuckets("u1", "wb1");

    expect(counts).toEqual({
      due: 1,
      learning: 0,
      review: 1,
      new: 3,       // 来自 new_count
      suspended: 1,
      dueNow: 1,   // 来自 due_now = 「现在就该复习」的张数
      total: 5,
    });
  });

  it("无行时全部归零（不返回 NaN）", async () => {
    // 回归防线：queryOne 无行时 row 是 undefined，若直接 parseInt(undefined)
    // ⇒ NaN 渗进 JSON ⇒ 前端计数显示「NaN 张」。本仓踩过同类坑（dashboard summary）。
    mock.setRows([]);

    const counts = await repo().countQueueBuckets("u1", "wb1");

    expect(counts).toEqual({
      due: 0, learning: 0, review: 0, new: 0, suspended: 0, dueNow: 0, total: 0,
    });
    for (const value of Object.values(counts)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("列值为 NULL 时归零（COUNT FILTER 在无匹配时可能给 NULL）", async () => {
    mock.setRows([countRow({ due: null as unknown as string, new_count: null as unknown as string })]);

    const counts = await repo().countQueueBuckets("u1", "wb1");

    expect(counts.due).toBe(0);
    expect(counts.new).toBe(0);
  });

  it("脏值（非数字）归零而不是 NaN", async () => {
    mock.setRows([countRow({ total: "abc", due: "" })]);

    const counts = await repo().countQueueBuckets("u1", "wb1");

    expect(counts.total).toBe(0);
    expect(counts.due).toBe(0);
  });

  it("dueNow 只算非挂起非新卡的到期卡（新卡 due_at 为 NULL，不算「该复习」）", async () => {
    // 这是通道隔离的数据基础：dueNow 就是 review 通道该出的张数。
    // 真库实测 2026-10-10：dueNow=1 而 new=483。
    mock.setRows([countRow({ due_now: "1", new_count: "483", total: "484" })]);

    const counts = await repo().countQueueBuckets("u1", "wb1");

    expect(counts.dueNow).toBe(1);
    expect(counts.new).toBe(483);
    expect(counts.dueNow).toBeLessThan(counts.new);
  });
});

describe("listQueueCards — 队列清单分页", () => {
  const base = {
    userId: "u1",
    wordbookId: "wb1",
    bucket: "all" as const,
    search: null,
    limit: 50,
    offset: 0,
  };

  it("bucket=all 不加桶谓词（走全量）", async () => {
    mock.setRows([listRow()]);

    const result = await repo().listQueueCards(base);

    expect(result.items).toHaveLength(1);
    // all ⇒ predicate 为 null ⇒ WHERE 里不该有桶过滤。
    // 注意别用 `uwp.state =` 泛化断言：排序键里有
    // `CASE WHEN uwp.state = 'suspended' THEN 1 ...` 会误命中。
    const where = (mock.lastQuery?.text ?? "").split("WHERE")[1]?.split("ORDER BY")[0] ?? "";
    expect(where).not.toMatch(/uwp\.state\s*(=|IN)/);
  });

  it("具体桶用模块级白名单谓词下推（绝不拼用户输入）", async () => {
    mock.setRows([listRow()]);

    await repo().listQueueCards({ ...base, bucket: "suspended" });

    const sql = mock.lastQuery?.text ?? "";
    expect(sql).toContain("uwp.state = 'suspended'");
    // 搜索词必须走参数位，不能内联进 SQL
    expect(sql).not.toContain("undefined");
    expect(mock.lastQuery?.params?.[2]).toBeNull();
  });

  it("搜索走 ILIKE 参数位 + ESCAPE（LIKE 通配符转义在 service 层做）", async () => {
    mock.setRows([listRow()]);

    await repo().listQueueCards({ ...base, search: "ab" });

    const sql = mock.lastQuery?.text ?? "";
    expect(sql).toContain("ILIKE");
    expect(sql).toContain("ESCAPE");
    expect(mock.lastQuery?.params?.[2]).toBe("ab");
  });

  it("排序带 lemma ASC 稳定 tiebreak（否则翻页会重复/漏行）", async () => {
    mock.setRows([listRow()]);

    await repo().listQueueCards(base);

    const sql = mock.lastQuery?.text ?? "";
    // due_at / review_count 大量并列，缺稳定 tiebreak 时同一批卡会在两页各出现一次。
    // 断言最后一个排序键（SQL 末尾是 LIMIT $4 OFFSET $5，不是 ORDER BY 结尾）。
    const orderBy = sql.split("ORDER BY")[1]?.split("LIMIT")[0] ?? "";
    expect(orderBy).toContain("w.lemma ASC");
    expect(orderBy.trim().endsWith("w.lemma ASC")).toBe(true);
  });

  it("count(*) OVER() 的总数取自首行，且是过滤后的总数", async () => {
    mock.setRows([listRow({ total_count: "137" }), listRow({ total_count: "137" })]);

    const result = await repo().listQueueCards(base);

    expect(result.total).toBe(137);
  });

  it("无行时 total 为 0（不把parseInt(undefined) 变成 NaN）", async () => {
    mock.setRows([]);

    const result = await repo().listQueueCards(base);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(Number.isFinite(result.total)).toBe(true);
  });

  it("行映射：snake_case 列转 camelCase，数值列走可空解析", async () => {
    mock.setRows([listRow({ stability: null, interval_days: null })]);

    const result = await repo().listQueueCards(base);

    const item = result.items[0];
    expect(item.wordId).toBe("w-1");
    expect(item.lemma).toBe("abound");
    expect(item.shortDefinition).toBe("exist in large numbers");
    expect(item.reviewCount).toBe(3);
    // 可空数值列：DB 给 NULL 时应是 null 而非 NaN（NaN 会让 UI 显示「NaN 天」）
    expect(item.stability).toBeNull();
    expect(item.intervalDays).toBeNull();
  });

  it("needsRecheck 取「行上标记 || 内容陈旧度派生」两来源的或", async () => {
    mock.setRows([
      listRow({ needs_recheck: true, w_id: "w-flag" }),
      listRow({ needs_recheck: false, w_id: "w-clean" }),
      // 内容已变（快照 hash ≠ 现值）⇒ 即便行上没标记，也要派生为 true
      listRow({
        needs_recheck: false,
        w_id: "w-stale",
        content_hash_snapshot: "old-h",
        content_hash: "new-h",
        l1_content_hash_snapshot: "old-l1",
        l1_content_hash: "new-l1",
      }),
    ]);

    const result = await repo().listQueueCards(base);

    const byId = new Map(result.items.map((i) => [i.wordId, i.needsRecheck]));
    expect(byId.get("w-flag")).toBe(true);   // 行上人工标记
    expect(byId.get("w-clean")).toBe(false);  // 无标记且内容未变
    expect(byId.get("w-stale")).toBe(true);   // 派生：内容陈旧需重看
  });

  it("limit/offset 作为参数下传（不内联）", async () => {
    mock.setRows([]);

    await repo().listQueueCards({ ...base, limit: 25, offset: 50 });

    expect(mock.lastQuery?.params?.slice(0, 5)).toEqual(["u1", "wb1", null, 25, 50]);
  });
});