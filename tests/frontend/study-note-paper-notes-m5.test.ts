/**
 * Task 09B 补批 · M5：题纸与笔记**同时** dirty 时切题（先红后绿）。
 *
 * 任务书 M5：「题纸有未保存作答 + 笔记有未保存正文，切题 → 先笔记 flush，再题纸 flush；
 * 两者均确认后才导航；任一失败留页并提示」。
 *
 * 本文件用**真实 deferred** 控制两个保存请求的结算顺序（不用固定 sleep 证明时序）：
 *  - 笔记保存挂起时，题纸保存**不得**开始、导航**不得**执行；
 *  - 笔记确认后题纸才 flush；题纸仍挂起时导航**仍不得**执行；
 *  - 两者都确认后才执行真实导航，且**只执行一次**；
 *  - 任一失败（笔记拒绝 / 题纸拒绝）→ 留页，且不执行导航；
 *  - 等待期间的新输入必须被**明确纳入**下一次确认或同步拒绝，不得静默丢弃。
 */
import { describe, expect, it, vi } from "vitest";
import { composeSheetLeaveBarrier, type NoteLeaveBarrier } from "@/frontend/state/sheetLeaveBarrier";

/**
 * 排空微任务队列（**不**用 sleep）：让组合器内部若干 await 链推进到下一个真实挂起点。
 * 固定次数的 `await Promise.resolve()` 不足以跨过组合器的多层 await。
 */
async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** 手控结算的 deferred（真实请求挂起的等价物；无 sleep）。 */
function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("M5 · 题纸与笔记同时 dirty 的切题时序", () => {
  it("笔记保存挂起时：题纸 flush 不得开始，导航不得执行", async () => {
    const noteSave = defer<void>();
    const order: string[] = [];
    const navigate = vi.fn();

    const noteBarrier: NoteLeaveBarrier = async (action) => {
      order.push("note:start");
      await noteSave.promise; // 真实挂起
      order.push("note:settled");
      await action();
      return { ok: true };
    };
    const sheetBarrier = vi.fn(async () => {
      order.push("sheet");
      return true;
    });

    const barrier = composeSheetLeaveBarrier({ sheetBarrier, noteBarrier });
    const pending = barrier(navigate);

    // 笔记挂起期间：题纸未开始、导航未执行
    await flushMicrotasks();
    expect(sheetBarrier).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    noteSave.resolve();
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(order).toEqual(["note:start", "note:settled", "sheet"]);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("笔记已确认但题纸仍挂起：导航不得执行；题纸确认后才导航且只一次", async () => {
    const sheetSave = defer<void>();
    const order: string[] = [];
    const navigate = vi.fn();

    const noteBarrier: NoteLeaveBarrier = async (action) => {
      order.push("note");
      await action();
      return { ok: true };
    };
    const sheetBarrier = async (): Promise<boolean> => {
      order.push("sheet:start");
      await sheetSave.promise;
      order.push("sheet:settled");
      return true;
    };

    const barrier = composeSheetLeaveBarrier({ sheetBarrier, noteBarrier });
    const pending = barrier(navigate);

    // 题纸挂起期间：笔记已确认，但导航绝不能被提前放行
    await flushMicrotasks();
    expect(order).toContain("note");
    expect(order).toContain("sheet:start");
    expect(navigate).not.toHaveBeenCalled();

    sheetSave.resolve();
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(order).toEqual(["note", "sheet:start", "sheet:settled"]);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("笔记确认后题纸拒绝：留页且不导航（不回滚已确认的笔记）", async () => {
    const navigate = vi.fn();
    const sheetBarrier = vi.fn(async () => false); // 题纸拒答（真实 jumpBarrier 语义）
    const noteBarrier: NoteLeaveBarrier = async (action) => {
      await action();
      return { ok: true };
    };

    const result = await composeSheetLeaveBarrier({ sheetBarrier, noteBarrier })(navigate);

    expect(result.ok).toBe(false);
    expect(result.failedBy).toBe("sheet");
    expect(navigate).not.toHaveBeenCalled();
    expect(sheetBarrier).toHaveBeenCalledTimes(1);
  });

  it("笔记拒绝：题纸 flush 不得开始（不做无谓写），导航不执行", async () => {
    const navigate = vi.fn();
    const sheetBarrier = vi.fn(async () => true);
    const noteBarrier: NoteLeaveBarrier = async () => ({ ok: false, reason: "存在未处理的保存冲突" });

    const result = await composeSheetLeaveBarrier({ sheetBarrier, noteBarrier })(navigate);

    expect(result.ok).toBe(false);
    expect(result.failedBy).toBe("note");
    expect(sheetBarrier).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("等待期间的新输入：把「再次确认」纳入同一次离开，且导航仍只执行一次", async () => {
    // 模拟真实 flush 语义：每轮**先取当时快照序号作为等待目标**再挂起；
    // 挂起期间的新输入会抬高 editSeq，使本轮确认不足以覆盖 → 必须再确认一轮。
    const rounds: Array<ReturnType<typeof defer<void>>> = [defer<void>(), defer<void>()];
    const navigate = vi.fn();
    const state = { editSeq: 1, savedSeq: 0 };

    const noteBarrier: NoteLeaveBarrier = async (action) => {
      for (let guard = 0; guard < 5; guard += 1) {
        const target = state.editSeq; // 等待目标 = 取快照时刻的序号
        if (state.savedSeq >= target) break;
        const gate = rounds[guard] ?? defer<void>();
        await gate.promise;
        state.savedSeq = target; // 只确认到「等待目标」，不吞掉期间的新输入
      }
      await action();
      return { ok: true };
    };

    const barrier = composeSheetLeaveBarrier({ sheetBarrier: async () => true, noteBarrier });
    const pending = barrier(navigate);

    await flushMicrotasks();
    expect(navigate).not.toHaveBeenCalled(); // 第一轮挂起中

    // 等待期间的新输入：序号前进，必须被纳入确认（不能被静默丢弃）
    state.editSeq = 2;
    rounds[0]!.resolve();
    await flushMicrotasks();
    expect(navigate).not.toHaveBeenCalled(); // 第二轮（覆盖新输入）仍挂起

    rounds[1]!.resolve();
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(state.savedSeq).toBe(2); // 新输入确已被确认
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("并发重入：一次离开动作只导航一次（双击不重复离开）", async () => {
    const gate = defer<void>();
    const navigate = vi.fn();
    const barrier = composeSheetLeaveBarrier({
      sheetBarrier: async () => {
        await gate.promise;
        return true;
      },
      noteBarrier: null,
    });

    const first = barrier(navigate);
    const second = barrier(navigate);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.failedBy).toBe("busy");
  });
});
