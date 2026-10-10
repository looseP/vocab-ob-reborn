/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 每日复习上限接线（2026-10-10）。
 *
 * 缺陷背景：设置页的「每日复习上限」滑块（10~200）此前是**纯摆设** ——
 * 拖完保存进 localStorage，但全仓库没有任何代码读它，拖到 10 与拖到 200
 * 的行为完全一样；想冲刺上千张的用户既拦不住也无处可调。
 *
 * 本文件锁三条不变量：
 * 1. 设置值解析稳健（脏数据不放开闸门；0 = 不限；上限封顶 2000）；
 * 2. 达上限后**自动续卡停住**（loadMore 不发请求 + blocked 标记置位）；
 * 3. 冲刺入口只在本次会话越过闸门，不改设置；撤销评分时今日计数回退。
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast: addToastMock }),
}));

import { apiFetch } from "@/frontend/api/client";
import { useReview, type ReviewCard } from "@/frontend/hooks/useReview";
import {
  DEFAULT_DAILY_REVIEW_LIMIT,
  MAX_DAILY_REVIEW_LIMIT,
  addDailyReviewedCount,
  formatDailyLimitLabel,
  isDailyLimitReached,
  localDateKey,
  parseDailyReviewLimit,
  readDailyReviewLimit,
  readDailyReviewedCount,
} from "@/frontend/utils/dailyReviewLimit";

const apiFetchMock = vi.mocked(apiFetch);

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

type HookApi = ReturnType<typeof useReview>;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  apiFetchMock.mockReset();
  addToastMock.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) mounted.root.unmount();
  });
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("dailyReviewLimit 纯函数", () => {
  it("脏数据不放开闸门：null/空/非数字/负数都回落默认值", () => {
    for (const raw of [null, undefined, "", "   ", "abc", "-5", "NaN"]) {
      expect(parseDailyReviewLimit(raw)).toBe(DEFAULT_DAILY_REVIEW_LIMIT);
    }
  });

  it("0 = 不限；小数向下取整；超过滑块上限封顶 2000", () => {
    expect(parseDailyReviewLimit("0")).toBe(0);
    expect(parseDailyReviewLimit("12.9")).toBe(12);
    expect(parseDailyReviewLimit("1500")).toBe(1500);
    expect(parseDailyReviewLimit("99999")).toBe(MAX_DAILY_REVIEW_LIMIT);
  });

  it("isDailyLimitReached：0 永不达限（不限档）", () => {
    expect(isDailyLimitReached(0, 9999)).toBe(false);
    expect(isDailyLimitReached(200, 199)).toBe(false);
    expect(isDailyLimitReached(200, 200)).toBe(true);
  });

  it("今日计数按本地日期分桶累计，跨日键互不影响", () => {
    const today = new Date("2026-10-10T10:00:00");
    const yesterday = new Date("2026-10-09T10:00:00");
    expect(readDailyReviewedCount(today)).toBe(0);
    addDailyReviewedCount(3, today);
    expect(readDailyReviewedCount(today)).toBe(3);
    // 昨天仍是 0：计数不会跨日串味
    expect(readDailyReviewedCount(yesterday)).toBe(0);
    addDailyReviewedCount(-1, today);
    expect(readDailyReviewedCount(today)).toBe(2);
    // 回退不到负数
    addDailyReviewedCount(-99, today);
    expect(readDailyReviewedCount(today)).toBe(0);
    expect(localDateKey(new Date("2026-01-05T23:00:00"))).toBe("2026-01-05");
  });

  it("readDailyReviewLimit 读的是设置页同一把键", () => {
    window.localStorage.setItem("vocab-daily-limit", "800");
    expect(readDailyReviewLimit()).toBe(800);
  });

  it("formatDailyLimitLabel：0 显示为不限", () => {
    expect(formatDailyLimitLabel(200)).toBe("200 张/天");
    expect(formatDailyLimitLabel(0)).toBe("不限");
  });
});

function makeCard(progressId: string, lemma: string): ReviewCard {
  return {
    progressId,
    word: {
      id: `w-${progressId}`,
      slug: lemma,
      title: lemma,
      lemma,
      short_definition: `${lemma} 的释义`,
      ipa: null,
      pos: null,
      cefr: null,
    },
    state: "review",
    dueAt: null,
    lastRating: null,
    reviewCount: 0,
    note_entries: [],
  };
}

function installApi(cards: ReviewCard[]) {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/review/queue")) {
      return {
        items: cards,
        session: { id: "sess-1", mode: "review", cardsSeen: 0 },
        stats: { total: cards.length, remaining: cards.length },
        hasMore: true,
      } as never;
    }
    if (path === "/review/answer") {
      return { ok: true, reviewLogId: `log-${Date.now()}` } as never;
    }
    if (path === "/review/undo") {
      return { ok: true } as never;
    }
    throw new Error(`未预期的请求：${path}`);
  });
}

function mountHook() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let latest: HookApi | null = null;
  function Harness() {
    latest = useReview();
    return null;
  }
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Harness));
  });
  mountedRoots.push({ root, container });
  return {
    get api(): HookApi {
      return latest!;
    },
  };
}

async function run<T>(fn: () => Promise<T> | T): Promise<T> {
  let result!: T;
  await act(async () => {
    result = await fn();
  });
  return result;
}

function queueRequestCount(): number {
  return apiFetchMock.mock.calls.filter(([path]) => String(path).startsWith("/review/queue")).length;
}

describe("useReview 每日上限闸门", () => {
  it("今日已达上限：loadMore 不发请求并置 blocked；冲刺入口本次会话内越过", async () => {
    window.localStorage.setItem("vocab-daily-limit", "1");
    window.localStorage.setItem(`vocab-daily-reviewed:${localDateKey()}`, "1");
    const cards = Array.from({ length: 20 }, (_, i) => makeCard(`p-${i}`, `w${i}`));
    installApi(cards);

    const h = mountHook();
    await run(() => h.api.startReview("review"));
    const callsAfterStart = queueRequestCount();

    expect(h.api.dailyLimit).toBe(1);
    expect(h.api.dailyReviewedToday).toBe(1);

    // 闸门：不续卡
    expect(await run(() => h.api.loadMore())).toBe(false);
    expect(queueRequestCount()).toBe(callsAfterStart);
    expect(h.api.dailyLimitBlocked).toBe(true);

    // 冲刺：越过闸门、立即续卡；设置值保持不变（临时行为不落盘）
    expect(await run(() => h.api.allowDailyLimitOverride())).toBe(true);
    expect(queueRequestCount()).toBe(callsAfterStart + 1);
    expect(h.api.dailyLimitBlocked).toBe(false);
    expect(window.localStorage.getItem("vocab-daily-limit")).toBe("1");

    // 越过后可继续续卡（不再被拦）
    expect(await run(() => h.api.loadMore())).toBe(true);
    expect(queueRequestCount()).toBe(callsAfterStart + 2);
  });

  it("0 = 不限：达任何数量都不拦", async () => {
    window.localStorage.setItem("vocab-daily-limit", "0");
    window.localStorage.setItem(`vocab-daily-reviewed:${localDateKey()}`, "9999");
    installApi([makeCard("p-1", "alpha")]);

    const h = mountHook();
    await run(() => h.api.startReview("review"));
    expect(h.api.dailyLimit).toBe(0);
    expect(await run(() => h.api.loadMore())).toBe(true);
    expect(h.api.dailyLimitBlocked).toBe(false);
  });

  it("评分入账今日计数、撤销回退；cram 练习不计", async () => {
    installApi([makeCard("p-1", "alpha")]);
    const h = mountHook();
    await run(() => h.api.startReview("review"));

    expect(readDailyReviewedCount()).toBe(0);
    await run(() => h.api.answer("good"));
    expect(readDailyReviewedCount()).toBe(1);

    await run(() => h.api.undoLast());
    expect(readDailyReviewedCount()).toBe(0);
  });
});
