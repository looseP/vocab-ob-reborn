/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 前端通道映射与分桶计数的测试（2026-10-10 新学/复习隔离）。
 *
 * 钉住三条前端不变量：
 *  1. `channelForMode` 的映射：learn→new、review/zen→review、练习模式→不隔离；
 *  2. 每日计数按通道分桶（学新词不消耗复习额度，反之亦然）；
 *  3. 新词上限的脏数据回落（不让一个坏值把闸门永久关死）。
 *
 * 环境说明：必须用 jsdom 的**真实** localStorage ——
 * `dailyReviewLimit.ts` 的 `safeStorage()` 读的是 `window.localStorage`，
 * 用 `vi.stubGlobal("localStorage", …)` 造出来的 `globalThis.localStorage`
 * 在 jsdom 下不是同一个对象，会让全部读写静默失败（存不进、读不到）。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  addDailyReviewedCount,
  readDailyReviewedCount,
  readDailyNewWordLimit,
  writeDailyNewWordLimit,
  parseDailyNewWordLimit,
  localDateKey,
  DEFAULT_DAILY_NEW_WORD_LIMIT,
  MAX_DAILY_NEW_WORD_LIMIT,
} from "@/frontend/utils/dailyReviewLimit";
import { channelForMode } from "@/frontend/hooks/useReview";

beforeEach(() => window.localStorage.clear());

describe("mode → 通道映射", () => {
  it("learn 走 new 通道（只出新词）", () => {
    expect(channelForMode("learn")).toBe("new");
  });

  it("review 与 zen 走 review 通道（永不含新卡）", () => {
    expect(channelForMode("review")).toBe("review");
    expect(channelForMode("zen")).toBe("review");
  });

  it("练习模式不隔离（cram/preview 按定义要混着来）", () => {
    expect(channelForMode("cram")).toBeNull();
    expect(channelForMode("preview")).toBeNull();
  });

  it("未知 mode 不隔离而不是瞎猜（fail-open 到旧行为）", () => {
    expect(channelForMode("hulu")).toBeNull();
    expect(channelForMode("ladder")).toBeNull();
    expect(channelForMode("")).toBeNull();
  });
});

describe("每日计数按通道分桶", () => {
  it("学 3 个新词不影响「今日已复习」", () => {
    addDailyReviewedCount(3, new Date(), "learn");
    expect(readDailyReviewedCount(new Date(), "learn")).toBe(3);
    // 关键断言：复习通道的计数仍是 0
    expect(readDailyReviewedCount(new Date(), "review")).toBe(0);
  });

  it("复习 5 张不影响「今日已学新词」", () => {
    addDailyReviewedCount(5, new Date(), "review");
    expect(readDailyReviewedCount(new Date(), "review")).toBe(5);
    expect(readDailyReviewedCount(new Date(), "learn")).toBe(0);
  });

  it("两桶的键互不相同（否则分桶等于没做）", () => {
    addDailyReviewedCount(1, new Date(), "learn");
    addDailyReviewedCount(9, new Date(), "review");
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k) keys.push(k);
    }
    expect(keys).toHaveLength(2);
    expect(keys.every((k) => k.startsWith("vocab-daily-reviewed:"))).toBe(true);
  });

  it("撤销回退只扣当前通道（撤销学新词不扣复习额度）", () => {
    addDailyReviewedCount(3, new Date(), "learn");
    addDailyReviewedCount(5, new Date(), "review");
    // 撤销一次新词学习
    addDailyReviewedCount(-1, new Date(), "learn");
    expect(readDailyReviewedCount(new Date(), "learn")).toBe(2);
    expect(readDailyReviewedCount(new Date(), "review")).toBe(5);
  });

  it("计数不会降到负数（连续撤销不产生负值）", () => {
    addDailyReviewedCount(1, new Date(), "learn");
    addDailyReviewedCount(-5, new Date(), "learn");
    expect(readDailyReviewedCount(new Date(), "learn")).toBe(0);
  });

  it("跨日自动归零（键里带日期）", () => {
    const today = new Date();
    addDailyReviewedCount(7, today, "learn");
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    expect(readDailyReviewedCount(tomorrow, "learn")).toBe(0);
    expect(readDailyReviewedCount(today, "learn")).toBe(7);
  });

  it("本地日历日键格式正确", () => {
    expect(localDateKey(new Date(2026, 9, 10))).toBe("2026-10-10");
  });

  it("默认桶是 review（未传bucket 的旧调用保持原语义）", () => {
    addDailyReviewedCount(4);
    expect(readDailyReviewedCount()).toBe(4);
  });

  it("迁移兜底：分桶前的旧键（无桶后缀）仍算作复习计数", () => {
    // 回归防线：分桶把键从 `prefix:<date>` 改成 `prefix:<date>:review`。
    // 不做这层回落，升级当天的用户「今日已复习 N 张」会被读成 0 ——
    // 闸门重新打开，已经超载也拦不住。
    window.localStorage.setItem(`vocab-daily-reviewed:${localDateKey()}`, "12");
    expect(readDailyReviewedCount(new Date(), "review")).toBe(12);
  });

  it("迁移兜底：桶键一旦写入就优先，旧键不再参与（不重复计数）", () => {
    window.localStorage.setItem(`vocab-daily-reviewed:${localDateKey()}`, "12");
    // 首次写入走回落基底 ⇒ 12 + 3 = 15，并落盘到桶键
    expect(addDailyReviewedCount(3, new Date(), "review")).toBe(15);
    expect(readDailyReviewedCount(new Date(), "review")).toBe(15);
    // 再加一次时桶键已存在，不再回落到旧键 ⇒ 15 + 2 = 17（不是 12 + 3 + 2）
    expect(addDailyReviewedCount(2, new Date(), "review")).toBe(17);
  });

  it("迁移兜底不作用于新词通道（旧键里装的是复习，不是新词）", () => {
    window.localStorage.setItem(`vocab-daily-reviewed:${localDateKey()}`, "12");
    expect(readDailyReviewedCount(new Date(), "learn")).toBe(0);
  });
});

describe("新词通道上限", () => {
  it("未设置时回落默认值（不是 0/不限）", () => {
    expect(readDailyNewWordLimit()).toBe(DEFAULT_DAILY_NEW_WORD_LIMIT);
  });

  it("0 = 不限，可显式写入并读回", () => {
    writeDailyNewWordLimit(0);
    expect(readDailyNewWordLimit()).toBe(0);
  });

  it("正常值往返一致", () => {
    writeDailyNewWordLimit(35);
    expect(readDailyNewWordLimit()).toBe(35);
  });

  it("超出上限被封顶（不让脏值把闸门放开到失控）", () => {
    writeDailyNewWordLimit(99999);
    expect(readDailyNewWordLimit()).toBe(MAX_DAILY_NEW_WORD_LIMIT);
  });

  it("负数/非数字回落默认（不放任脏数据把闸门关死）", () => {
    expect(parseDailyNewWordLimit("-5")).toBe(DEFAULT_DAILY_NEW_WORD_LIMIT);
    expect(parseDailyNewWordLimit("abc")).toBe(DEFAULT_DAILY_NEW_WORD_LIMIT);
    expect(parseDailyNewWordLimit("")).toBe(DEFAULT_DAILY_NEW_WORD_LIMIT);
    expect(parseDailyNewWordLimit(null)).toBe(DEFAULT_DAILY_NEW_WORD_LIMIT);
  });

  it("小数向下取整", () => {
    expect(parseDailyNewWordLimit("35.9")).toBe(35);
  });
});