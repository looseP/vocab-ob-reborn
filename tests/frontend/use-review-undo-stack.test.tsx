/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * useReview 多步撤销栈 + 会话持久化（2026-10-02，feat/undo-stack-and-session-resilience）。
 *
 * 缺陷背景：
 * 1. 撤销只记 `lastAnswer` 单条 —— 用户连评三张后想回退两张，撤回第一张后
 *    撤销入口就消失了（`canUndo` 变 false），只能重开一轮；
 * 2. 会话缓存写在 `sessionStorage`（TTL 30min）—— 误关浏览器/标签页即丢进度，
 *    且撤销历史完全不落盘。
 *
 * 本文件锁住三条不变量：
 * - 撤销栈严格 LIFO：连续撤销按 Word C → Word B → Word A 顺序回退，游标与
 *   统计逐级回退（不是一次跳回起点）；
 * - 深度上限 MAX_UNDO_DEPTH，超出丢弃最旧；
 * - 缓存落 localStorage 且 TTL 24h：2 小时前的进度（含撤销栈）仍可恢复。
 *
 * 后端语义（`undo_review_log` RPC，drizzle-release/0001_routines.sql）：
 * "仅最新一条可撤销"是**按 progress_id 分组**判定的，因此全局 LIFO 栈天然合法 ——
 * 栈顶元素必是该词最新未撤销的评分。
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
import { MAX_UNDO_DEPTH, useReview, type ReviewCard } from "@/frontend/hooks/useReview";

const apiFetchMock = vi.mocked(apiFetch);

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const CACHE_KEY = "vocab:review:session:review::";

type HookApi = ReturnType<typeof useReview>;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  apiFetchMock.mockReset();
  addToastMock.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) mounted.root.unmount();
  });
  document.body.innerHTML = "";
  window.localStorage.clear();
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

/** 三张卡的队列（lemma 便于按撤销顺序断言）。 */
function threeCards(): ReviewCard[] {
  return [
    makeCard("p-alpha", "alpha"),
    makeCard("p-bravo", "bravo"),
    makeCard("p-charlie", "charlie"),
  ];
}

interface ApiOptions {
  /** /review/undo 是否失败（验证失败目标被弹出）。 */
  undoFails?: boolean;
  /** /review/answer 返回 idempotent（阶梯重做语义）。 */
  answerIdempotent?: boolean;
}

let logSeq = 0;

function installApi(cards: ReviewCard[], options: ApiOptions = {}) {
  logSeq = 0;
  apiFetchMock.mockImplementation(async (path: string, init?: { body?: string }) => {
    if (path.startsWith("/review/queue")) {
      return {
        items: cards,
        session: { id: "sess-1", mode: "review", cardsSeen: 0 },
        stats: { total: cards.length, remaining: cards.length },
        hasMore: false,
      } as never;
    }
    if (path === "/review/answer") {
      const body = JSON.parse(init?.body ?? "{}") as { mode?: string };
      if (body.mode === "cram") {
        return { ok: true, reviewLogId: `cram-${Date.now()}` } as never;
      }
      logSeq += 1;
      return {
        ok: true,
        reviewLogId: `log-${logSeq}`,
        ...(options.answerIdempotent ? { idempotent: true } : {}),
      } as never;
    }
    if (path === "/review/undo") {
      if (options.undoFails) throw new Error("Only the latest review can be undone");
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
    unmount() {
      act(() => root.unmount());
    },
  };
}

/** 在 act 内 await 一个 hook 异步动作，保证状态与副作用都冲刷完成。 */
async function run(fn: () => Promise<unknown> | unknown): Promise<void> {
  await act(async () => {
    await fn();
  });
}

/** 取 /review/undo 请求体（按调用顺序）。 */
function undoBodies(): Array<{ reviewLogId: string }> {
  return apiFetchMock.mock.calls
    .filter(([path]) => path === "/review/undo")
    .map(([, init]) => JSON.parse((init as { body: string }).body) as { reviewLogId: string });
}

describe("useReview 多步撤销栈", () => {
  it("连续提交 3 次评分后连续撤销 2 次：按 LIFO 逐级回退游标与统计", async () => {
    installApi(threeCards());
    const h = mountHook();
    await run(() => h.api.startReview("review"));

    expect(h.api.currentCard?.word.lemma).toBe("alpha");

    await run(() => h.api.answer("good"));
    await run(() => h.api.answer("hard"));
    await run(() => h.api.answer("easy"));

    // 三张全部评完：完成态，栈深 3（栈顶 = 最后评的 charlie）
    expect(h.api.stats.reviewed).toBe(3);
    expect(h.api.completed).toBe(true);
    expect(h.api.canUndo).toBe(true);
    expect(h.api.undoStack.map((a) => a.card.word.lemma)).toEqual(["charlie", "bravo", "alpha"]);

    // 第 1 次撤销：撤 charlie，游标回到 charlie 的位置，统计 3 → 2
    await run(() => h.api.undoLast());
    expect(h.api.stats.reviewed).toBe(2);
    expect(h.api.currentCard?.word.lemma).toBe("charlie");
    expect(h.api.completed).toBe(false);
    expect(h.api.canUndo).toBe(true);
    expect(h.api.undoStack.map((a) => a.card.word.lemma)).toEqual(["bravo", "alpha"]);

    // 第 2 次撤销：撤 bravo（不是跳回起点，而是逐级回退），统计 2 → 1
    await run(() => h.api.undoLast());
    expect(h.api.stats.reviewed).toBe(1);
    expect(h.api.currentCard?.word.lemma).toBe("bravo");
    expect(h.api.canUndo).toBe(true);
    expect(h.api.undoStack.map((a) => a.card.word.lemma)).toEqual(["alpha"]);

    // 评分维度计数同步逐级回退：hard / easy 各减 1，good 保留
    expect(h.api.stats).toMatchObject({ again: 0, hard: 0, good: 1, easy: 0 });

    // 请求确实按 C → B 顺序打给服务端（而非重复撤同一条）
    expect(undoBodies().map((b) => b.reviewLogId)).toEqual(["log-3", "log-2"]);

    // 第 3 次撤销：撤 alpha，栈空 → canUndo 变 false（栈空前一直为 true）
    await run(() => h.api.undoLast());
    expect(h.api.stats.reviewed).toBe(0);
    expect(h.api.currentCard?.word.lemma).toBe("alpha");
    expect(h.api.undoStack).toEqual([]);
    expect(h.api.canUndo).toBe(false);

    // 栈空后再调用是安全的空操作，不产生额外请求
    await run(() => h.api.undoLast());
    expect(undoBodies()).toHaveLength(3);
  });

  it(`撤销栈深度上限 ${MAX_UNDO_DEPTH}：超出的最旧评分被丢弃`, async () => {
    const cards = Array.from({ length: 12 }, (_, i) => makeCard(`p-${i}`, `word${i}`));
    installApi(cards);
    const h = mountHook();
    await run(() => h.api.startReview("review"));

    for (let i = 0; i < 12; i += 1) {
      await run(() => h.api.answer("good"));
    }

    expect(h.api.stats.reviewed).toBe(12);
    expect(h.api.undoStack).toHaveLength(MAX_UNDO_DEPTH);
    // 保留最近的 10 条：栈顶 word11，栈底 word2（word0/word1 被挤出）
    expect(h.api.undoStack[0].card.word.lemma).toBe("word11");
    expect(h.api.undoStack.at(-1)?.card.word.lemma).toBe("word2");
  });

  it("撤销失败时弹出该目标：避免同一个失效 reviewLogId 死循环重试", async () => {
    installApi(threeCards(), { undoFails: true });
    const h = mountHook();
    await run(() => h.api.startReview("review"));
    await run(() => h.api.answer("good"));
    await run(() => h.api.answer("good"));

    expect(h.api.undoStack).toHaveLength(2);

    await run(() => h.api.undoLast());

    // 失败目标被移除（栈从 2 减到 1），且把服务端原因透出给用户
    expect(h.api.undoStack).toHaveLength(1);
    expect(h.api.undoStack[0].card.word.lemma).toBe("alpha");
    expect(addToastMock).toHaveBeenCalledWith("error", "Only the latest review can be undone");
  });

  it("cram 合成日志不入栈（练习模式不写库，无可撤销项）", async () => {
    installApi(threeCards());
    const h = mountHook();
    await run(() => h.api.startReview("cram"));
    await run(() => h.api.answer("good"));

    expect(h.api.stats.reviewed).toBe(1);
    expect(h.api.undoStack).toEqual([]);
    expect(h.api.canUndo).toBe(false);
  });
});

describe("会话持久化（localStorage / TTL 24h）", () => {
  it("评分后撤销栈落盘；重开浏览器（新挂载）仍能继续撤销", async () => {
    installApi(threeCards());
    const first = mountHook();
    await run(() => first.api.startReview("review"));
    await run(() => first.api.answer("good"));
    await run(() => first.api.answer("good"));

    // 缓存必须写在 localStorage（sessionStorage 会随标签页关闭丢失）
    const raw = window.localStorage.getItem(CACHE_KEY);
    expect(raw, "会话缓存未落 localStorage").toBeTruthy();
    const parsed = JSON.parse(raw!) as { undoStack?: Array<{ reviewLogId: string }> };
    expect(parsed.undoStack?.map((a) => a.reviewLogId)).toEqual(["log-2", "log-1"]);
    expect(window.sessionStorage.getItem(CACHE_KEY)).toBeNull();

    first.unmount();

    // 重新挂载 = 重开浏览器：命中缓存，进度与撤销栈一并还原
    const second = mountHook();
    await run(() => second.api.startReview("review"));

    expect(addToastMock).toHaveBeenCalledWith("info", expect.stringContaining("已恢复复习会话"));
    expect(second.api.stats.reviewed).toBe(2);
    expect(second.api.canUndo).toBe(true);
    expect(second.api.undoStack.map((a) => a.card.word.lemma)).toEqual(["bravo", "alpha"]);

    // 恢复后仍可真正撤销（栈里的 reviewLogId 是有效的）
    await run(() => second.api.undoLast());
    expect(second.api.stats.reviewed).toBe(1);
    expect(undoBodies().at(-1)?.reviewLogId).toBe("log-2");
  });

  it("2 小时前的缓存仍可恢复（旧 30min TTL 会把它当作过期丢弃）", async () => {
    installApi(threeCards());
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        mode: "review",
        wordIdsKey: "",
        sessionId: "sess-1",
        queue: threeCards(),
        currentIndex: 1,
        stats: { reviewed: 1, again: 0, hard: 0, good: 1, easy: 0 },
        deferredNewCards: 0,
        completed: false,
        skipped: 0,
        suspended: 0,
        hasMore: false,
        undoStack: [
          { card: threeCards()[0], rating: "good", reviewLogId: "log-old", indexBefore: 0 },
        ],
        savedAt: twoHoursAgo,
      }),
    );

    const h = mountHook();
    await run(() => h.api.startReview("review"));

    expect(addToastMock).toHaveBeenCalledWith("info", expect.stringContaining("已恢复复习会话"));
    expect(h.api.stats.reviewed).toBe(1);
    expect(h.api.currentCard?.word.lemma).toBe("bravo");
    expect(h.api.canUndo).toBe(true);
    // 未过期：缓存不应被清理
    expect(window.localStorage.getItem(CACHE_KEY)).toBeTruthy();
  });

  it("超过 24h 的缓存按过期处理并清理（TTL 上限仍有效）", async () => {
    installApi(threeCards());
    const stale = Date.now() - 25 * 60 * 60 * 1000;
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        mode: "review",
        wordIdsKey: "",
        sessionId: "sess-old",
        queue: threeCards(),
        currentIndex: 2,
        stats: { reviewed: 2, again: 0, hard: 0, good: 2, easy: 0 },
        deferredNewCards: 0,
        completed: false,
        savedAt: stale,
      }),
    );

    const h = mountHook();
    await run(() => h.api.startReview("review"));

    expect(addToastMock).not.toHaveBeenCalledWith("info", expect.stringContaining("已恢复复习会话"));
    // 过期缓存被清掉，且走真实拉取（从零开始）
    expect(h.api.stats.reviewed).toBe(0);
    expect(h.api.currentCard?.word.lemma).toBe("alpha");
  });
});
