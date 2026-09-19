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
    const controller = createExamSheetSaveController({ sheetId: "s1", save, setTimer, clearTimer });

    controller.setAnswer(Q1, answer("A"));
    controller.setAnswer(Q2, answer("B"));
    expect(save).not.toHaveBeenCalled(); // 防抖窗口内不发送
    advance();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ answers: { [Q1]: answer("A"), [Q2]: answer("B") } });
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
    const controller = createExamSheetSaveController({ sheetId: "s1", save, setTimer, clearTimer });

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
    expect(save).toHaveBeenLastCalledWith({ answers: { [Q1]: answer("B") } }); // 第二次发 B
    saves[1]!.resolve({ draftVersion: 2 });

    const receipt = await controller.flush();
    expect(receipt.draftVersion).toBe(2);
    expect(controller.getSnapshot().state).toBe("clean");
  });

  it("延迟的旧响应不得覆盖后续输入：串行确认后状态干净，本地真理不被回写", async () => {
    // 用真实定时器：A 在途 → 本地改 B → A 确认 → 自动发 B → B 确认。
    const saves: Array<(r: { draftVersion: number }) => void> = [];
    const save = vi.fn(() => new Promise<{ draftVersion: number }>((resolve) => saves.push(resolve)));
    const controller = createExamSheetSaveController({ sheetId: "s1", save });

    controller.setAnswer(Q1, answer("A")); // seq 1
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1)); // 防抖后发 A
    controller.setAnswer(Q1, answer("B")); // seq 2（在途 A 期间）
    saves[0]!({ draftVersion: 1 }); // A 确认（仅确认 seq 1）
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2)); // 自动发 B
    expect(save).toHaveBeenLastCalledWith({ answers: { [Q1]: answer("B") } }); // 第二次发最新值 B
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
    const controller = createExamSheetSaveController({ sheetId: "s1", save, setTimer, clearTimer });

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
    const controller = createExamSheetSaveController({ sheetId: "s1", save, setTimer, clearTimer });

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
    const controller = createExamSheetSaveController({ sheetId: "s1", save, setTimer, clearTimer });
    controller.setAnswer(Q1, answer("A"));
    advance();
    await Promise.resolve();
    await expect(controller.flush()).rejects.toBeInstanceOf(ExamSheetSaveConflictError);
    expect(save).toHaveBeenCalledTimes(1); // 409 不自动重试
    expect(controller.getSnapshot().state).toBe("conflict");
  });

  it("PATCH reject（网络 500）自动重试 3 次后退化为 error；flush reject 但本地答案保留", async () => {
    const save = vi.fn(async () => { throw Object.assign(new Error("boom"), { status: 500 }); });
    const controller = createExamSheetSaveController({ sheetId: "s1", save });
    controller.setAnswer(Q1, answer("A"));
    await expect(controller.flush()).rejects.toThrow();
    expect(save).toHaveBeenCalledTimes(4); // 1 初发 + 3 自动重试
    expect(controller.getSnapshot().state).toBe("error");
  }, 20000);

  it("题纸 freeze 后不再触发任何 PATCH（只读期）", async () => {
    const { setTimer, clearTimer, advance } = manualTimers();
    const save = vi.fn(async () => ({ draftVersion: 1 }));
    const controller = createExamSheetSaveController({ sheetId: "s1", save, setTimer, clearTimer });
    controller.freeze();
    controller.setAnswer(Q1, answer("A"));
    advance();
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
  });

  it("dispose 后 flush reject（不挂起调用方）", async () => {
    const { setTimer, clearTimer } = manualTimers();
    const save = vi.fn(async () => ({ draftVersion: 1 }));
    const controller = createExamSheetSaveController({ sheetId: "s1", save, setTimer, clearTimer });
    controller.dispose();
    await expect(controller.flush()).rejects.toBeInstanceOf(ExamSheetSaveDisposedError);
  });
});

describe("S 订阅合同 · 终态快照、重入与 dispose（先红后绿）", () => {
  type Snap = { state: string; inFlight: boolean; lastSavedAt: string | null };

  it("成功：订阅者最后收到的快照与 getSnapshot 一致（clean + inFlight=false）", async () => {
    const { setTimer, clearTimer } = manualTimers();
    const save = vi.fn(async () => ({ draftVersion: 1 }));
    const controller = createExamSheetSaveController({ sheetId: "s1", save, setTimer, clearTimer });
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
    const controller = createExamSheetSaveController({ sheetId: "s1", save, setTimer, clearTimer });
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
    const controller = createExamSheetSaveController({ sheetId: "s1", save, setTimer, clearTimer });
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
    const controller = createExamSheetSaveController({ sheetId: "s1", save, setTimer, clearTimer });
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
    const controller = createExamSheetSaveController({ sheetId: "s1", save, setTimer, clearTimer });
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
