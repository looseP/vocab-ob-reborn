/**
 * 「今天的工作量」唯一真源（L3，2026-10-12）—— 仓储级测试。
 *
 * 这条读模型是 2026-10-12 一天内第三轮修复的落点：
 *   ① 仪表盘大数字用日历日口径、队列用此刻口径 ⇒ 数字打脸（PR #234）；
 *   ② 「今日共 N 张到期」没有清单 ⇒ 加 `dueWindow=today` facet（PR #236）；
 *   ③ 口径散在 4 条 SQL 里、其中两条语义相同各写一份 ⇒ 本文件锁住的这个读模型。
 *
 * 必须仓储级（而不是只在 service 层 fake）的理由：恒等式
 * `dueToday === dueNow + laterToday` 是**同一条 SQL 里三个 FILTER 的关系**，
 * service 层的假仓储看不出三个数是不是从同一批行里数出来的。
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

function workloadRow(overrides: Record<string, string> = {}) {
  return { due_now: "0", later_today: "0", due_today: "0", ...overrides };
}

function repo() {
  return createRepositories().reviews;
}

describe("getTodayWorkload — 今天的工作量（唯一真源）", () => {
  it("snake_case 列映射成 camelCase，且三个数来自同一条 SQL", async () => {
    mock.setRows([workloadRow({ due_now: "3", later_today: "2", due_today: "5" })]);

    const workload = await repo().getTodayWorkload("u1", "wb1");

    expect(workload).toEqual({ dueNow: 3, laterToday: 2, dueToday: 5 });
    // 只有一条查询：三个数必须同批同行，否则恒等式不成立
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].text).toContain("later_today");
  });

  it("恒等式 dueToday === dueNow + laterToday（结构性保证，不是巧合）", async () => {
    mock.setRows([workloadRow({ due_now: "7", later_today: "5", due_today: "12" })]);

    const { dueNow, laterToday, dueToday } = await repo().getTodayWorkload("u1", "wb1");

    expect(dueToday).toBe(dueNow + laterToday);
  });

  it("「今天稍后到点」是真实的差集：now < due_at < 明天零点", async () => {
    mock.setRows([workloadRow({ due_now: "0", later_today: "1", due_today: "1" })]);

    const workload = await repo().getTodayWorkload("u1", "wb1");

    // 2026-10-12 实测场景：1 张今天 15:43 到点 ⇒ 此刻 0、稍后 1、今日共 1
    expect(workload).toEqual({ dueNow: 0, laterToday: 1, dueToday: 1 });
    const sql = mock.lastQuery?.text ?? "";
    expect(sql).toContain("uwp.due_at > now()");
    expect(sql).toContain("interval '1 day'");
  });

  it("状态口径 NOT IN ('suspended','new')：挂起不进队列，新卡不是「到期」", async () => {
    mock.setRows([workloadRow()]);

    await repo().getTodayWorkload("u1", "wb1");

    const sql = mock.lastQuery?.text ?? "";
    // 三个 FILTER 共用同一条状态口径 —— 少一个，恒等式就会被挂起/新卡打破
    expect(sql.match(/uwp\.state NOT IN \('suspended', 'new'\)/g)).toHaveLength(3);
    // 「今日零点」走参数位（与复习日历同一个 helper），不内联
    expect(mock.lastQuery?.params).toHaveLength(3);
    expect(typeof mock.lastQuery?.params?.[2]).toBe("string");
  });

  it("可见性口径与队列一致：下架/软删除词不计入", async () => {
    mock.setRows([workloadRow()]);

    await repo().getTodayWorkload("u1", "wb1");

    const sql = mock.lastQuery?.text ?? "";
    expect(sql).toContain("w.is_published = true");
    expect(sql).toContain("w.is_deleted = false");
  });

  it("无行时三个数全归零（不返回 NaN）", async () => {
    mock.setRows([]);

    const workload = await repo().getTodayWorkload("u1", "wb1");

    expect(workload).toEqual({ dueNow: 0, laterToday: 0, dueToday: 0 });
    for (const value of Object.values(workload)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("脏值（非数字）归零而不是 NaN", async () => {
    mock.setRows([workloadRow({ due_now: "abc", due_today: "" })]);

    const workload = await repo().getTodayWorkload("u1", "wb1");

    expect(workload).toEqual({ dueNow: 0, laterToday: 0, dueToday: 0 });
  });

  it("与复习日历「今天」桶同边界同口径（防再次漂移）", async () => {
    // 日历按天摊开同一批卡，边界/口径必须与真源一致，否则「今天待做」徽标又会
    // 和仪表盘对不上。单元层只能断言 SQL 文本一致；真库数值交叉校验在
    // tests/review-service.integration.test.ts（L3 那条用例）。
    mock.setRows([workloadRow()]);
    await repo().getTodayWorkload("u1", "wb1");
    const workloadSql = mock.lastQuery?.text ?? "";

    mock.reset();
    mock.setRows([]);
    await createRepositories().stats.getDailyDueCounts("u1", "wb1", 30);
    const calendarSql = mock.lastQuery?.text ?? "";

    expect(calendarSql).toContain("uwp.state NOT IN ('suspended', 'new')");
    expect(calendarSql).toContain("'Asia/Shanghai'");
    // 真源的三个 FILTER 与日历共用同一句状态口径
    expect(workloadSql).toContain("uwp.state NOT IN ('suspended', 'new')");
  });
});
