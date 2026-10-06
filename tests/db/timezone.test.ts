import { describe, it, expect } from "vitest";
import {
  DISPLAY_TIMEZONE,
  todayKeyInDisplayTz,
  dayKeyInDisplayTz,
  startOfTodayIsoInDisplayTz,
} from "@/db/timezone";
import { HuluRepository } from "@/repositories/hulu.repository";

describe("DISPLAY_TIMEZONE", () => {
  it("is Asia/Shanghai", () => {
    expect(DISPLAY_TIMEZONE).toBe("Asia/Shanghai");
  });
});

describe("dayKeyInDisplayTz", () => {
  it("converts UTC midnight to Shanghai date (same day)", () => {
    // UTC 2026-07-07T00:00:00Z = Shanghai 2026-07-07T08:00:00
    expect(dayKeyInDisplayTz("2026-07-07T00:00:00.000Z")).toBe("2026-07-07");
  });

  it("handles UTC 15:59 as same Shanghai day", () => {
    // UTC 2026-07-07T15:59:59Z = Shanghai 2026-07-07T23:59:59
    expect(dayKeyInDisplayTz("2026-07-07T15:59:59.000Z")).toBe("2026-07-07");
  });

  it("handles UTC 16:00 as next Shanghai day (cross-midnight boundary)", () => {
    // UTC 2026-07-07T16:00:00Z = Shanghai 2026-07-08T00:00:00
    // 这是 streak 错位的核心场景
    expect(dayKeyInDisplayTz("2026-07-07T16:00:00.000Z")).toBe("2026-07-08");
  });

  it("handles UTC 23:59 as next Shanghai day", () => {
    // UTC 2026-07-07T23:59:59Z = Shanghai 2026-07-08T07:59:59
    expect(dayKeyInDisplayTz("2026-07-07T23:59:59.000Z")).toBe("2026-07-08");
  });

  it("accepts Date object input", () => {
    const date = new Date("2026-07-07T10:00:00.000Z");
    // UTC 10:00 = Shanghai 18:00, same day
    expect(dayKeyInDisplayTz(date)).toBe("2026-07-07");
  });

  it("returns YYYY-MM-DD format", () => {
    const result = dayKeyInDisplayTz("2026-07-07T00:00:00.000Z");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("handles month boundary (Jan 31 → Feb 1)", () => {
    // UTC 2026-01-31T16:00:00Z = Shanghai 2026-02-01T00:00:00
    expect(dayKeyInDisplayTz("2026-01-31T16:00:00.000Z")).toBe("2026-02-01");
  });

  it("handles year boundary (Dec 31 → Jan 1)", () => {
    // UTC 2025-12-31T16:00:00Z = Shanghai 2026-01-01T00:00:00
    expect(dayKeyInDisplayTz("2025-12-31T16:00:00.000Z")).toBe("2026-01-01");
  });
});

describe("todayKeyInDisplayTz", () => {
  it("returns today's date key in YYYY-MM-DD format", () => {
    const result = todayKeyInDisplayTz();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches dayKeyInDisplayTz(new Date())", () => {
    const now = new Date();
    expect(todayKeyInDisplayTz()).toBe(dayKeyInDisplayTz(now));
  });
});

describe("startOfTodayIsoInDisplayTz", () => {
  it("returns an ISO 8601 UTC timestamp", () => {
    const result = startOfTodayIsoInDisplayTz();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("returns midnight Shanghai as 16:00 UTC previous day", () => {
    // 如果今天是上海 2026-07-07，那 midnight Shanghai = 2026-07-07T00:00:00+08:00
    // = 2026-07-06T16:00:00.000Z
    const todayKey = todayKeyInDisplayTz();
    const startIso = startOfTodayIsoInDisplayTz();
    const startDate = new Date(startIso);
    const startKey = dayKeyInDisplayTz(startDate);
    // startOfToday 的上海日期应该 = 今天的上海日期
    expect(startKey).toBe(todayKey);
  });

  it("the returned timestamp is midnight in Shanghai (hour 0)", () => {
    // 验证返回的 UTC 时间在上海时区是 00:00:00
    // Note: hour12 defaults to true for en-CA, so 00:00 renders as "12".
    // Use hourCycle: "h23" to force 24-hour formatting.
    const startIso = startOfTodayIsoInDisplayTz();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: DISPLAY_TIMEZONE,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(startIso));
    const hour = parts.find(p => p.type === "hour")?.value;
    const minute = parts.find(p => p.type === "minute")?.value;
    expect(hour).toBe("00");
    expect(minute).toBe("00");
  });
});

/**
 * 口径一致性（主控补充指令 §4）：`HuluRepository.findTodayKeyInDisplayTz`
 * 与 `SessionRepository` 用的 `startOfTodayIsoInDisplayTz` 必须是**同一个
 * 日历日口径** —— 都是 Asia/Shanghai，而不是 UTC 日界。
 *
 * 为什么值得钉死：葫芦的风险校验 `left = exam_date - today` 用前者，
 * 复习会话的"今日坐次"用后者。若两者日界不同（一个上海、一个 UTC），
 * 在 UTC 16:00–24:00 这段（上海已跨日）会出现「复习算新的一天、冲刺还算昨天」
 * 的分裂，用户的"距考试还有几天"会莫名其妙差一天。
 */
describe("findTodayKeyInDisplayTz 与 startOfTodayIsoInDisplayTz 同日历日口径", () => {
  it("仓库返回的今天键 = startOfTodayIso 的上海日期 = todayKeyInDisplayTz()", () => {
    const repo = new HuluRepository();
    const repoKey = repo.findTodayKeyInDisplayTz();

    expect(repoKey).toBe(todayKeyInDisplayTz());
    // startOfTodayIso 是上海零点，它的上海日期就是"今天"
    expect(dayKeyInDisplayTz(new Date(startOfTodayIsoInDisplayTz()))).toBe(repoKey);
  });

  it("是 Asia/Shanghai 日界，不是 UTC 日界（UTC 16:00 之后已跨日）", () => {
    // UTC 2026-07-07T16:00:00Z = 上海 2026-07-08T00:00:00 → 上海口径算 07-08
    const shanghaiKey = dayKeyInDisplayTz("2026-07-07T16:00:00.000Z");
    expect(shanghaiKey).toBe("2026-07-08");
    // 同一时刻若按 UTC 日界会算成 07-07 —— 两者必须不同（证明不是 UTC 口径）
    expect(shanghaiKey).not.toBe("2026-07-07");

    // 该时刻的"上海零点"必须落在 07-08 这一天，与上面同日
    expect(dayKeyInDisplayTz(new Date("2026-07-07T16:00:00.000Z"))).toBe(shanghaiKey);
  });

  it("跨 UTC 日界时两者仍一致（UTC 15:59 vs 16:00 两侧）", () => {
    // 15:59 → 上海同日 07-07；16:00 → 上海次日 07-08。两侧都按上海算。
    expect(dayKeyInDisplayTz("2026-07-07T15:59:59.000Z")).toBe("2026-07-07");
    expect(dayKeyInDisplayTz("2026-07-07T16:00:00.000Z")).toBe("2026-07-08");
  });
});
