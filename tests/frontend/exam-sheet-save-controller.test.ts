/// <reference lib="dom" />
import { describe, expect, it, vi } from "vitest";
import {
  createExamSheetSaveController,
  ExamSheetSaveConflictError,
  ExamSheetSaveDisposedError,
} from "@/frontend/state/examSheetSaveController";
import type { SheetAnswer } from "@/domain/l3-sheets";

/** 受控 timer：手动推进，便于断言防抖与退避。 */
function manualTimers() {
  let seq = 0;
  const map = new Map<number, () => void>();
  const setTimer = (fn: () => void, _delay: number): unknown => {
    const id = seq++;
    map.set(id, fn);
    return id;
  };
  const clearTimer = (handle: unknown): void => {
    map.delete(handle as number);
  };
  const advance = (): void => {
    for (const fn of [...map.values()]) fn();
    map.clear();
  };
  return { setTimer, clearTimer, advance };
}

const Q1 = "00000000-0000-4000-8000-000000000101";
const Q2 = "00000000-0000-4000-8000-000000000102";

function answer(choice: string): SheetAnswer {
  return { choice };
}

describe("ExamSheetSaveController 单在途 + 序号纪律", () => {
  it("防抖 800ms 后发送脏键；连续两次改动合并进同一次 PATCH", async () => {
    const { setTimer, clearTimer, advance } = manualTimers();
    const save = vi.fn(async () => ({ draftVersion: 1 }));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });

    controller.setAnswer(Q1, answer("A"));
    controller.setAnswer(Q2, answer("B"));
    expect(save).not.toHaveBeenCalled(); // 防抖窗口内不发送
    advance();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ answers: { [Q1]: answer("A"), [Q2]: answer("B") }, expectedVersion: 0 });
    await controller.flush();
    expect(controller.getSnapshot().lastSavedAt).not.toBeNull();
  });

  it("旧响应只确认其发送序号，不覆盖之后输入的本地答案（fast A→B）", async () => {
    const { setTimer, clearTimer, advance } = manualTimers();
    // save 永远「延迟」——我们用一个受控 deferred 来模拟 A 的响应在 B 之后才回。
    let resolveSave: (r: { draftVersion: number }) => void = () => {};
    const saves: Array<{ call: number; resolve: (r: { draftVersion: number }) => void }> = [];
    const save = vi.fn(() => new Promise<{ draftVersion: number }>((resolve) => {
      saves.push({ call: saves.length, resolve });
    }));
    void resolveSave;
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });

    controller.setAnswer(Q1, answer("A")); // inputSeq=1
    advance();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1); // 在途：A

    // 在途期间本地改为 B（inputSeq=2）。
    controller.setAnswer(Q1, answer("B"));
    // B 应进入下一次发送（当前在途不抢发）。
    expect(save).toHaveBeenCalledTimes(1);

    // 旧响应 A 先回（携带 version=1）：只确认 seq=1，不得把本地覆盖回 A。
    saves[0]!.resolve({ draftVersion: 1 });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith({ answers: { [Q1]: answer("B") }, expectedVersion: 1 }); // 第二次发 B
    saves[1]!.resolve({ draftVersion: 2 });

    const receipt = await controller.flush();
    expect(receipt.draftVersion).toBe(2);
    expect(controller.getSnapshot().state).toBe("clean");
  });

  it("延迟的旧响应不得覆盖后续输入：串行确认后状态干净，本地真理不被回写", async () => {
    // 用真实定时器：A 在途 → 本地改 B → A 确认 → 自动发 B → B 确认。
    const saves: Array<(r: { draftVersion: number }) => void> = [];
    const save = vi.fn(() => new Promise<{ draftVersion: number }>((resolve) => saves.push(resolve)));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save });

    controller.setAnswer(Q1, answer("A")); // seq 1
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1)); // 防抖后发 A
    controller.setAnswer(Q1, answer("B")); // seq 2（在途 A 期间）
    saves[0]!({ draftVersion: 1 }); // A 确认（仅确认 seq 1）
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2)); // 自动发 B
    expect(save).toHaveBeenLastCalledWith({ answers: { [Q1]: answer("B") }, expectedVersion: 1 }); // 第二次发最新值 B
    saves[1]!({ draftVersion: 2 });
    const receipt = await controller.flush();
    expect(receipt.draftVersion).toBe(2);
    expect(controller.getSnapshot().state).toBe("clean");
    expect(controller.getSnapshot().lastSavedAt).not.toBeNull();
  });

  it("已有 PATCH 在途时第二次 flush 不会提前 resolve（等待在途 + 输入）", async () => {
    const { setTimer, clearTimer, advance } = manualTimers();
    const saves: Array<(r: { draftVersion: number }) => void> = [];
    const save = vi.fn(() => new Promise<{ draftVersion: number }>((resolve) => saves.push(resolve)));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });

    controller.setAnswer(Q1, answer("A"));
    advance();
    await Promise.resolve(); // 在途
    const f1 = controller.flush();
    const f2 = controller.flush();
    expect(save).toHaveBeenCalledTimes(1); // 仍仅一次在途
    let f1Done = false;
    let f2Done = false;
    void f1.then(() => { f1Done = true; });
    void f2.then(() => { f2Done = true; });
    await Promise.resolve();
    expect(f1Done).toBe(false);
    expect(f2Done).toBe(false); // 在途未完成前二次 flush 不 resolve
    saves[0]!( { draftVersion: 1 });
    const [r1, r2] = await Promise.all([f1, f2]);
    expect(r1.draftVersion).toBe(1);
    expect(r2.draftVersion).toBe(1);
    expect(f1Done).toBe(true);
    expect(f2Done).toBe(true);
  });

  it("flush 前若已有脏输入未发，会等待其确认后才 resolve", async () => {
    const { setTimer, clearTimer, advance } = manualTimers();
    const saves: Array<(r: { draftVersion: number }) => void> = [];
    const save = vi.fn(() => new Promise<{ draftVersion: number }>((resolve) => saves.push(resolve)));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });

    controller.setAnswer(Q1, answer("A")); // 尚未推进防抖
    const flushPromise = controller.flush(); // 应在发送并确认后才 resolve
    advance(); // 触发发送
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    saves[0]!( { draftVersion: 1 });
    const receipt = await flushPromise;
    expect(receipt.draftVersion).toBe(1);
  });

  it("PATCH reject（409）进入 conflict，flush reject，且不再自动重发", async () => {
    const { setTimer, clearTimer, advance } = manualTimers();
    const save = vi.fn(async () => { throw Object.assign(new Error("conflict"), { status: 409 }); });
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });
    controller.setAnswer(Q1, answer("A"));
    advance();
    await Promise.resolve();
    await expect(controller.flush()).rejects.toBeInstanceOf(ExamSheetSaveConflictError);
    expect(save).toHaveBeenCalledTimes(1); // 409 不自动重试
    expect(controller.getSnapshot().state).toBe("conflict");
  });

  it("PATCH reject（网络 500）自动重试 3 次后退化为 error；flush reject 但本地答案保留", async () => {
    const save = vi.fn(async () => { throw Object.assign(new Error("boom"), { status: 500 }); });
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save });
    controller.setAnswer(Q1, answer("A"));
    await expect(controller.flush()).rejects.toThrow();
    expect(save).toHaveBeenCalledTimes(4); // 1 初发 + 3 自动重试
    expect(controller.getSnapshot().state).toBe("error");
  }, 20000);

  it("题纸 freeze 后不再触发任何 PATCH（只读期）", async () => {
    const { setTimer, clearTimer, advance } = manualTimers();
    const save = vi.fn(async () => ({ draftVersion: 1 }));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });
    controller.freeze();
    controller.setAnswer(Q1, answer("A"));
    advance();
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
  });

  it("dispose 后 flush reject（不挂起调用方）", async () => {
    const { setTimer, clearTimer } = manualTimers();
    const save = vi.fn(async () => ({ draftVersion: 1 }));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });
    controller.dispose();
    await expect(controller.flush()).rejects.toBeInstanceOf(ExamSheetSaveDisposedError);
  });
});

describe("S 订阅合同 · 终态快照、重入与 dispose（先红后绿）", () => {
  type Snap = { state: string; inFlight: boolean; lastSavedAt: string | null };

  it("成功：订阅者最后收到的快照与 getSnapshot 一致（clean + inFlight=false）", async () => {
    const { setTimer, clearTimer } = manualTimers();
    const save = vi.fn(async () => ({ draftVersion: 1 }));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });
    const seen: Snap[] = [];
    controller.subscribe(() => { seen.push({ ...controller.getSnapshot() }); });

    controller.setAnswer(Q1, answer("A"));
    await controller.flush();

    expect(seen.at(-1)).toEqual(controller.getSnapshot());
    expect(seen.at(-1)).toMatchObject({ state: "clean", inFlight: false });
  });

  it("失败（500×4）：最后快照 error + inFlight=false", async () => {
    const { setTimer, clearTimer, advance } = manualTimers();
    const save = vi.fn(async () => { throw Object.assign(new Error("boom"), { status: 500 }); });
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });
    const seen: Snap[] = [];
    controller.subscribe(() => { seen.push({ ...controller.getSnapshot() }); });

    controller.setAnswer(Q1, answer("A"));
    const p = controller.flush();
    await Promise.resolve();
    for (let i = 0; i < 3; i += 1) {
      advance();
      await Promise.resolve();
      await Promise.resolve();
    }
    await expect(p).rejects.toThrow();

    expect(seen.at(-1)).toEqual(controller.getSnapshot());
    expect(seen.at(-1)).toMatchObject({ state: "error", inFlight: false });
  });

  it("409：最后快照 conflict + inFlight=false", async () => {
    const { setTimer, clearTimer } = manualTimers();
    const save = vi.fn(async () => { throw Object.assign(new Error("conflict"), { status: 409 }); });
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });
    const seen: Snap[] = [];
    controller.subscribe(() => { seen.push({ ...controller.getSnapshot() }); });

    controller.setAnswer(Q1, answer("A"));
    const p = controller.flush();
    await expect(p).rejects.toBeInstanceOf(ExamSheetSaveConflictError);

    expect(seen.at(-1)).toEqual(controller.getSnapshot());
    expect(seen.at(-1)).toMatchObject({ state: "conflict", inFlight: false });
  });

  it("重入：clean 通知里再次 setAnswer+flush，等待者由释放 inFlight 后的排出完成（不依赖防抖）", async () => {
    const { setTimer, clearTimer } = manualTimers();
    const save = vi.fn(async () => ({ draftVersion: 1 }));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });
    const reentrantFlushes: Array<Promise<unknown>> = [];
    let armed = false;
    controller.subscribe(() => {
      const snap = controller.getSnapshot();
      if (!armed && snap.state === "clean") {
        armed = true;
        controller.setAnswer(Q2, answer("B"));
        reentrantFlushes.push(controller.flush());
      }
    });

    controller.setAnswer(Q1, answer("A"));
    await controller.flush();
    expect(reentrantFlushes).toHaveLength(1);

    const outcome = await Promise.race([
      reentrantFlushes[0]!.then(() => "done"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 200)),
    ]);
    expect(outcome).toBe("done");
    expect(controller.getSnapshot()).toMatchObject({ state: "clean" });
  });

  it("dispose 后管道落地不再发通知（订阅者不再收到帧）", async () => {
    const { setTimer, clearTimer } = manualTimers();
    const saves: Array<(r: { draftVersion: number }) => void> = [];
    const save = vi.fn(() => new Promise<{ draftVersion: number }>((resolve) => saves.push(resolve)));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });
    let calls = 0;
    controller.subscribe(() => { calls += 1; });

    controller.setAnswer(Q1, answer("A"));
    const p = controller.flush();
    await Promise.resolve();
    expect(saves).toHaveLength(1);
    const before = calls;
    controller.dispose();
    saves[0]!({ draftVersion: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBe(before);
    await expect(p).rejects.toBeInstanceOf(ExamSheetSaveDisposedError);
  });
});

describe("Q 逐题脏键与请求序号（先红后绿）", () => {
  it("Q1：Q1 保存成功后只改 Q2——第二次请求只含 Q2，不夹带旧 Q1", async () => {
    const { setTimer, clearTimer } = manualTimers();
    const save = vi.fn(async () => ({ draftVersion: 1 }));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });

    controller.setAnswer(Q1, answer("A"));
    await controller.flush();
    expect(save).toHaveBeenNthCalledWith(1, { answers: { [Q1]: answer("A") }, expectedVersion: 0 });

    controller.setAnswer(Q2, answer("B"));
    await controller.flush();
    expect(save).toHaveBeenNthCalledWith(2, { answers: { [Q2]: answer("B") }, expectedVersion: 1 });
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("Q2：Q1 在途时改为 B——A 的确认不清除 B，下一请求发 Q1=B", async () => {
    const { setTimer, clearTimer } = manualTimers();
    const saves: Array<(r: { draftVersion: number }) => void> = [];
    const save = vi.fn(() => new Promise<{ draftVersion: number }>((resolve) => saves.push(resolve)));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });

    controller.setAnswer(Q1, answer("A"));
    const f1 = controller.flush();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);

    controller.setAnswer(Q1, answer("B")); // 在途再编辑（新 seq）
    saves[0]!({ draftVersion: 1 }); // A 确认——只能清 A 的序号，B 必须留下
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenNthCalledWith(2, { answers: { [Q1]: answer("B") }, expectedVersion: 1 });
    saves[1]!({ draftVersion: 2 });
    await f1;
    expect(controller.getSnapshot().state).toBe("clean");
  });

  it("Q3：Q1 在途时改 Q2——响应后 Q2 补发，flush 不提前返回", async () => {
    const { setTimer, clearTimer } = manualTimers();
    const saves: Array<(r: { draftVersion: number }) => void> = [];
    const save = vi.fn(() => new Promise<{ draftVersion: number }>((resolve) => saves.push(resolve)));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });

    controller.setAnswer(Q1, answer("A"));
    const f1 = controller.flush();
    await Promise.resolve();
    controller.setAnswer(Q2, answer("B"));
    const f2 = controller.flush();

    let f1done = false;
    let f2done = false;
    void f1.then(() => { f1done = true; });
    void f2.then(() => { f2done = true; });
    saves[0]!({ draftVersion: 1 }); // Q1 确认
    await Promise.resolve();
    await Promise.resolve();
    expect(f1done).toBe(false); // f2 未确认前不提前结算
    expect(f2done).toBe(false);

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2)); // Q2 补发
    expect(save).toHaveBeenNthCalledWith(2, { answers: { [Q2]: answer("B") }, expectedVersion: 1 });
    saves[1]!({ draftVersion: 2 });
    await Promise.all([f1, f2]);
    expect(f1done).toBe(true);
    expect(f2done).toBe(true);
  });

  it("Q4：null 清除按序发送——清除请求只含被清除的键", async () => {
    const { setTimer, clearTimer } = manualTimers();
    const save = vi.fn(async () => ({ draftVersion: 1 }));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });

    controller.setAnswer(Q1, answer("A"));
    await controller.flush();
    controller.setAnswer(Q1, null); // 显式清除
    await controller.flush();
    expect(save).toHaveBeenNthCalledWith(2, { answers: { [Q1]: null }, expectedVersion: 1 });
  });

  it("Q5：429 重试冻结同一载荷与版本——最新编辑不混入重试，之后按序补发", async () => {
    let calls = 0;
    const save = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return { draftVersion: calls === 2 ? 1 : 2 };
    });
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save }); // 真实 timer（1s 退避）

    controller.setAnswer(Q1, answer("A"));
    const f = controller.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    controller.setAnswer(Q1, answer("B")); // 退避期间新编辑——不得混入重试

    await vi.waitFor(() => expect(save.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    expect(save).toHaveBeenNthCalledWith(2, { answers: { [Q1]: answer("A") }, expectedVersion: 0 }); // 同一载荷+版本
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(3), { timeout: 3000 });
    expect(save).toHaveBeenNthCalledWith(3, { answers: { [Q1]: answer("B") }, expectedVersion: 1 }); // 补发新值
    await f;
    expect(controller.getSnapshot().state).toBe("clean");
  }, 15000);

  it("Q5b：409 保留本地且停发——新编辑不清 conflict、不再自动发送", async () => {
    const { setTimer, clearTimer, advance } = manualTimers();
    const save = vi.fn(async () => { throw Object.assign(new Error("conflict"), { status: 409 }); });
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });

    controller.setAnswer(Q1, answer("A"));
    await expect(controller.flush()).rejects.toBeInstanceOf(ExamSheetSaveConflictError);
    expect(controller.getSnapshot().state).toBe("conflict");
    const calls = save.mock.calls.length;

    controller.setAnswer(Q2, answer("B")); // 新编辑：保留本地但不得恢复自动写
    advance();
    await Promise.resolve();
    expect(save.mock.calls.length).toBe(calls);
    expect(controller.getSnapshot().state).toBe("conflict");
  });

  it("Q6：两标签同题冲突——旧版本写入 409；请求不含他人已改的旧 Q1；载入新基线后显式编辑才成功", async () => {
    const { setTimer, clearTimer } = manualTimers();
    let serverVersion = 0; // 模拟服务器：版本严格 CAS
    const save = vi.fn(async (input: { answers: Record<string, unknown>; expectedVersion: number }) => {
      if (input.expectedVersion !== serverVersion) {
        throw Object.assign(new Error("conflict"), { status: 409 });
      }
      serverVersion += 1;
      return { draftVersion: serverVersion };
    });
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });

    controller.setAnswer(Q1, answer("A"));
    await controller.flush(); // 本端 v0→v1
    expect(serverVersion).toBe(1);
    serverVersion = 2; // 另端改 Q1 成功 → 服务器 v2

    controller.setAnswer(Q2, answer("B")); // 本端只改 Q2
    await expect(controller.flush()).rejects.toBeInstanceOf(ExamSheetSaveConflictError);
    expect(save).toHaveBeenLastCalledWith({ answers: { [Q2]: answer("B") }, expectedVersion: 1 }); // 不含旧 Q1

    controller.adoptServerBaseline(2); // 明确载入服务器版本
    expect(controller.getSnapshot().state).toBe("clean");
    controller.setAnswer(Q2, answer("C")); // 重新显式编辑才允许成功
    const receipt = await controller.flush();
    expect(receipt.draftVersion).toBe(3);
  });

  it("Q7：201 个脏键分批——每批 <=200、按序、无并发在途、无丢题（flush 等全部确认）", async () => {
    const { setTimer, clearTimer } = manualTimers();
    const pending: Array<{ input: { answers: Record<string, unknown>; expectedVersion: number }; resolve: (r: { draftVersion: number }) => void }> = [];
    let inflight = 0;
    const save = vi.fn((input: { answers: Record<string, unknown>; expectedVersion: number }) =>
      new Promise<{ draftVersion: number }>((resolve) => {
        inflight += 1;
        pending.push({ input, resolve: (r) => { inflight -= 1; resolve(r); } });
      }));
    const controller = createExamSheetSaveController({ sheetId: "s1", draftVersion: 0, save, setTimer, clearTimer });

    const ids = Array.from({ length: 201 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`);
    for (const id of ids) controller.setAnswer(id, answer("A"));

    const f = controller.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1); // 批1：先发 200 键
    expect(Object.keys(save.mock.calls[0]![0].answers)).toHaveLength(200);
    expect(inflight).toBe(1);

    pending[0]!.resolve({ draftVersion: 1 });
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(Object.keys(save.mock.calls[1]![0].answers)).toHaveLength(1); // 批2：余下 1 键
    expect(inflight).toBe(1); // 无并发在途

    pending[1]!.resolve({ draftVersion: 2 });
    await f; // 201 键全部确认
    expect(controller.getSnapshot().state).toBe("clean");
  });
});
