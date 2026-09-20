/**
 * Task 08 · 笔记列表模型测试（先红后绿）。
 *
 * 覆盖：分页跨页去重、筛选变化清 cursor、topicId 与 unfiled 互斥、
 * 搜索 300ms 防抖、请求序号守卫（旧响应丢弃）、total 透传、错误重试、dispose。
 */
import { describe, expect, it } from "vitest";
import type { StudyNoteSummary } from "@/domain/l3-study-notes";
import { createStudyNoteListModel } from "@/frontend/state/studyNoteListModel";

// ── 工具 ────────────────────────────────────────────────────────────────────

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 手动计时器（与 save controller 测试同构）。 */
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
      return tasks.length; // 剩余任务数
    },
    pendingDelays: () => tasks.map((task) => task.at - now),
  };
}

function makeNote(id: string, overrides: Partial<StudyNoteSummary> = {}): StudyNoteSummary {
  return {
    id,
    title: `笔记 ${id.slice(-2)}`,
    venues: ["cloze"],
    pinned: false,
    status: "active",
    version: 1,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

const ID_A = "00000000-0000-4000-8000-0000000000a1";
const ID_B = "00000000-0000-4000-8000-0000000000b1";
const ID_C = "00000000-0000-4000-8000-0000000000c1";
const TOPIC_ID = "00000000-0000-4000-8000-000000000901";

interface Harness {
  model: ReturnType<typeof createStudyNoteListModel>;
  calls: Array<Record<string, unknown>>;
  deferreds: Array<Deferred<{ items: StudyNoteSummary[]; total: number; nextCursor: string | null }>>;
  timers: ReturnType<typeof makeTimers>;
}

function harness(): Harness {
  const calls: Array<Record<string, unknown>> = [];
  const deferreds: Array<Deferred<{ items: StudyNoteSummary[]; total: number; nextCursor: string | null }>> = [];
  const timers = makeTimers();
  const model = createStudyNoteListModel({
    fetchPage: (query) => {
      calls.push(query as unknown as Record<string, unknown>);
      const d = defer<{ items: StudyNoteSummary[]; total: number; nextCursor: string | null }>();
      deferreds.push(d);
      return d.promise;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { model, calls, deferreds, timers };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ── 用例 ────────────────────────────────────────────────────────────────────

describe("studyNoteListModel · 加载与分页", () => {
  it("setVenue 触发首页请求：venue 传入、无 cursor；结果就绪（items/total/nextCursor）", async () => {
    const { model, calls, deferreds } = harness();
    model.setVenue("cloze");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ venue: "cloze" });
    expect(calls[0]!.cursor).toBeUndefined();

    deferreds[0]!.resolve({ items: [makeNote(ID_A), makeNote(ID_B)], total: 25, nextCursor: "C1" });
    await flushMicrotasks();
    const snap = model.getSnapshot();
    expect(snap.state).toBe("ready");
    expect(snap.items.map((i) => i.id)).toEqual([ID_A, ID_B]);
    expect(snap.total).toBe(25);
    expect(snap.nextCursor).toBe("C1");
  });

  it("loadMore：带 cursor 请求、跨页按 id 去重、nextCursor 更新", async () => {
    const { model, calls, deferreds } = harness();
    model.setVenue("cloze");
    deferreds[0]!.resolve({ items: [makeNote(ID_A), makeNote(ID_B)], total: 3, nextCursor: "C1" });
    await flushMicrotasks();

    model.loadMore();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.cursor).toBe("C1");
    // 第二页含重复 ID_B + 新 ID_C
    deferreds[1]!.resolve({ items: [makeNote(ID_B), makeNote(ID_C)], total: 3, nextCursor: null });
    await flushMicrotasks();
    const snap = model.getSnapshot();
    expect(snap.items.map((i) => i.id)).toEqual([ID_A, ID_B, ID_C]);
    expect(snap.nextCursor).toBeNull();
    expect(snap.loadingMore).toBe(false);
  });

  it("无 nextCursor 时 loadMore 不发请求", async () => {
    const { model, calls, deferreds } = harness();
    model.setVenue("cloze");
    deferreds[0]!.resolve({ items: [makeNote(ID_A)], total: 1, nextCursor: null });
    await flushMicrotasks();
    model.loadMore();
    expect(calls).toHaveLength(1);
  });
});

describe("studyNoteListModel · 筛选与游标失效", () => {
  it("筛选变化（topicId/status/pinned）清 cursor、清 items、重置请求", async () => {
    const { model, calls, deferreds } = harness();
    model.setVenue("cloze");
    deferreds[0]!.resolve({ items: [makeNote(ID_A)], total: 25, nextCursor: "C1" });
    await flushMicrotasks();
    model.loadMore();
    deferreds[1]!.resolve({ items: [makeNote(ID_B)], total: 25, nextCursor: "C2" });
    await flushMicrotasks();

    model.setTopic(TOPIC_ID);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.topicId).toBe(TOPIC_ID);
    expect(calls[2]!.cursor).toBeUndefined(); // 清 cursor
    expect(model.getSnapshot().items).toEqual([]); // 列表重置
    expect(model.getSnapshot().state).toBe("loading");

    deferreds[2]!.resolve({ items: [makeNote(ID_C)], total: 1, nextCursor: null });
    await flushMicrotasks();

    model.setStatus("archived");
    expect(calls).toHaveLength(4);
    expect(calls[3]!.status).toBe("archived");
    expect(calls[3]!.cursor).toBeUndefined();
  });

  it("topicId 与 unfiled 互斥：setTopic 清 unfiled；setUnfiled 清 topicId", async () => {
    const { model, calls, deferreds } = harness();
    model.setVenue("cloze");
    deferreds[0]!.resolve({ items: [], total: 0, nextCursor: null });
    await flushMicrotasks();

    model.setUnfiled(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ venue: "cloze", unfiled: true });
    expect(calls[1]!.topicId).toBeUndefined();

    model.setTopic(TOPIC_ID);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.unfiled).toBeUndefined(); // 已互斥清除
    expect(calls[2]!.topicId).toBe(TOPIC_ID);

    model.setUnfiled(true);
    expect(calls).toHaveLength(4);
    expect(calls[3]!.topicId).toBeUndefined(); // 已互斥清除
    expect(calls[3]!.unfiled).toBe(true);

    // 清理未决请求（防未处理拒绝）
    for (const d of deferreds) d.resolve({ items: [], total: 0, nextCursor: null });
    await flushMicrotasks();
  });

  it("同值设置不触发新请求", async () => {
    const { model, calls, deferreds } = harness();
    model.setVenue("cloze");
    deferreds[0]!.resolve({ items: [], total: 0, nextCursor: null });
    await flushMicrotasks();
    model.setVenue("cloze");
    model.setQuery("");
    expect(calls).toHaveLength(1);
  });
});

describe("studyNoteListModel · 搜索防抖与竞态", () => {
  it("搜索：连续输入仅防抖后发一次请求（q=最后值），期间不发", async () => {
    const { model, calls, deferreds, timers } = harness();
    model.setVenue("cloze");
    deferreds[0]!.resolve({ items: [], total: 0, nextCursor: null });
    await flushMicrotasks();

    model.setQuery("a");
    model.setQuery("ab");
    model.setQuery("abc");
    expect(calls).toHaveLength(1); // 仅初始列表请求
    expect(timers.runPending()).toBe(0); // 执行防抖
    expect(calls).toHaveLength(2);
    expect(calls[1]!.q).toBe("abc");
    deferreds[1]!.resolve({ items: [], total: 0, nextCursor: null });
    await flushMicrotasks();
  });

  it("请求序号守卫：旧响应晚到被丢弃，不覆盖新结果", async () => {
    const { model, calls, deferreds, timers } = harness();
    model.setVenue("cloze");
    deferreds[0]!.resolve({ items: [makeNote(ID_A)], total: 25, nextCursor: null });
    await flushMicrotasks();

    model.setQuery("old");
    timers.runPending(); // 发出请求 #2（q=old）
    expect(calls).toHaveLength(2);

    model.setQuery("new");
    timers.runPending(); // 发出请求 #3（q=new）
    expect(calls).toHaveLength(3);

    // 新请求先回
    deferreds[2]!.resolve({ items: [makeNote(ID_B)], total: 1, nextCursor: null });
    await flushMicrotasks();
    // 旧请求后回：被丢弃
    deferreds[1]!.resolve({ items: [makeNote(ID_C)], total: 99, nextCursor: "CX" });
    await flushMicrotasks();

    const snap = model.getSnapshot();
    expect(snap.items.map((i) => i.id)).toEqual([ID_B]);
    expect(snap.total).toBe(1);
    expect(snap.nextCursor).toBeNull();
  });

  it("防抖期间切换其他筛选：立即请求且携带最新 q（取消挂起防抖）", async () => {
    const { model, calls, deferreds, timers } = harness();
    model.setVenue("cloze");
    deferreds[0]!.resolve({ items: [], total: 0, nextCursor: null });
    await flushMicrotasks();

    model.setQuery("kw");
    model.setStatus("archived"); // 立即请求（清 cursor）
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ q: "kw", status: "archived" });
    expect(timers.runPending()).toBe(0); // 原防抖已被取消
    deferreds[1]!.resolve({ items: [], total: 0, nextCursor: null });
    await flushMicrotasks();
  });
});

describe("studyNoteListModel · 错误与生命周期", () => {
  it("请求失败 → error 状态；refresh 重试成功恢复", async () => {
    const { model, calls, deferreds } = harness();
    model.setVenue("cloze");
    deferreds[0]!.reject(new Error("boom"));
    await flushMicrotasks();
    expect(model.getSnapshot().state).toBe("error");
    expect(model.getSnapshot().error).toBeTruthy();

    model.refresh();
    expect(calls).toHaveLength(2);
    deferreds[1]!.resolve({ items: [makeNote(ID_A)], total: 1, nextCursor: null });
    await flushMicrotasks();
    expect(model.getSnapshot().state).toBe("ready");
    expect(model.getSnapshot().items).toHaveLength(1);
  });

  it("refresh 保留旧列表直至新数据到达（不闪空）", async () => {
    const { model, deferreds } = harness();
    model.setVenue("cloze");
    deferreds[0]!.resolve({ items: [makeNote(ID_A)], total: 1, nextCursor: null });
    await flushMicrotasks();

    model.refresh();
    expect(model.getSnapshot().items).toHaveLength(1); // 保留
    deferreds[1]!.resolve({ items: [makeNote(ID_B)], total: 1, nextCursor: null });
    await flushMicrotasks();
    expect(model.getSnapshot().items.map((i) => i.id)).toEqual([ID_B]);
  });

  it("dispose：后续响应丢弃、不再发起请求、无未处理异常", async () => {
    const { model, calls, deferreds } = harness();
    model.setVenue("cloze");
    model.dispose();
    expect(model.isDisposed()).toBe(true);
    deferreds[0]!.resolve({ items: [makeNote(ID_A)], total: 1, nextCursor: null });
    await flushMicrotasks();
    expect(model.getSnapshot().items).toEqual([]);
    model.setVenue("cloze");
    expect(calls).toHaveLength(1);
  });
});
