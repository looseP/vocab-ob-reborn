/**
 * 复习日历的纯函数锁（`shiftDate` / `buildSeries`）。
 *
 * 这两件事最容易在"看起来对"的地方骗人：
 *  ① 日期加减若走浏览器本地时区，跨时区或跨零点会与后端桶错开一天；
 *  ② 日序列若只画有数据的日子，空白日会**消失**，图上看着连续、实际是拼出来的 ——
 *     那正是本仓一直在清的"假图"。
 */
import { describe, expect, it } from "vitest";
import { CALENDAR_SPAN, buildSeries, shiftDate } from "@/frontend/components/review/ReviewCalendar";

describe("shiftDate（按 UTC 算术，不受本地时区影响）", () => {
  it("普通加减", () => {
    expect(shiftDate("2026-10-08", 1)).toBe("2026-10-09");
    expect(shiftDate("2026-10-08", -1)).toBe("2026-10-07");
  });

  it("跨月 / 跨年 / 闰年二月", () => {
    expect(shiftDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDate("2028-02-28", 1)).toBe("2028-02-29"); // 闰年
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("buildSeries（补零成连续日序列）", () => {
  const values = new Map([["2026-10-06", 4], ["2026-10-08", 2]]);

  it("过去窗口：从 today-(span-1) 到 today，缺桶补 0", () => {
    const series = buildSeries("2026-10-08", 3, (i) => i - 2, values);
    expect(series).toEqual([
      { date: "2026-10-06", value: 4 },
      { date: "2026-10-07", value: 0 }, // 该日无活动 → 0，而不是"这天不存在"
      { date: "2026-10-08", value: 2 },
    ]);
  });

  it("未来窗口：从明天起 span 天（今天已在过去窗口/徽标里，不重复画）", () => {
    const series = buildSeries("2026-10-08", 3, (i) => i + 1, values);
    expect(series.map((d) => d.date)).toEqual(["2026-10-09", "2026-10-10", "2026-10-11"]);
    expect(series.every((d) => d.value === 0)).toBe(true);
  });

  it("长度恒等于 span（画出来的柱子数不随数据量变化）", () => {
    expect(buildSeries("2026-10-08", CALENDAR_SPAN, (i) => i - (CALENDAR_SPAN - 1), values)).toHaveLength(CALENDAR_SPAN);
    expect(buildSeries("2026-10-08", CALENDAR_SPAN, (i) => i + 1, new Map())).toHaveLength(CALENDAR_SPAN);
  });
});
