/**
 * W4 保存控制器定向测试（先写失败测试，再实现使其通过）。
 *
 * 通过注入的 setTimer/clearTimer 驱动防抖与退避，不 sleep。
 * 通过 deferred Promise 构造真实在途状态，不以 snapshot 模拟实现。
 */

import { describe, expect, it, vi } from "vitest";
import {
  createWritingSaveController,
  SaveConflictError,
  SaveDisposedError,
  type WritingSaveControllerLoadResult,
  type WritingSaveControllerSaveResult,
} from "@/frontend/state/writingSaveController";

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

const flushMicrotasks = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

/** flush() 后首拒已排 backoff1；逐轮触发退避并消化微任务，共 rounds 次重发。 */
async function exhaustRetries(timers: FakeTimers, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    timers.runPending();
    await flushMicrotasks();
  }
}

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

type SaveFn = (input: { text: string; expectedVersion: number }) => Promise<WritingSaveControllerSaveResult>;
type LoadFn = () => Promise<WritingSaveControllerLoadResult>;

function setupController(
  save: SaveFn,
  timers: FakeTimers,
  extra: { version?: number; text?: string; load?: LoadFn } = {},
) {
  return createWritingSaveController({
    text: extra.text ?? "",
    version: extra.version ?? 0,
    save,
    load: extra.load,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
}

describe("W4 保存控制器 · 单在途与序号纪律", () => {
  it("setText→flush→setText→flush：首个 resolve 前只发 1 次，resolve 后自动续发，两次后 clean（任务书验收）", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const load = vi.fn();
    const defers: Deferred<WritingSaveControllerSaveResult>[] = [];
    save.mockImplementation(() => {
      const d = defer<WritingSaveControllerSaveResult>();
      defers.push(d);
      return d.promise;
    });

    const controller = setupController(save, timers, { load });

    controller.setText("A");
    const first = controller.flush();
    controller.setText("AB");
    const second = controller.flush();

    expect(save).toHaveBeenCalledTimes(1);

    defers[0]!.resolve({ draftVersion: 1, textSha256: "hashA" });
    await flushMicrotasks();

    expect(save).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().text).toBe("AB"); // 旧响应不覆盖之后的本地输入

    defers[1]!.resolve({ draftVersion: 2, textSha256: "hashAB" });
    await Promise.all([first, second]);

    expect(controller.getSnapshot().state).toBe("clean");
  });

  it("响应只确认其发送序号：本地文本恒为最新，version 随确认推进", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const defers: Deferred<WritingSaveControllerSaveResult>[] = [];
    save.mockImplementation(() => {
      const d = defer<WritingSaveControllerSaveResult>();
      defers.push(d);
      return d.promise;
    });
    const controller = setupController(save, timers);

    controller.setText("first");
    const f1 = controller.flush();
    controller.setText("second");
    controller.flush();

    defers[0]!.resolve({ draftVersion: 1, textSha256: "h1" });
    await flushMicrotasks();

    // 第一个响应确认的是 'first'，但本地已变为 'second'
    expect(controller.getSnapshot().text).toBe("second");
    expect(controller.getSnapshot().version).toBe(1);

    defers[1]!.resolve({ draftVersion: 2, textSha256: "h2" });
    await f1;
    expect(controller.getSnapshot().version).toBe(2);
  });

  it("多个并发 flush 共享同一等待，不重复发请求", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const defers: Deferred<WritingSaveControllerSaveResult>[] = [];
    save.mockImplementation(() => {
      const d = defer<WritingSaveControllerSaveResult>();
      defers.push(d);
      return d.promise;
    });
    const controller = setupController(save, timers);

    controller.setText("X");
    const a = controller.flush();
    const b = controller.flush();

    expect(save).toHaveBeenCalledTimes(1);

    defers[0]!.resolve({ draftVersion: 1, textSha256: "h" });
    await Promise.all([a, b]);

    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().state).toBe("clean");
  });

  it("已 clean 时 flush 立即 resolve 回执（初值），不发请求", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const controller = setupController(save, timers, { text: "初始", version: 3 });
    await expect(controller.flush()).resolves.toEqual({ text: "初始", version: 3 });
    expect(save).not.toHaveBeenCalled();
  });

  it("flush 回执=已确认正文+版本（提交屏障核对基线；推进后回执同步）", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const first = defer<WritingSaveControllerSaveResult>();
    save.mockReturnValueOnce(first.promise);
    const controller = setupController(save, timers);

    controller.setText("A");
    const f1 = controller.flush();
    first.resolve({ draftVersion: 1, textSha256: "a".repeat(64) });
    await expect(f1).resolves.toEqual({ text: "A", version: 1 }); // 回执=本次发送的正文与确认版本

    const second = defer<WritingSaveControllerSaveResult>();
    save.mockReturnValueOnce(second.promise);
    controller.setText("AB");
    const f2 = controller.flush();
    second.resolve({ draftVersion: 2, textSha256: "b".repeat(64) });
    await expect(f2).resolves.toEqual({ text: "AB", version: 2 });
  });
});

describe("W10 修复 · 本地输入必须同步通知（受控输入可见性）", () => {
  it("setText 立即通知订阅者且快照同步；未确认前不发请求", () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const controller = setupController(save, timers);
    const seen: string[] = [];
    controller.subscribe(() => { seen.push(controller.getSnapshot().text); });

    controller.setText("第一版");
    expect(seen.length).toBeGreaterThan(0); // 旧实现：0 次通知（React 会把受控值回滚到旧快照）
    expect(controller.getSnapshot().text).toBe("第一版");
    expect(controller.getSnapshot().state).toBe("dirty");

    controller.setText("第一版加料"); // 连续输入（state 已是 dirty）也必须再次通知
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe("第一版加料");
    expect(save).not.toHaveBeenCalled(); // 尚未到防抖：不发请求
  });

  it("相同文本重复 setText 幂等（不产生多余通知）", () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const controller = setupController(save, timers);
    controller.setText("同文");
    let calls = 0;
    controller.subscribe(() => { calls += 1; });
    controller.setText("同文");
    expect(calls).toBe(0);
  });
});

describe("W4 保存控制器 · 退避与重试策略", () => {
  it("网络错误自动重试 3 次，退避 1/2/4 秒，耗尽后 error（load 未注入→unknown）", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    save.mockRejectedValue(new Error("network down")); // 无 status → 网络/超时
    const controller = setupController(save, timers); // 无 load

    controller.setText("x");
    const p = controller.flush();
    expect(save).toHaveBeenCalledTimes(1);

    await flushMicrotasks(); // 首拒排 backoff1
    await exhaustRetries(timers);

    expect(save).toHaveBeenCalledTimes(4);
    await flushMicrotasks();
    await expect(p).rejects.toBeDefined();
    expect(controller.getSnapshot().state).toBe("error");
    // 退避序列为 1/2/4 秒（首位的 800 是 flush 已取消的防抖，不计入重试）
    expect(timers.delays().slice(-3)).toEqual([1000, 2000, 4000]);
  });

  it("429 视为可重试，走同样退避且最终 error", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    save.mockRejectedValue(Object.assign(new Error("too many"), { status: 429 }));
    const controller = setupController(save, timers);

    controller.setText("x");
    const p = controller.flush();
    await flushMicrotasks(); // 首拒排 backoff1
    await exhaustRetries(timers);

    expect(save).toHaveBeenCalledTimes(4);
    await flushMicrotasks();
    await expect(p).rejects.toBeDefined();
    expect(controller.getSnapshot().state).toBe("error");
  });

  it("401 / 400 / 422 不自动重试：只发 1 次并进入 error", async () => {
    for (const status of [401, 400, 422]) {
      const timers = makeFakeTimers();
      const save = vi.fn<SaveFn>();
      save.mockRejectedValue(Object.assign(new Error(`status ${status}`), { status }));
      const controller = setupController(save, timers);

      controller.setText("x");
      const p = controller.flush();
      await expect(p).rejects.toBeDefined();

      expect(save).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().state).toBe("error");
      expect(timers.pendingCount()).toBe(0);
    }
  });

  it("409 不自动重试：state=conflict，且 retry() 手动重试始终可用", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    save.mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 }));
    const controller = setupController(save, timers);

    controller.setText("x");
    const p = controller.flush();
    await expect(p).rejects.toBeInstanceOf(SaveConflictError);
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().state).toBe("conflict");

    // 手动重试：再次发出请求（即便仍会 409，也保持可用）
    const p2 = controller.retry();
    expect(save).toHaveBeenCalledTimes(2);
    await expect(p2).rejects.toBeInstanceOf(SaveConflictError);
    expect(controller.getSnapshot().state).toBe("conflict");
  });

  it("失败后 retry() 可重新尝试并成功", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const defers: Deferred<WritingSaveControllerSaveResult>[] = [];
    let callCount = 0;
    save.mockImplementation(() => {
      callCount += 1;
      if (callCount <= 4) {
        // 前 4 次（首次 + 3 退避）失败，触发 error
        return Promise.reject(Object.assign(new Error("boom"), { status: 500 }));
      }
      const d = defer<WritingSaveControllerSaveResult>();
      defers.push(d);
      return d.promise;
    });
    const controller = setupController(save, timers, { version: 0 });

    controller.setText("x");
    const first = controller.flush();
    await flushMicrotasks(); // 首拒排 backoff1
    await exhaustRetries(timers);

    await flushMicrotasks();
    await expect(first).rejects.toBeDefined();
    expect(controller.getSnapshot().state).toBe("error");

    // 手动重试：这次成功（第 5 次调用走 defer 成功路径）
    const p2 = controller.retry();
    expect(save).toHaveBeenCalledTimes(5);
    defers[0]!.resolve({ draftVersion: 1, textSha256: "h" });
    await p2;
    expect(controller.getSnapshot().state).toBe("clean");
  });
});

describe("W4 保存控制器 · 防抖与 IME", () => {
  it("800ms 防抖：不 flush 时到点才发；flush 立即发并取消防抖 timer", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const defers: Deferred<WritingSaveControllerSaveResult>[] = [];
    save.mockImplementation(() => {
      const d = defer<WritingSaveControllerSaveResult>();
      defers.push(d);
      return d.promise;
    });
    const controller = setupController(save, timers);

    controller.setText("hello");
    expect(save).not.toHaveBeenCalled();
    expect(timers.pendingCount()).toBe(1); // 已排一个 800ms 防抖

    // flush 立即发送并取消防抖
    const p = controller.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(timers.pendingCount()).toBe(0);

    defers[0]!.resolve({ draftVersion: 1, textSha256: "h" });
    await p;
    expect(controller.getSnapshot().state).toBe("clean");
  });

  it("IME 合成期间不发；compositionend 后按防抖补发", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const controller = setupController(save, timers);

    controller.setText("hello");
    controller.setComposing(true);
    controller.setText("hello world"); // 合成中继续输入
    expect(save).not.toHaveBeenCalled();
    expect(controller.getSnapshot().text).toBe("hello world"); // 本地文本仍更新

    controller.setComposing(false); // compositionend → 排队补发
    expect(save).not.toHaveBeenCalled(); // 仍等待防抖

    timers.runPending(); // 触发 800ms 防抖
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ text: "hello world", expectedVersion: 0 });
  });

  it("合成中即使防抖到点也不发", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const controller = setupController(save, timers);

    controller.setText("a");
    controller.setComposing(true);
    timers.runPending(); // 防抖到点，但仍在合成
    expect(save).not.toHaveBeenCalled();
  });
});

describe("W4 保存控制器 · 超时恢复（S§4）", () => {
  it("网络失败后 load 确认服务端内容=已发送且 version=旧+1 → 回到 clean", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    save.mockRejectedValue(new Error("network")); // 无 status
    const load = vi.fn<LoadFn>();
    load.mockResolvedValue({ text: "x", version: 1 }); // expectedVersion 0 + 1
    const controller = setupController(save, timers, { version: 0, load });

    controller.setText("x");
    const p = controller.flush();
    await flushMicrotasks(); // 首拒排 backoff1
    await exhaustRetries(timers);

    expect(save).toHaveBeenCalledTimes(4);
    expect(load).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
    await expect(p).resolves.toEqual({ text: "x", version: 1 }); // 回执=已发送正文+确认版本
    expect(controller.getSnapshot().state).toBe("clean");
    expect(controller.getSnapshot().version).toBe(1);
  });

  it("网络失败后 load 内容不符 → 进入 conflict 语义（不自动 last-wins）", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    save.mockRejectedValue(new Error("network"));
    const load = vi.fn<LoadFn>();
    load.mockResolvedValue({ text: "server-other", version: 99 });
    const controller = setupController(save, timers, { version: 0, load });

    controller.setText("x");
    const p = controller.flush();
    await flushMicrotasks(); // 首拒排 backoff1
    await exhaustRetries(timers);
    await flushMicrotasks();

    await expect(p).rejects.toBeInstanceOf(SaveConflictError);
    expect(controller.getSnapshot().state).toBe("conflict");
    expect(controller.getSnapshot().text).toBe("x"); // 保留本地文本
  });

  it("网络失败后 load 显示服务器未变（同版本同已确认正文）→ 诚实 error（尚未保存）而非 conflict；手动重试可恢复", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    save.mockRejectedValue(new Error("network"));
    const load = vi.fn<LoadFn>();
    load.mockResolvedValue({ text: "", version: 0 }); // 服务器仍是初态（从未保存成功）
    const controller = setupController(save, timers, { version: 0, load });

    controller.setText("x");
    const p = controller.flush();
    await flushMicrotasks();
    await exhaustRetries(timers);
    await flushMicrotasks();

    await expect(p).rejects.toBeDefined();
    expect(controller.getSnapshot().state).toBe("error"); // 诚实"尚未保存"，不误报"另一处更新"
    expect(controller.getSnapshot().text).toBe("x"); // 本地正文保留

    // 手动重试可恢复（S§2 写入失败态的可执行动作）。
    const deferredSave = defer<WritingSaveControllerSaveResult>();
    save.mockReset();
    save.mockReturnValueOnce(deferredSave.promise);
    const retryP = controller.retry();
    deferredSave.resolve({ draftVersion: 1, textSha256: "a".repeat(64) });
    await expect(retryP).resolves.toBeUndefined();
    expect(controller.getSnapshot().state).toBe("clean");
    expect(controller.getSnapshot().version).toBe(1);
  });

  it("网络失败后 load 失败 → 无法确认，进入 error", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    save.mockRejectedValue(new Error("network"));
    const load = vi.fn<LoadFn>();
    load.mockRejectedValue(new Error("load failed"));
    const controller = setupController(save, timers, { version: 0, load });

    controller.setText("x");
    const p = controller.flush();
    await flushMicrotasks(); // 首拒排 backoff1
    await exhaustRetries(timers);
    await flushMicrotasks();
    timers.runPending();
    await flushMicrotasks();
    timers.runPending();
    await flushMicrotasks();
    await flushMicrotasks();

    await expect(p).rejects.toBeDefined();
    expect(controller.getSnapshot().state).toBe("error");
  });
});

describe("W4 保存控制器 · dispose", () => {
  it("dispose 清理 timer/listener，不伪造成功，在途响应被丢弃", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const defers: Deferred<WritingSaveControllerSaveResult>[] = [];
    save.mockImplementation(() => {
      const d = defer<WritingSaveControllerSaveResult>();
      defers.push(d);
      return d.promise;
    });
    const controller = setupController(save, timers);

    controller.setText("x");
    const p = controller.flush(); // save 在途（defers[0]）
    controller.dispose();

    defers[0]!.resolve({ draftVersion: 1, textSha256: "h" });
    await flushMicrotasks();

    expect(controller.getSnapshot().state).not.toBe("clean"); // 在途响应被丢弃
    expect(timers.pendingCount()).toBe(0); // 退避/防抖 timer 已清理
    await expect(p).rejects.toBeInstanceOf(SaveDisposedError);

    // dispose 后再 setText 不更新（且不再发请求）
    controller.setText("y");
    expect(controller.getSnapshot().text).toBe("x");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("dispose 后 flush 直接 reject；isDisposed 前 false 后 true（宿主可逆清理依据）", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const controller = setupController(save, timers);
    expect(controller.isDisposed()).toBe(false);
    controller.dispose();
    expect(controller.isDisposed()).toBe(true);
    await expect(controller.flush()).rejects.toBeInstanceOf(SaveDisposedError);
  });
});

describe("W12 修复 · 恢复确认只绑定已发送序号（新输入不被误确认）", () => {
  it("第四次丢响应、恢复确认旧正文期间输入新正文：继续补发最新输入，flush 不得以旧正文提前返回", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const load = vi.fn<LoadFn>();
    const defers: Deferred<WritingSaveControllerSaveResult>[] = [];
    let calls = 0;
    save.mockImplementation(() => {
      calls += 1;
      if (calls <= 3) return Promise.reject(new Error("network")); // 前三次网络失败
      const d = defer<WritingSaveControllerSaveResult>();
      defers.push(d);
      return d.promise; // 第 4 次：在途（稍后丢响应）；第 5 次：恢复后的新正文
    });
    load.mockResolvedValue({ text: "A", version: 2 }); // 第 4 次实际已落库（响应丢失）

    const controller = setupController(save, timers, { version: 1, text: "", load });

    controller.setText("A"); // seq1
    const first = controller.flush();
    await flushMicrotasks();
    await exhaustRetries(timers); // 3 次退避 → 第 4 次进入在途

    expect(save).toHaveBeenCalledTimes(4);
    expect(save.mock.calls[3]![0]).toEqual({ text: "A", expectedVersion: 1 });
    expect(defers).toHaveLength(1);

    controller.setText("B"); // 第 4 次在途期间的新输入（seq2）
    const second = controller.flush();

    defers[0]!.reject(new Error("response lost")); // 丢响应：自动重试耗尽 → load 恢复
    await flushMicrotasks(8);

    // 恢复只确认 sentSeq(A)：必须继续把 B 发出去（旧实现误把 B 记为已确认、不再发送）
    expect(save).toHaveBeenCalledTimes(5);
    expect(save.mock.calls[4]![0]).toEqual({ text: "B", expectedVersion: 2 });

    // B 确认前：两个 flush 都不得以 A 提前结算（不得返回与已确认正文不匹配的回执）
    let settled = 0;
    const bump = (): void => { settled += 1; };
    void first.then(bump, bump);
    void second.then(bump, bump);
    await flushMicrotasks();
    expect(settled).toBe(0);

    defers[1]!.resolve({ draftVersion: 3, textSha256: "h" });
    await flushMicrotasks(8);

    await expect(second).resolves.toEqual({ text: "B", version: 3 });
    await expect(first).resolves.toEqual({ text: "B", version: 3 });
    expect(controller.getSnapshot()).toMatchObject({ text: "B", version: 3, state: "clean" });
  });

  it("恢复读取在途期间输入新正文：load 返回确认后仍按最新输入补发（不丢稿、不误确认）", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const load = vi.fn<LoadFn>();
    const defers: Deferred<WritingSaveControllerSaveResult>[] = [];
    let calls = 0;
    save.mockImplementation(() => {
      calls += 1;
      if (calls <= 3) return Promise.reject(new Error("network"));
      const d = defer<WritingSaveControllerSaveResult>();
      defers.push(d);
      return d.promise;
    });
    const loadDeferred = defer<WritingSaveControllerLoadResult>();
    load.mockReturnValue(loadDeferred.promise);

    const controller = setupController(save, timers, { version: 1, text: "", load });

    controller.setText("A");
    const first = controller.flush();
    await flushMicrotasks();
    await exhaustRetries(timers);
    defers[0]!.reject(new Error("response lost"));
    await flushMicrotasks(8);
    expect(load).toHaveBeenCalledTimes(1); // 恢复读取在途

    controller.setText("B"); // 读取期间的新输入
    controller.flush();

    loadDeferred.resolve({ text: "A", version: 2 });
    await flushMicrotasks(8);

    expect(save).toHaveBeenCalledTimes(5);
    expect(save.mock.calls[4]![0]).toEqual({ text: "B", expectedVersion: 2 });

    defers[1]!.resolve({ draftVersion: 3, textSha256: "h" });
    await flushMicrotasks(8);

    await expect(first).resolves.toEqual({ text: "B", version: 3 });
    expect(controller.getSnapshot()).toMatchObject({ text: "B", version: 3, state: "clean" });
  });

  it("恢复确认后无新输入：不追加发送，flush 回执=恢复确认的正文与版本", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const load = vi.fn<LoadFn>();
    const defers: Deferred<WritingSaveControllerSaveResult>[] = [];
    let calls = 0;
    save.mockImplementation(() => {
      calls += 1;
      if (calls <= 3) return Promise.reject(new Error("network"));
      const d = defer<WritingSaveControllerSaveResult>();
      defers.push(d);
      return d.promise;
    });
    load.mockResolvedValue({ text: "A", version: 2 });

    const controller = setupController(save, timers, { version: 1, text: "", load });

    controller.setText("A");
    const p = controller.flush();
    await flushMicrotasks();
    await exhaustRetries(timers);
    defers[0]!.reject(new Error("response lost"));
    await flushMicrotasks(8);

    await expect(p).resolves.toEqual({ text: "A", version: 2 });
    expect(save).toHaveBeenCalledTimes(4); // 无新输入：不追加发送
    expect(controller.getSnapshot()).toMatchObject({ text: "A", version: 2, state: "clean" });
  });

  it("409 冲突保留本地内容：不自动重发、不盲采服务端（手动 retry 仍可用）", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    save.mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 }));
    const controller = setupController(save, timers, { text: "", version: 0 });

    controller.setText("本地稿");
    const p = controller.flush();
    await expect(p).rejects.toBeInstanceOf(SaveConflictError);

    expect(save).toHaveBeenCalledTimes(1); // 不自动重试
    expect(controller.getSnapshot()).toMatchObject({ text: "本地稿", state: "conflict", version: 0 });
  });
});

describe("W13/S 订阅合同 · 终态快照、重入与 dispose（先红后绿）", () => {
  type Snap = { text: string; version: number; state: string; inFlight: boolean };

  it("成功：订阅者最后收到的快照与 getSnapshot 一致（clean + inFlight=false）", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>().mockResolvedValue({ draftVersion: 1, textSha256: "h" });
    const controller = setupController(save, timers);
    const seen: Snap[] = [];
    controller.subscribe(() => { seen.push({ ...controller.getSnapshot() }); });

    controller.setText("甲");
    await controller.flush(); // flush 直接发（不等防抖）；pipeline 落地后断言订阅证据

    expect(seen.at(-1)).toEqual(controller.getSnapshot());
    expect(seen.at(-1)).toMatchObject({ state: "clean", inFlight: false });
  });

  it("失败（500×4）：最后快照 error + inFlight=false，不把终态显示成保存中", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>().mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    const controller = setupController(save, timers);
    const seen: Snap[] = [];
    controller.subscribe(() => { seen.push({ ...controller.getSnapshot() }); });

    controller.setText("甲");
    const p = controller.flush();
    await flushMicrotasks();
    await exhaustRetries(timers);
    await expect(p).rejects.toThrow();

    expect(seen.at(-1)).toEqual(controller.getSnapshot());
    expect(seen.at(-1)).toMatchObject({ state: "error", inFlight: false });
  });

  it("409：最后快照 conflict + inFlight=false（订阅者不被在途帧掩蔽）", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>().mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 }));
    const controller = setupController(save, timers);
    const seen: Snap[] = [];
    controller.subscribe(() => { seen.push({ ...controller.getSnapshot() }); });

    controller.setText("甲");
    const p = controller.flush();
    await expect(p).rejects.toBeInstanceOf(SaveConflictError);

    expect(seen.at(-1)).toEqual(controller.getSnapshot());
    expect(seen.at(-1)).toMatchObject({ state: "conflict", inFlight: false });
  });

  it("Task A 恢复续写：补发 B 确认后，订阅最后快照 = clean + inFlight=false", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const load = vi.fn<LoadFn>();
    const defers: Deferred<WritingSaveControllerSaveResult>[] = [];
    let calls = 0;
    save.mockImplementation(() => {
      calls += 1;
      if (calls <= 3) return Promise.reject(new Error("network"));
      const d = defer<WritingSaveControllerSaveResult>();
      defers.push(d);
      return d.promise;
    });
    load.mockResolvedValue({ text: "A", version: 2 });

    const controller = setupController(save, timers, { version: 1, text: "", load });
    const seen: Snap[] = [];
    controller.subscribe(() => { seen.push({ ...controller.getSnapshot() }); });

    controller.setText("A");
    const first = controller.flush();
    await flushMicrotasks();
    await exhaustRetries(timers);
    controller.setText("B"); // 在途新输入
    const second = controller.flush();
    defers[0]!.reject(new Error("response lost")); // 恢复确认 A（sentSeq）
    await flushMicrotasks(8);
    defers[1]!.resolve({ draftVersion: 3, textSha256: "h" }); // 补发 B
    await flushMicrotasks(8);

    await expect(second).resolves.toEqual({ text: "B", version: 3 });
    await first;
    expect(seen.at(-1)).toEqual(controller.getSnapshot());
    expect(seen.at(-1)).toMatchObject({ state: "clean", inFlight: false });
  });

  it("重入：clean 通知里立刻 setText+flush，等待者由释放 inFlight 后的排出推进（不依赖防抖）", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>().mockResolvedValue({ draftVersion: 1, textSha256: "h" });
    const controller = setupController(save, timers);
    const reentrantFlushes: Array<Promise<unknown>> = [];
    let armed = false;
    controller.subscribe(() => {
      const snap = controller.getSnapshot();
      if (!armed && snap.state === "clean" && snap.text === "甲") {
        armed = true;
        controller.setText("乙");
        reentrantFlushes.push(controller.flush());
      }
    });

    controller.setText("甲");
    await controller.flush(); // 甲确认后触发重入
    expect(reentrantFlushes).toHaveLength(1);

    const outcome = await Promise.race([
      reentrantFlushes[0]!.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
    expect(outcome).toBe("done");
    expect(controller.getSnapshot()).toMatchObject({ text: "乙", state: "clean" });
  });

  it("dispose 后管道落地不再发通知（订阅者不再收到帧）", async () => {
    const timers = makeFakeTimers();
    const save = vi.fn<SaveFn>();
    const defers: Deferred<WritingSaveControllerSaveResult>[] = [];
    save.mockImplementation(() => {
      const d = defer<WritingSaveControllerSaveResult>();
      defers.push(d);
      return d.promise;
    });
    const controller = setupController(save, timers);
    let calls = 0;
    controller.subscribe(() => { calls += 1; });

    controller.setText("甲");
    const p = controller.flush();
    await flushMicrotasks();
    const before = calls;
    controller.dispose();
    defers[0]!.resolve({ draftVersion: 1, textSha256: "h" });
    await flushMicrotasks(8);

    expect(calls).toBe(before);
    await expect(p).rejects.toBeInstanceOf(SaveDisposedError);
  });
});
