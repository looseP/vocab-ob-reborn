/**
 * 复习活动卡的纯逻辑回归锁（批次 2 引入、批次 3 扩充）。
 *
 *  - dayKeyInDisplayTz：与后端 heatmap / 日历分桶同口径（Asia/Shanghai 日界）；
 *  - aggregateSessions：按日聚合、日期降序、截断、未知评分只计 total；
 *  - buildGridWeeks：列 = 周（周一起）、行 = 周一..周日；**空位 ≠ 零复习格**；
 *  - heatLevel / buildMonthLabels（批次 3 视觉规范）：分档色阶与稀疏月份标签。
 */
import { describe, expect, it } from "vitest";
import {
  aggregateSessions,
  buildGridWeeks,
  buildMonthLabels,
  dayKeyInDisplayTz,
  heatLevel,
  HEAT_LEVEL_OPACITY,
} from "@/frontend/components/review/review-activity-model";

/** 从 startKey 起连续 days 天的序列，首日给 3 次、其余 0 次。 */
function dateSeries(startKey: string, days: number) {
  const [year, month, day] = startKey.split("-").map(Number);
  return Array.from({ length: days }, (_, index) => {
    const dt = new Date(Date.UTC(year, month - 1, day + index));
    return { date: dt.toISOString().slice(0, 10), value: index === 0 ? 3 : 0 };
  });
}

describe("dayKeyInDisplayTz", () => {
  it("按 Asia/Shanghai 切日（UTC 16:00 已是次日）", () => {
    expect(dayKeyInDisplayTz(new Date("2026-10-08T15:59:00Z"))).toBe("2026-10-08");
    expect(dayKeyInDisplayTz(new Date("2026-10-08T16:00:00Z"))).toBe("2026-10-09");
  });
});

describe("aggregateSessions", () => {
  const at = (iso: string, rating: string) => ({ created_at: iso, rating });

  it("按日聚合、日期降序、只取前 limit 天", () => {
    const items = [
      at("2026-10-08T01:00:00Z", "good"), // 上海 10-08 09:00
      at("2026-10-08T02:00:00Z", "again"), // 10-08
      at("2026-10-08T16:30:00Z", "easy"), // 上海 10-09 00:30（跨日边界）
      at("2026-10-07T01:00:00Z", "hard"), // 10-07
      at("2026-10-06T01:00:00Z", "good"), // 10-06
    ];
    const sessions = aggregateSessions(items, 2);
    expect(sessions.map((session) => session.date)).toEqual(["2026-10-09", "2026-10-08"]);
    expect(sessions[0]).toMatchObject({ total: 1, byRating: { easy: 1 } });
    expect(sessions[1]).toMatchObject({ total: 2, byRating: { good: 1, again: 1 } });
  });

  it("未知评分只计入 total，不进分布", () => {
    const sessions = aggregateSessions([at("2026-10-08T01:00:00Z", "weird")], 5);
    expect(sessions[0].total).toBe(1);
    expect(sessions[0].byRating).toEqual({ again: 0, hard: 0, good: 0, easy: 0 });
  });

  it("空输入 → 空摘要（不产出「今天 0 张」之类的假行）", () => {
    expect(aggregateSessions([], 5)).toEqual([]);
  });
});

describe("buildGridWeeks", () => {
  it("按周一对齐：首日非周一补空位，尾列补齐到整周", () => {
    // 2026-10-03 是周六 → 首列应补 5 个空位（周一..周五）
    const weeks = buildGridWeeks(dateSeries("2026-10-03", 5));
    expect(weeks).toHaveLength(2);
    expect(weeks[0].slice(0, 5).every((cell) => cell.date === null)).toBe(true);
    expect(weeks[0][5]).toEqual({ date: "2026-10-03", value: 3 });
    expect(weeks[0][6]).toEqual({ date: "2026-10-04", value: 0 });
    expect(weeks[1][0]).toEqual({ date: "2026-10-05", value: 0 });
    expect(weeks[1][2]).toEqual({ date: "2026-10-07", value: 0 });
    expect(weeks[1].slice(3).every((cell) => cell.date === null)).toBe(true);
  });

  it("84 天窗口：有效格恒 84、总格数按 7 对齐（空位只用于对齐）", () => {
    const weeks = buildGridWeeks(dateSeries("2026-07-18", 84));
    const cells = weeks.flat();
    expect(cells.length % 7).toBe(0);
    expect(cells.filter((cell) => cell.date !== null)).toHaveLength(84);
    expect(cells.filter((cell) => cell.date !== null).every((cell) => typeof cell.value === "number")).toBe(true);
  });

  it("空序列 → 空格网", () => {
    expect(buildGridWeeks([])).toEqual([]);
  });
});

describe("heatLevel（分档色阶）", () => {
  it("0 次恒为 0 档；比例映射到 1..4 档", () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(2, 10)).toBe(1); // 0.2
    expect(heatLevel(5, 10)).toBe(2); // 0.5
    expect(heatLevel(7, 10)).toBe(3); // 0.7
    expect(heatLevel(10, 10)).toBe(4); // 1.0
  });

  it("窗口内只有一次活动 → 最深档（相对口径下即满档）", () => {
    expect(heatLevel(1, 1)).toBe(4);
  });

  it("每个档位都有对应的透明度（图例与格子同源）", () => {
    expect(HEAT_LEVEL_OPACITY).toHaveLength(5);
    for (let level = 1; level < HEAT_LEVEL_OPACITY.length; level++) {
      expect(HEAT_LEVEL_OPACITY[level]).toBeGreaterThan(HEAT_LEVEL_OPACITY[level - 1]);
    }
  });
});

describe("buildMonthLabels", () => {
  it("跨月时按月出一个标签，同月只标首次出现", () => {
    // 2026-09-28（周一）起 21 天：列 0 = 9 月末、列 1/2 = 10 月
    const weeks = buildGridWeeks(dateSeries("2026-09-28", 21));
    expect(buildMonthLabels(weeks)).toEqual([
      { column: 0, label: "9月" },
      { column: 1, label: "10月" },
    ]);
  });

  it("空格网 → 无标签", () => {
    expect(buildMonthLabels([])).toEqual([]);
  });
});
