/**
 * 学习笔记保存控制器定向测试（Task 07，先写失败测试再实现使其通过）。
 *
 * 通过注入 setTimer/clearTimer 驱动防抖与退避，不 sleep；
 * 通过 deferred Promise 构造真实在途状态（A/B 交错、结果不明重试、dispose 旧回包）。
 */

import { describe, expect, it, vi, type Mock } from "vitest";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import {
  StudyNoteConflictError,
  StudyNoteDisposedError,
  createStudyNoteSaveController,
  type StudyNoteEditSnapshot,
  type StudyNoteSaveController,
  type StudyNoteSaveRequest,
  type StudyNoteSaveResult,
  type StudyNoteSaveSnapshot,
} from "@/frontend/state/studyNoteSaveController";
import type { StudyNoteDto } from "@/domain/l3-study-notes";

const NOTE_ID = "00000000-0000-4000-8000-000000000701";
const REF_ID = "00000000-0000-4000-8000-000000000801";
const SOURCE_ID = "00000000-0000-4000-8000-000000000901";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flushMicrotasks = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

interface FakeTimers {
  setTimer: (fn: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  runPending: () => void;
  pendingCount: () => number;
  delays: () => number[];
}

function makeFakeTimers(): FakeTimers {
  let nextId = 1;
  let scheduled: Array<{ id: number; fn: () => void; delay: number }> = [];
  const allDelays: number[] = [];
  return {
    setTimer(fn, delayMs) {
      const id = nextId++;
      allDelays.push(delayMs);
      scheduled.push({ id, fn, delay: delayMs });
      return id;
    },
    clearTimer(handle) {
      scheduled = scheduled.filter((t) => t.id !== handle);
    },
    runPending() {
      const current = scheduled;
      scheduled = [];
      for (const t of current) t.fn();
    },
    pendingCount() {
      return scheduled.length;
    },
    delays() {
      return allDelays;
    },
  };
}

function makeEdit(overrides: Partial<StudyNoteEditSnapshot> = {}): StudyNoteEditSnapshot {
  return {
    title: "标题",
    bodyMd: "正文",
    venues: ["cloze"],
    pinned: false,
    status: "active",
    references: [],
    ...overrides,
  };
}

function makeDto(overrides: Partial<StudyNoteDto> = {}): StudyNoteDto {
  return {
    id: NOTE_ID,
    title: "服务器标题",
    bodyMd: "服务器正文",
    venues: ["cloze"],
    pinned: true,
    status: "active",
    version: 7,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T07:00:00.000Z",
    references: [
      {
        id: REF_ID,
        target: { kind: "source", sourceId: SOURCE_ID },
        status: "changed",
        capturedAt: "2026-09-20T01:00:00.000Z",
        displaySnapshot: { kind: "source", title: "来源", excerpt: "摘录" },
        liveTitle: "来源（新）",
      },
    ],
    ...overrides,
  };
}

type SaveFn = (input: StudyNoteSaveRequest) => Promise<StudyNoteSaveResult>;

function setupController(
  save: SaveFn,
  timers: FakeTimers,
  extra: {
    version?: number;
    baseline?: StudyNoteEditSnapshot;
    lastSavedAt?: string | null;
  } = {},
): StudyNoteSaveController {
  let requestCounter = 0;
  return createStudyNoteSaveController({
    noteId: NOTE_ID,
    version: extra.version ?? 3,
    baseline: extra.baseline ?? makeEdit(),
    lastSavedAt: extra.lastSavedAt ?? "2026-09-20T00:00:00.000Z",
    save,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    generateRequestId: () => `req-${++requestCounter}`,
  });
}

function deferredSave(): { save: Mock<SaveFn>; defers: Array<Deferred<StudyNoteSaveResult>> } {
  const defers: Array<Deferred<StudyNoteSaveResult>> = [];
  const save = vi.fn<SaveFn>(() => {
    const d = defer<StudyNoteSaveResult>();
    defers.push(d);
    return d.promise;
  });
  return { save, defers };
}

describe("保存控制器 · 单在途与序号纪律", () => {
  it("edit→防抖 800ms→发送成功→idle；连续 edit 合并为一次发送", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);

    controller.edit(makeEdit({ title: "A" }));
    controller.edit(makeEdit({ title: "AB" }));
    expect(save).not.toHaveBeenCalled();
    expect(timers.delays()).toContain(800);

    timers.runPending();
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].snapshot.title).toBe("AB");
    expect(save.mock.calls[0]![0].expectedVersion).toBe(3);
    expect(controller.getSnapshot().state).toBe("saving");

    defers[0]!.resolve({ version: 4, updatedAt: "2026-09-20T08:00:00.000Z" });
    await flushMicrotasks();
    const snapshot = controller.getSnapshot();
    expect(snapshot.state).toBe("idle");
    expect(snapshot.version).toBe(4);
    expect(snapshot.lastSavedAt).toBe("2026-09-20T08:00:00.000Z");
    expect(snapshot.savedSeq).toBe(2);
    expect(snapshot.inFlight).toBe(false);
  });

  it("A 在途编辑 B：A 只确认 A；B 不被覆盖/不标已保存；B 以新 requestId+新版本发送", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);

    controller.edit(makeEdit({ title: "A" }));
    timers.runPending();
    await flushMicrotasks();
    const first = save.mock.calls[0]![0] as StudyNoteSaveRequest;

    controller.edit(makeEdit({ title: "B" })); // A 在途
    defers[0]!.resolve({ version: 4, updatedAt: "t-a" });
    await flushMicrotasks();

    // B 自动续发：新 requestId、新版本、内容为 B
    expect(save).toHaveBeenCalledTimes(2);
    const second = save.mock.calls[1]![0] as StudyNoteSaveRequest;
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.expectedVersion).toBe(4);
    expect(second.snapshot.title).toBe("B");

    const mid = controller.getSnapshot();
    expect(mid.edit.title).toBe("B"); // 不被 A 回包覆盖
    expect(mid.savedSeq).toBe(1);
    expect(mid.editSeq).toBe(2);
    expect(mid.version).toBe(4);

    defers[1]!.resolve({ version: 5, updatedAt: "t-b" });
    await flushMicrotasks();
    expect(controller.getSnapshot().state).toBe("idle");
    expect(controller.getSnapshot().savedSeq).toBe(2);
  });

  it("发送载荷冻结：edit 后修改原对象/数组不影响已排队发送", async () => {
    const timers = makeFakeTimers();
    const { save } = deferredSave();
    const controller = setupController(save, timers);

    const refs = [{ id: REF_ID, action: "keep" as const }];
    const edit = makeEdit({ title: "orig", references: refs });
    controller.edit(edit);
    edit.title = "mutated";
    refs.push({ id: SOURCE_ID, action: "keep" });

    timers.runPending();
    await flushMicrotasks();
    const sent = save.mock.calls[0]![0].snapshot as StudyNoteEditSnapshot;
    expect(sent.title).toBe("orig");
    expect(sent.references).toEqual([{ id: REF_ID, action: "keep" }]);
  });

  it("无变化 edit 不推进序号、不调度发送", async () => {
    const timers = makeFakeTimers();
    const { save } = deferredSave();
    const controller = setupController(save, timers);

    controller.edit(makeEdit({ title: "same" }));
    const seqBefore = controller.getSnapshot().editSeq;
    controller.edit(makeEdit({ title: "same" }));
    expect(controller.getSnapshot().editSeq).toBe(seqBefore);
    expect(timers.pendingCount()).toBe(1); // 只有第一次调度的防抖
  });

  it("flush 等待调用时刻序号：期间新编辑排队，resolve 回执与确认版本绑定", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers, { version: 10 });

    controller.edit(makeEdit({ title: "A" }));
    const first = controller.flush(); // targetSeq = 1；触发发送（绕过防抖）
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(1);

    controller.edit(makeEdit({ title: "B" })); // 排队（editSeq=2）
    defers[0]!.resolve({ version: 11, updatedAt: "t-1" });
    await flushMicrotasks();

    await expect(first).resolves.toEqual({ version: 11, editSeq: 1, lastSavedAt: "t-1" });
    // B 继续发送（不被旧 resolve 截断）
    expect(save).toHaveBeenCalledTimes(2);
    const second = save.mock.calls[1]![0] as StudyNoteSaveRequest;
    expect(second.expectedVersion).toBe(11);
    expect(second.snapshot.title).toBe("B");
  });

  it("flush 在无待发内容时立即 resolve（回执指向已确认序号）", async () => {
    const timers = makeFakeTimers();
    const { save } = deferredSave();
    const controller = setupController(save, timers, { version: 9, lastSavedAt: "t0" });
    await expect(controller.flush()).resolves.toEqual({ version: 9, editSeq: 0, lastSavedAt: "t0" });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("保存控制器 · 重试与失败", () => {
  it("结果不明（网络错误）原样重试：退避 1/2/4s×3、载荷逐字节相同、耗尽进入 error 且 flush reject", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);

    controller.edit(makeEdit({ title: "T1" }));
    const flushPromise = controller.flush();
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(1);

    defers[0]!.reject(new Error("network down"));
    await flushMicrotasks();
    expect(controller.getSnapshot().state).toBe("retrying");

    // 依次「退避到期 → 原样重发 → 再失败」三轮；自动重试耗尽后进入 error
    for (let attempt = 0; attempt < 3; attempt += 1) {
      timers.runPending();
      await flushMicrotasks();
      defers[attempt + 1]!.reject(new Error("still down"));
      await flushMicrotasks();
    }
    expect(save).toHaveBeenCalledTimes(4); // 1 次 + 3 次自动重试

    const payloads = save.mock.calls.map((call) => call[0] as StudyNoteSaveRequest);
    for (const payload of payloads.slice(1)) {
      expect(payload.requestId).toBe(payloads[0]!.requestId);
      expect(payload.expectedVersion).toBe(payloads[0]!.expectedVersion);
      expect(payload.snapshot).toEqual(payloads[0]!.snapshot);
    }
    const backoffDelays = timers.delays().filter((delay) => delay !== 800);
    expect(backoffDelays).toEqual([1000, 2000, 4000]);

    expect(controller.getSnapshot().state).toBe("error");
    await expect(flushPromise).rejects.toBeTruthy();

    // 显式 retry：继续同一未确认请求（同 requestId/payload）
    const retryPromise = controller.retry();
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(5);
    const retried = save.mock.calls[4]![0] as StudyNoteSaveRequest;
    expect(retried.requestId).toBe(payloads[0]!.requestId);
    expect(retried.snapshot).toEqual(payloads[0]!.snapshot);
    defers[4]!.resolve({ version: 4, updatedAt: "t-final" });
    await retryPromise;
    expect(controller.getSnapshot().state).toBe("idle");
  });

  it("重试中途成功：savedSeq/version/lastSavedAt 前推", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);

    controller.edit(makeEdit({ title: "T1" }));
    const flushPromise = controller.flush();
    await flushMicrotasks();
    defers[0]!.reject(new Error("net"));
    await flushMicrotasks();
    timers.runPending(); // 退避 1s
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(2);
    defers[1]!.resolve({ version: 4, updatedAt: "t-ok" });
    await expect(flushPromise).resolves.toMatchObject({ version: 4, lastSavedAt: "t-ok" });
    expect(controller.getSnapshot().state).toBe("idle");
  });

  it("429 尊重 Retry-After（秒），重试保持有界", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);

    controller.edit(makeEdit({ title: "T1" }));
    const flushPromise = controller.flush();
    await flushMicrotasks();

    defers[0]!.reject(new BrowserApiError(429, { code: "RATE_LIMITED" }, new Headers({ "Retry-After": "3" })));
    await flushMicrotasks();
    const delays = timers.delays().filter((delay) => delay !== 800);
    expect(delays).toEqual([3000]); // 用 Retry-After=3s（而非退避 1s）

    timers.runPending();
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(2);
    // 仍保持 3 次自动重试上限：再失败 3 次（共 4 次尝试）后 error
    for (let attempt = 0; attempt < 3; attempt += 1) {
      defers[attempt + 1]!.reject(new BrowserApiError(429, { code: "RATE_LIMITED" }, new Headers({ "Retry-After": "1" })));
      await flushMicrotasks();
      if (attempt < 2) {
        timers.runPending();
        await flushMicrotasks();
      }
    }
    expect(controller.getSnapshot().state).toBe("error");
    await expect(flushPromise).rejects.toBeTruthy();
  });

  it("确定失败（401/422）不盲重试：一次失败即 error，输入保留", async () => {
    for (const status of [401, 422] as const) {
      const timers = makeFakeTimers();
      const { save, defers } = deferredSave();
      const controller = setupController(save, timers);

      controller.edit(makeEdit({ title: `S${status}` }));
      const flushPromise = controller.flush();
      await flushMicrotasks();
      defers[0]!.reject(new BrowserApiError(status, { error: "x", code: status === 401 ? "UNAUTHORIZED" : "VALIDATION_ERROR" }));
      await flushMicrotasks();
      expect(save).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().state).toBe("error");
      await expect(flushPromise).rejects.toBeTruthy();

      // error 态：edit 保留输入但不发送；flush 直接 reject
      controller.edit(makeEdit({ title: `S${status}-later` }));
      expect(controller.getSnapshot().edit.title).toBe(`S${status}-later`);
      expect(save).toHaveBeenCalledTimes(1);
      await expect(controller.flush()).rejects.toBeTruthy();
    }
  });

  it("重试退避期间的新编辑排队，不混入重试载荷；重试成功后以新 requestId 发送", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);

    controller.edit(makeEdit({ title: "A" }));
    const flushPromise = controller.flush();
    await flushMicrotasks();

    defers[0]!.reject(new Error("net"));
    await flushMicrotasks();
    controller.edit(makeEdit({ title: "B" })); // 排队

    timers.runPending();
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(2);
    const retried = save.mock.calls[1]![0] as StudyNoteSaveRequest;
    expect(retried.snapshot.title).toBe("A"); // 重试仍是 A
    expect(retried.requestId).toBe((save.mock.calls[0]![0] as StudyNoteSaveRequest).requestId);

    defers[1]!.resolve({ version: 4, updatedAt: "t-a" });
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(3);
    const next = save.mock.calls[2]![0] as StudyNoteSaveRequest;
    expect(next.snapshot.title).toBe("B");
    expect(next.requestId).not.toBe(retried.requestId);
    expect(next.expectedVersion).toBe(4);
    defers[2]!.resolve({ version: 5, updatedAt: "t-b" });
    await expect(flushPromise).resolves.toMatchObject({ editSeq: 1, version: 4 });
    await flushMicrotasks();
    expect(controller.getSnapshot().state).toBe("idle");
  });
});

describe("保存控制器 · 409 冲突与恢复", () => {
  it("409 立即停自动写：conflict 帧、currentVersion 不猜、flush reject、本地输入保留", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);

    controller.edit(makeEdit({ title: "local" }));
    const flushPromise = controller.flush();
    await flushMicrotasks();
    defers[0]!.reject(
      new BrowserApiError(409, { code: "CONFLICT", details: { noteId: NOTE_ID, currentVersion: 5 } }),
    );
    await flushMicrotasks();

    const snapshot = controller.getSnapshot();
    expect(snapshot.state).toBe("conflict");
    expect(snapshot.conflictCurrentVersion).toBe(5);
    expect(snapshot.edit.title).toBe("local");
    await expect(flushPromise).rejects.toBeInstanceOf(StudyNoteConflictError);
    expect(save).toHaveBeenCalledTimes(1);

    // conflict 态：不再自动写；flush/retry 均 reject（不做「确认已合并后重试」）
    controller.edit(makeEdit({ title: "local-2" }));
    expect(controller.getSnapshot().edit.title).toBe("local-2");
    expect(save).toHaveBeenCalledTimes(1);
    await expect(controller.flush()).rejects.toBeInstanceOf(StudyNoteConflictError);
    await expect(controller.retry()).rejects.toBeInstanceOf(StudyNoteConflictError);
  });

  it("409 未携带 currentVersion → null（不猜数值）", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);

    controller.edit(makeEdit({ title: "x" }));
    const flushPromise = controller.flush();
    await flushMicrotasks();
    defers[0]!.reject(new BrowserApiError(409, { code: "CONFLICT", details: { noteId: NOTE_ID } }));
    await flushMicrotasks();
    expect(controller.getSnapshot().conflictCurrentVersion).toBeNull();
    await expect(flushPromise).rejects.toBeInstanceOf(StudyNoteConflictError);
  });

  it("adoptServerSnapshot：重建基线、idle、后续以新版本保存", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);

    controller.edit(makeEdit({ title: "local" }));
    const flushPromise = controller.flush();
    await flushMicrotasks();
    defers[0]!.reject(new BrowserApiError(409, { code: "CONFLICT", details: { currentVersion: 7 } }));
    await flushMicrotasks();
    await expect(flushPromise).rejects.toBeTruthy();

    controller.adoptServerSnapshot(makeDto());
    const adopted = controller.getSnapshot();
    expect(adopted.state).toBe("idle");
    expect(adopted.version).toBe(7);
    expect(adopted.lastSavedAt).toBe("2026-09-20T07:00:00.000Z");
    expect(adopted.edit.title).toBe("服务器标题");
    expect(adopted.edit.pinned).toBe(true);
    expect(adopted.edit.references).toEqual([{ id: REF_ID, action: "keep" }]);
    expect(adopted.conflictCurrentVersion).toBeNull();

    // adopt 后 flush 立即可 resolve（基线即服务器状态）
    await expect(controller.flush()).resolves.toMatchObject({ version: 7, lastSavedAt: "2026-09-20T07:00:00.000Z" });

    // 重新编辑 → 以 adopt 版本为基线发送
    controller.edit(makeEdit({ title: "重新编辑", pinned: true }));
    timers.runPending();
    await flushMicrotasks();
    const sent = save.mock.calls[1]![0] as StudyNoteSaveRequest;
    expect(sent.expectedVersion).toBe(7);
    expect(sent.snapshot.title).toBe("重新编辑");
  });

  it("非本笔记 id 的 adopt 被拒绝（身份防线）", async () => {
    const timers = makeFakeTimers();
    const { save } = deferredSave();
    const controller = setupController(save, timers);
    controller.adoptServerSnapshot(makeDto({ id: "00000000-0000-4000-8000-0000000007ff" }));
    expect(controller.getSnapshot().edit.title).toBe("标题"); // 未变
  });
});

describe("保存控制器 · 订阅终态 / dispose / 代际", () => {
  it("订阅者收到『释放 inFlight 后』的稳定终态帧（idle/error/conflict 均 inFlight=false）", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);
    const frames: StudyNoteSaveSnapshot[] = [];
    controller.subscribe(() => frames.push(controller.getSnapshot()));

    // 成功路径终态
    controller.edit(makeEdit({ title: "ok" }));
    timers.runPending();
    await flushMicrotasks();
    defers[0]!.resolve({ version: 4, updatedAt: "t" });
    await flushMicrotasks();
    const successFrames = frames.filter((frame) => frame.state === "idle");
    expect(successFrames.length).toBeGreaterThan(0);
    expect(successFrames.every((frame) => !frame.inFlight)).toBe(true);

    // 失败路径终态
    const timers2 = makeFakeTimers();
    const second = deferredSave();
    const controller2 = setupController(second.save, timers2);
    const frames2: StudyNoteSaveSnapshot[] = [];
    controller2.subscribe(() => frames2.push(controller2.getSnapshot()));
    controller2.edit(makeEdit({ title: "err" }));
    const flush2 = controller2.flush();
    await flushMicrotasks();
    second.defers[0]!.reject(new BrowserApiError(422, { code: "VALIDATION_ERROR" }));
    await flushMicrotasks();
    await expect(flush2).rejects.toBeTruthy();
    const errorFrames = frames2.filter((frame) => frame.state === "error");
    expect(errorFrames.length).toBeGreaterThan(0);
    expect(errorFrames.every((frame) => !frame.inFlight)).toBe(true);
  });

  it("dispose：等待者 reject、不再通知、旧回包不污染、后续 edit no-op", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);
    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });

    controller.edit(makeEdit({ title: "A" }));
    const flushPromise = controller.flush();
    await flushMicrotasks();

    controller.dispose();
    await expect(flushPromise).rejects.toBeInstanceOf(StudyNoteDisposedError);
    expect(controller.isDisposed()).toBe(true);
    const notificationsAtDispose = notifications;

    // 旧回包到达：不触发通知、不写状态；旧 edit 也不生效
    defers[0]!.resolve({ version: 99, updatedAt: "late" });
    await flushMicrotasks();
    controller.edit(makeEdit({ title: "B" }));
    expect(notifications).toBe(notificationsAtDispose);
    expect(controller.getSnapshot().edit.title).toBe("A");
    expect(controller.getSnapshot().version).toBe(3);
    await expect(controller.flush()).rejects.toBeInstanceOf(StudyNoteDisposedError);
  });

  it("退避等待中 dispose：取消计时器、不再发送新请求", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);

    controller.edit(makeEdit({ title: "A" }));
    const flushPromise = controller.flush();
    await flushMicrotasks();
    defers[0]!.reject(new Error("net"));
    await flushMicrotasks();
    expect(controller.getSnapshot().state).toBe("retrying");

    controller.dispose();
    await expect(flushPromise).rejects.toBeInstanceOf(StudyNoteDisposedError);
    timers.runPending();
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(1); // 无新请求
  });

  it("StrictMode 场景：旧控制器 dispose 后，新控制器独立工作，旧回包不影响新控制器", async () => {
    const timers = makeFakeTimers();
    const first = deferredSave();
    const oldController = setupController(first.save, timers);

    oldController.edit(makeEdit({ title: "old" }));
    const staleFlush = oldController.flush();
    await flushMicrotasks();

    // 模拟「卸载→再挂载」：旧实例 dispose，建立全新实例
    oldController.dispose();
    await expect(staleFlush).rejects.toBeInstanceOf(StudyNoteDisposedError);
    const timers2 = makeFakeTimers();
    const second = deferredSave();
    const fresh = setupController(second.save, timers2);

    // 旧回包此刻到达 → 只能被丢弃
    first.defers[0]!.resolve({ version: 42, updatedAt: "old" });
    await flushMicrotasks();

    fresh.edit(makeEdit({ title: "fresh" }));
    timers2.runPending();
    await flushMicrotasks();
    expect(second.save).toHaveBeenCalledTimes(1);
    second.defers[0]!.resolve({ version: 4, updatedAt: "new" });
    await flushMicrotasks();
    const snapshot = fresh.getSnapshot();
    expect(snapshot.state).toBe("idle");
    expect(snapshot.version).toBe(4);
    expect(snapshot.edit.title).toBe("fresh");
  });
});

describe("保存控制器 · IME 合成", () => {
  it("composition 期间不发送（含防抖到期不触发）；compositionend 后按防抖补发", async () => {
    const timers = makeFakeTimers();
    const { save, defers } = deferredSave();
    const controller = setupController(save, timers);

    controller.setComposing(true);
    controller.edit(makeEdit({ title: "拼" }));
    timers.runPending(); // 防抖到期但仍在合成
    await flushMicrotasks();
    expect(save).not.toHaveBeenCalled();

    controller.edit(makeEdit({ title: "拼音" }));
    controller.setComposing(false);
    timers.runPending(); // compositionend 后补发的防抖
    await flushMicrotasks();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].snapshot.title).toBe("拼音");
    defers[0]!.resolve({ version: 4, updatedAt: "t" });
    await flushMicrotasks();
    expect(controller.getSnapshot().state).toBe("idle");
  });
});
