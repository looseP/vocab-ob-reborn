/**
 * Task 09A · 引用目标搜索模型测试（先红后绿）。
 *
 * 覆盖已冻结的搜索协议（frontend-tasks §4.3）：
 *  R1 切 kind 清 cursor；R2 q 变化清 cursor；R3 venue 变化清 cursor；
 *  R4 仅 limit 变化 cursor 可保留；R5 旧 cursor 400 → 提示刷新（refresh 无 cursor）。
 * 另：分页去重、防抖、竞态（旧响应丢弃）。
 */
import { describe, expect, it, vi } from "vitest";
import type { StudyPage } from "@/domain/l3-study-notes";
import type { StudyTargetItem } from "@/frontend/api/studyNotesClient";
import {
  createStudyReferenceSearchModel,
  type ReferenceSearchModel,
} from "@/frontend/state/studyReferenceSearchModel";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTimers() {
  let now = 0;
  let seq = 0;
  const tasks: Array<{ at: number; fn: () => void; id: number }> = [];
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      tasks.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (handle: unknown) => {
      const index = tasks.findIndex((task) => task.id === handle);
      if (index >= 0) tasks.splice(index, 1);
    },
    runPending: () => {
      for (let guard = 0; guard < 50 && tasks.length > 0; guard += 1) {
        tasks.sort((a, b) => a.at - b.at);
        const next = tasks.shift()!;
        now = next.at;
        next.fn();
      }
      return tasks.length;
    },
    pendingCount: () => tasks.length,
  };
}

const item = (id: string): StudyTargetItem => ({
  id,
  title: `来源 ${id.slice(-2)}`,
  createdAt: "2026-09-20T00:00:00.000Z",
});

const page = (items: StudyTargetItem[], nextCursor: string | null = null, total = items.length): StudyPage<StudyTargetItem> => ({
  items,
  total,
  nextCursor,
});

interface Harness {
  model: ReferenceSearchModel;
  calls: Array<Record<string, unknown>>;
  deferreds: Array<Deferred<StudyPage<StudyTargetItem>>>;
  timers: ReturnType<typeof makeTimers>;
}

function harness(): Harness {
  const calls: Array<Record<string, unknown>> = [];
  const deferreds: Array<Deferred<StudyPage<StudyTargetItem>>> = [];
  const timers = makeTimers();
  const model = createStudyReferenceSearchModel({
    search: (query) => {
      calls.push(query as unknown as Record<string, unknown>);
      const d = defer<StudyPage<StudyTargetItem>>();
      deferreds.push(d);
      return d.promise;
    },
    debounceMs: 300,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { model, calls, deferreds, timers };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("studyReferenceSearchModel · 协议 R1–R5", () => {
  it("R1：切 kind 清 cursor 并立即请求新 kind", async () => {
    const h = harness();
    h.model.setKind("source");
    await flush();
    h.deferreds[0]!.resolve(page([item("a1")], "cursor-source", 2));
    await flush();

    h.model.setKind("question");
    await flush();
    expect(h.calls[1]).toMatchObject({ kind: "question" });
    expect(h.calls[1]!.cursor).toBeUndefined(); // 清 cursor
    h.deferreds[1]!.resolve(page([item("q1")], null, 1));
    await flush();
    expect(h.model.getSnapshot().nextCursor).toBe(null);
  });

  it("R2：q 变化（防抖）清 cursor；连续输入只发一次（最后值）", async () => {
    const h = harness();
    h.model.setKind("source");
    await flush();
    h.deferreds[0]!.resolve(page([item("a1")], "cursor-1", 5));
    await flush();

    h.model.setQuery("原");
    h.model.setQuery("原文");
    h.model.setQuery("原文字");
    expect(h.calls.length).toBe(1); // 防抖期内不发
    h.timers.runPending();
    await flush();
    expect(h.calls.length).toBe(2);
    expect(h.calls[1]).toMatchObject({ kind: "source", q: "原文字" });
    expect(h.calls[1]!.cursor).toBeUndefined(); // 清 cursor
  });

  it("R2b：q 变化立即失效旧在途响应（序号守卫）", async () => {
    const h = harness();
    h.model.setKind("source");
    await flush();
    // 首页挂起（deferreds[0]）
    h.model.setQuery("新词"); // 旧代失效
    h.deferreds[0]!.resolve(page([item("stale")], "c", 1)); // 旧响应迟到
    await flush();
    expect(h.model.getSnapshot().candidates).toEqual([]); // 不被旧响应填充
    h.timers.runPending();
    await flush();
    h.deferreds[1]!.resolve(page([item("fresh")], null, 1));
    await flush();
    expect(h.model.getSnapshot().candidates.map((c) => c.id)).toEqual(["fresh"]);
  });

  it("R3：venue 变化清 cursor（question kind 下生效）", async () => {
    const h = harness();
    h.model.setKind("question"); // #2（构造已发 #1 source，其后作废）
    await flush();
    h.deferreds[1]!.resolve(page([item("q1")], "cursor-q", 5));
    await flush();
    expect(h.model.getSnapshot().nextCursor).toBe("cursor-q");

    h.model.setVenue("cloze");
    await flush();
    expect(h.calls[2]!.cursor).toBeUndefined();
    expect(h.calls[2]!.venue).toBe("cloze");
    expect(h.calls[2]!.kind).toBe("question");
  });

  it("R4：仅 limit 变化 → cursor 保留（请求带旧 cursor）", async () => {
    const h = harness();
    h.model.setKind("source");
    await flush();
    h.deferreds[0]!.resolve(page([item("a1")], "cursor-1", 5));
    await flush();

    h.model.setLimit(10);
    await flush();
    expect(h.calls[1]!.limit).toBe(10);
    expect(h.calls[1]!.cursor).toBe("cursor-1"); // 保留
  });

  it("R5：旧 cursor 400 → 错误提示 + refresh 重发（无 cursor）", async () => {
    const h = harness();
    h.model.setKind("source");
    await flush();
    h.deferreds[0]!.resolve(page([item("a1")], "cursor-1", 2));
    await flush();

    h.model.loadMore(); // 带 cursor-1
    h.deferreds[1]!.reject(Object.assign(new Error("Invalid pagination cursor"), { status: 400 }));
    await flush();
    const snapshot = h.model.getSnapshot();
    expect(snapshot.error).toContain("刷新");
    expect(snapshot.candidates.map((c) => c.id)).toEqual(["a1"]); // 旧列表保留

    h.model.refresh();
    await flush();
    expect(h.calls[2]!.cursor).toBeUndefined(); // 刷新无 cursor
    h.deferreds[2]!.resolve(page([item("a2")], null, 1));
    await flush();
    expect(h.model.getSnapshot().error).toBe(null);
    expect(h.model.getSnapshot().candidates.map((c) => c.id)).toEqual(["a2"]);
  });
});

describe("studyReferenceSearchModel · 分页去重", () => {
  it("loadMore：带 cursor、按 id 去重、nextCursor 更新；取尽后再 loadMore no-op", async () => {
    const h = harness();
    h.model.setKind("source");
    await flush();
    h.deferreds[0]!.resolve(page([item("a1"), item("a2")], "c1", 3));
    await flush();

    const more = h.model.loadMore();
    expect(h.model.getSnapshot().loadingMore).toBe(true);
    h.deferreds[1]!.resolve(page([item("a2"), item("a3")], null, 3)); // a2 重复
    await more;
    expect(h.model.getSnapshot().candidates.map((c) => c.id)).toEqual(["a1", "a2", "a3"]);
    expect(h.model.getSnapshot().loadingMore).toBe(false);

    await h.model.loadMore();
    expect(h.calls.length).toBe(2); // no-op（cursor 取尽）
  });
});

describe("studyReferenceSearchModel · venue 归属（复核补修）", () => {
  it("source kind 下 setVenue 仅记录筛选不发请求；切入 question 后首屏携带 venue", async () => {
    const h = harness(); // 构造已发 1 次（source 首页）
    expect(h.calls.length).toBe(1);

    h.model.setVenue("cloze");
    await flush();
    expect(h.calls.length).toBe(1); // 不产生与请求无关的重复请求（venue 仅 question 生效）
    expect(h.model.getSnapshot().filters.venue).toBe("cloze"); // 已记录待用

    h.model.setKind("question");
    await flush();
    expect(h.calls.length).toBe(2);
    expect(h.calls[1]!.venue).toBe("cloze"); // 切入 question 后随首屏携带
    expect(h.calls[1]!.cursor).toBeUndefined();
  });
});
