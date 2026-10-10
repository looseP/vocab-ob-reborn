/**
 * DailyCaptureRepository 单测（mock Pool，锁 SQL 形状 —— 同 review-cards 先例）。
 *
 * 锁的口径：
 *  - seed 幂等：单条 INSERT + ON CONFLICT (user_id, type_key) DO NOTHING；
 *  - 追加：INSERT..SELECT coalesce(max(seq),0)+1 单语句原子分配（唯一索引兜底）；
 *    meta 序列化为 jsonb 参数（null 保持 null）；
 *  - 读面：当日列表 hidden_at IS NULL + seq 升序；日聚合带 reviewed/absorbed FILTER 计数。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockPool } from "../helpers/mock-db";

// Mock the connection BEFORE importing repositories
const mock = createMockPool();
vi.mock("@/db/connection", () => ({
  getPool: () => mock.pool,
  checkPoolHealth: vi.fn(),
  resetPool: vi.fn(),
}));

import { createRepositories } from "@/index";
import { todayEntryDateKey, formatEntryClock } from "@/repositories/daily-capture.repository";

const tx = { query: mock.pool.query } as never;
const repos = createRepositories(tx);
const USER = "11111111-1111-4111-8111-111111111111";

describe("DailyCaptureRepository.ensureDefaultTypes（幂等 seed）", () => {
  beforeEach(() => mock.reset());

  it("单条语句 seed 六类，冲突不覆盖（ON CONFLICT DO NOTHING）", async () => {
    await repos.dailyCapture.ensureDefaultTypes(USER);

    expect(mock.calls.length).toBe(1);
    const seed = mock.lastQuery!;
    expect(seed.text).toContain("INSERT INTO daily_capture_types");
    expect(seed.text).toContain("ON CONFLICT (user_id, type_key) DO NOTHING");
    // user_id + 6 行 × 4 值（type_key/label/absorption_hint/sort）= 25 个参数
    expect(seed.params).toHaveLength(25);
    expect(seed.params[0]).toBe(USER);
    expect(seed.params.slice(1)).toContain("phrase");
    expect(seed.params.slice(1)).toContain("note");
  });
});

describe("DailyCaptureRepository.insertEntry（seq 原子分配）", () => {
  beforeEach(() => mock.reset());

  it("INSERT..SELECT coalesce(max,0)+1 单语句；meta 序列化为 jsonb", async () => {
    mock.setRows([
      { id: "e-1", user_id: USER, entry_date: "2026-10-10", seq: 3, entry_type: "phrase", content: "x", meta: null, status: "raw", created_at: "2026-10-10T01:00:00Z", hidden_at: null },
    ]);

    const row = await repos.dailyCapture.insertEntry({
      user_id: USER,
      entry_date: "2026-10-10",
      entry_type: "phrase",
      content: "harness the power",
      meta: { meaning: "利用", wordSlugs: ["harness"] },
    });

    expect(row.seq).toBe(3);
    const insert = mock.lastQuery!;
    expect(insert.text).toContain("INSERT INTO daily_capture_entries");
    expect(insert.text).toContain("COALESCE(MAX(seq), 0) + 1");
    expect(insert.text).toContain("RETURNING *");
    expect(insert.params[0]).toBe(USER);
    expect(insert.params[1]).toBe("2026-10-10");
    expect(JSON.parse(insert.params[4] as string)).toEqual({ meaning: "利用", wordSlugs: ["harness"] });
  });

  it("meta 为 null 时参数保持 null（不写字符串 \"null\"）", async () => {
    mock.setRows([
      { id: "e-2", user_id: USER, entry_date: "2026-10-10", seq: 4, entry_type: "idea", content: "x", meta: null, status: "raw", created_at: "2026-10-10T01:00:00Z", hidden_at: null },
    ]);
    await repos.dailyCapture.insertEntry({
      user_id: USER,
      entry_date: "2026-10-10",
      entry_type: "idea",
      content: "x",
      meta: null,
    });
    expect(mock.lastQuery!.params[4]).toBeNull();
  });

  it("无返回行（理论不可达）显式报错", async () => {
    mock.setRows([]);
    await expect(
      repos.dailyCapture.insertEntry({ user_id: USER, entry_date: "2026-10-10", entry_type: "note", content: "x", meta: null }),
    ).rejects.toThrow("returned no row");
  });
});

describe("DailyCaptureRepository 读面", () => {
  beforeEach(() => mock.reset());

  it("listDay：隐藏过滤 + seq 升序", async () => {
    mock.setRows([]);
    await repos.dailyCapture.listDay(USER, "2026-10-10");
    const query = mock.lastQuery!;
    expect(query.text).toContain("entry_date = $2::date");
    expect(query.text).toContain("hidden_at IS NULL");
    expect(query.text).toContain("ORDER BY seq ASC");
  });

  it("listDaySummaries：raw/reviewed/absorbed FILTER 计数 + 倒序 LIMIT", async () => {
    mock.setRows([{ date: "2026-10-10", total: 2, raw: 1, reviewed: 1, absorbed: 0 }]);
    const days = await repos.dailyCapture.listDaySummaries(USER, 30);

    expect(days).toEqual([{ date: "2026-10-10", total: 2, raw: 1, reviewed: 1, absorbed: 0 }]);
    const query = mock.lastQuery!;
    expect(query.text).toContain("FILTER (WHERE status = 'raw')");
    expect(query.text).toContain("FILTER (WHERE status = 'reviewed')");
    expect(query.text).toContain("FILTER (WHERE status = 'absorbed')");
    expect(query.text).toContain("GROUP BY entry_date");
    expect(query.text).toContain("ORDER BY entry_date DESC");
    expect(query.text).toContain("LIMIT $2");
    expect(query.params[1]).toBe(30);
  });

  it("listTypes：sort 升序 + type_key 稳定序", async () => {
    mock.setRows([]);
    await repos.dailyCapture.listTypes(USER);
    expect(mock.lastQuery!.text).toContain("ORDER BY sort ASC, type_key ASC");
  });

  it("todayEntryDateKey / formatEntryClock：显示时区口径（Asia/Shanghai）", () => {
    expect(todayEntryDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 01:02Z → 上海 09:02（UTC+8）
    expect(formatEntryClock("2026-10-10T01:02:00Z")).toBe("09:02");
  });
});
