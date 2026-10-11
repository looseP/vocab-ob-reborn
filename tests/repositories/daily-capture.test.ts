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

const RECEIPT = {
  action: "bind_l3" as const,
  target: "l3_context",
  id: "ctx-1",
  at: "2026-10-10T02:00:00Z",
  word_slug: "harness",
};

describe("DailyCaptureRepository.findEntry / appendAbsorption（M3 吸收回执）", () => {
  beforeEach(() => mock.reset());

  it("findEntry：未隐藏单条；查询走 (user, id) 且排除已隐藏", async () => {
    mock.setRows([{ id: "e-9", seq: 3, status: "raw" }]);
    const row = await repos.dailyCapture.findEntry(USER, "e-9");

    expect(row?.id).toBe("e-9");
    const query = mock.lastQuery!;
    expect(query.text).toContain("SELECT * FROM daily_capture_entries");
    expect(query.text).toContain("id = $2::uuid");
    expect(query.text).toContain("hidden_at IS NULL");
    expect(query.params).toEqual([USER, "e-9"]);
  });

  it("findEntry：无行（不存在/已隐藏）返回 null", async () => {
    mock.setRows([]);
    expect(await repos.dailyCapture.findEntry(USER, "e-9")).toBeNull();
  });

  it("appendAbsorption：jsonb 追加回执 + 终态守卫（absorbed/archived 不可再写）", async () => {
    mock.setRows([{ id: "e-9", status: "absorbed" }]);
    const row = await repos.dailyCapture.appendAbsorption(USER, "e-9", RECEIPT, "absorbed");

    expect(row?.status).toBe("absorbed");
    const query = mock.lastQuery!;
    expect(query.text).toContain("absorption = COALESCE(absorption, '[]'::jsonb) || $3::jsonb");
    expect(query.text).toContain("status = $4");
    expect(query.text).toContain("status NOT IN ('absorbed', 'archived')");
    // 单元素数组整体 stringify（jsonb 追加语义：既有回执不丢）
    expect(query.params[2]).toBe(JSON.stringify([RECEIPT]));
    expect(query.params[3]).toBe("absorbed");
  });

  it("appendAbsorption：终态/已隐藏命中 0 行 → null（服务层据此判 409）", async () => {
    mock.setRows([]);
    expect(await repos.dailyCapture.appendAbsorption(USER, "e-9", RECEIPT, "reviewed")).toBeNull();
  });
});

describe("DailyCaptureRepository.updateEntryFields（按需更新）", () => {
  beforeEach(() => mock.reset());

  it("status-only：$1 绑状态，$2/$3 绑定位谓词", async () => {
    mock.setRows([{ id: "e-1", status: "reviewed" }]);
    const row = await repos.dailyCapture.updateEntryFields(USER, "e-1", { status: "reviewed" });

    expect(row?.status).toBe("reviewed");
    const query = mock.lastQuery!;
    expect(query.text).toContain("UPDATE daily_capture_entries SET status = $1");
    expect(query.text).toContain("WHERE user_id = $2::uuid AND id = $3::uuid AND hidden_at IS NULL");
    expect(query.params).toEqual(["reviewed", USER, "e-1"]);
  });

  it("meta-only：jsonb 序列化；显式 null 清空 meta", async () => {
    mock.setRows([{ id: "e-1" }]);
    await repos.dailyCapture.updateEntryFields(USER, "e-1", { meta: { important: true } });

    expect(mock.lastQuery!.text).toContain("UPDATE daily_capture_entries SET meta = $1::jsonb");
    expect(JSON.parse(mock.lastQuery!.params[0] as string)).toEqual({ important: true });

    mock.setRows([{ id: "e-1" }]);
    await repos.dailyCapture.updateEntryFields(USER, "e-1", { meta: null });
    expect(mock.lastQuery!.params[0]).toBeNull();
  });

  it("两字段同更：SET 顺序 = status→meta，占位编号连续", async () => {
    mock.setRows([{ id: "e-1" }]);
    await repos.dailyCapture.updateEntryFields(USER, "e-1", { status: "archived", meta: { important: false } });

    const query = mock.lastQuery!;
    expect(query.text).toContain("SET status = $1, meta = $2::jsonb");
    expect(query.text).toContain("WHERE user_id = $3::uuid AND id = $4::uuid");
    expect(query.params).toEqual(["archived", JSON.stringify({ important: false }), USER, "e-1"]);
  });

  it("空 patch 不写库，回落 findEntry（幂等读）", async () => {
    mock.setRows([{ id: "e-1", status: "raw" }]);
    const row = await repos.dailyCapture.updateEntryFields(USER, "e-1", {});

    expect(row?.id).toBe("e-1");
    expect(mock.lastQuery!.text).not.toContain("UPDATE daily_capture_entries");
    expect(mock.lastQuery!.text).toContain("SELECT * FROM daily_capture_entries");
  });
});

describe("DailyCaptureRepository 类型注册表（M2 类型管理）", () => {
  beforeEach(() => mock.reset());

  it("findTypeByKey：按 (user, type_key) 取单条；无行 null", async () => {
    mock.setRows([{ type_key: "method", label: "学习方法", sort: 2 }]);
    const row = await repos.dailyCapture.findTypeByKey(USER, "method");

    expect(row?.label).toBe("学习方法");
    expect(mock.lastQuery!.params).toEqual([USER, "method"]);

    mock.setRows([]);
    expect(await repos.dailyCapture.findTypeByKey(USER, "method")).toBeNull();
  });

  it("countVisibleTypes：只数未 hidden；无行回落 0", async () => {
    mock.setRows([{ n: 7 }]);
    expect(await repos.dailyCapture.countVisibleTypes(USER)).toBe(7);
    expect(mock.lastQuery!.text).toContain("hidden = false");

    mock.setRows([]);
    expect(await repos.dailyCapture.countVisibleTypes(USER)).toBe(0);
  });

  it("insertType：自定义类型落库；无返回行显式报错", async () => {
    mock.setRows([{ type_key: "slang", label: "俚语", absorption_hint: null, sort: 6 }]);
    const row = await repos.dailyCapture.insertType({
      user_id: USER,
      type_key: "slang",
      label: "俚语",
      absorption_hint: null,
      sort: 6,
    });

    expect(row.type_key).toBe("slang");
    expect(mock.lastQuery!.text).toContain("INSERT INTO daily_capture_types");
    expect(mock.lastQuery!.params).toEqual([USER, "slang", "俚语", null, 6]);

    mock.setRows([]);
    await expect(
      repos.dailyCapture.insertType({ user_id: USER, type_key: "slang", label: "俚语", absorption_hint: null, sort: 6 }),
    ).rejects.toThrow("daily capture type insert returned no row");
  });

  it("updateType：多列动态 SET（跳过未给字段）+ 空 patch 回落 findTypeByKey", async () => {
    mock.setRows([{ type_key: "slang", label: "俚语（改）", hidden: false }]);
    await repos.dailyCapture.updateType(USER, "slang", { label: "俚语（改）", hidden: false });

    const query = mock.lastQuery!;
    expect(query.text).toContain("UPDATE daily_capture_types SET label = $1, hidden = $2");
    expect(query.text).toContain("WHERE user_id = $3::uuid AND type_key = $4");
    expect(query.params).toEqual(["俚语（改）", false, USER, "slang"]);

    mock.setRows([{ type_key: "slang" }]);
    await repos.dailyCapture.updateType(USER, "slang", {});
    expect(mock.lastQuery!.text).toContain("SELECT * FROM daily_capture_types");
  });

  it("updateType：sort/hint 单独更新时编号仍连续", async () => {
    mock.setRows([{ type_key: "slang" }]);
    await repos.dailyCapture.updateType(USER, "slang", { sort: 9, absorption_hint: "改由 agent 改写" });

    const query = mock.lastQuery!;
    expect(query.text).toContain("SET absorption_hint = $1, sort = $2");
    expect(query.params).toEqual(["改由 agent 改写", 9, USER, "slang"]);
  });
});
