/**
 * Task 09B · 卷面双保存屏障合成测试（先红后绿）。
 *
 * 语义（任务书 §4.5 + §3 不变量 3/6）：
 *  - 离开卷面必须**两个**屏障都落定：题纸作答未确认 + 侧栏笔记未确认；
 *  - **顺序**：先笔记 flush（侧栏是附带面），再题纸 flush（主面）——任一步失败即拒答，
 *    且**不得**执行真实导航；
 *  - 任一步失败都必须**留页**（action 不执行），并回报**可归因**的失败来源（note/sheet），
 *    供 UI 给出正确指引（笔记冲突 vs 题纸未保存是不同恢复路径）；
 *  - 无侧栏/无笔记（barrier 为 null）时退化为**纯题纸**语义，与既有 jumpBarrier 等价；
 *  - 笔记屏障失败时**不得**再触发题纸 flush（不做无谓写、不掩盖首个失败原因）；
 *  - IME 组合中、冲突态、未确认态均由**各自屏障**拒绝（本模块不重实现判定）。
 *
 * 关键实测约束：`useStudyNoteEditor.requestNavigation` 把失败**吞进** `navigationError`
 * （不 reject、不返回布尔）——因此笔记屏障的成败**不能**靠 try/catch 判定，必须由适配层
 * 以显式结果回报（见 `NoteBarrierOutcome`）。
 */
import { describe, expect, it, vi } from "vitest";
import { composeSheetLeaveBarrier } from "@/frontend/state/sheetLeaveBarrier";

/** 便捷：构造一个「成功即执行 action 并回报 ok」的笔记屏障适配器。 */
function noteBarrierOk(action: () => void | Promise<void>) {
  return async (): Promise<{ ok: true }> => {
    await action();
    return { ok: true };
  };
}

function noteBarrierFail(reason: string) {
  return async (): Promise<{ ok: false; reason: string }> => ({ ok: false, reason });
}

describe("composeSheetLeaveBarrier · 双屏障合成", () => {
  it("两者均确认：先笔记后题纸，最后执行真实导航", async () => {
    const order: string[] = [];
    const navigate = vi.fn(async () => {
      order.push("navigate");
    });
    const barrier = composeSheetLeaveBarrier({
      sheetBarrier: async () => {
        order.push("sheet");
        return true;
      },
      noteBarrier: async () => {
        order.push("note");
        return { ok: true };
      },
    });

    const result = await barrier(navigate);

    expect(result.ok).toBe(true);
    expect(order).toEqual(["note", "sheet", "navigate"]);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("笔记失败：拒答、不执行导航，且不再触发题纸 flush", async () => {
    const navigate = vi.fn();
    const sheetBarrier = vi.fn(async () => true);
    const barrier = composeSheetLeaveBarrier({
      sheetBarrier,
      noteBarrier: noteBarrierFail("存在未处理的保存冲突"),
    });

    const result = await barrier(navigate);

    expect(result.ok).toBe(false);
    expect(result.failedBy).toBe("note");
    expect(result.reason).toContain("冲突");
    expect(navigate).not.toHaveBeenCalled();
    expect(sheetBarrier).not.toHaveBeenCalled(); // 首个失败即停，不做无谓写
  });

  it("笔记成功但题纸失败：拒答并归因 sheet", async () => {
    const navigate = vi.fn();
    const barrier = composeSheetLeaveBarrier({
      sheetBarrier: async () => false,
      noteBarrier: noteBarrierOk(async () => {}),
    });

    const result = await barrier(navigate);

    expect(result.ok).toBe(false);
    expect(result.failedBy).toBe("sheet");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("无笔记屏障（侧栏未打开/未选笔记）：退化为纯题纸语义", async () => {
    const navigate = vi.fn(async () => {});
    const barrier = composeSheetLeaveBarrier({ sheetBarrier: async () => true, noteBarrier: null });

    const result = await barrier(navigate);

    expect(result.ok).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("无笔记屏障且题纸失败：仍拒答", async () => {
    const navigate = vi.fn();
    const barrier = composeSheetLeaveBarrier({ sheetBarrier: async () => false, noteBarrier: null });

    const result = await barrier(navigate);

    expect(result.ok).toBe(false);
    expect(result.failedBy).toBe("sheet");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("题纸屏障抛异常：按失败处理（不把未确认作答带出本页）", async () => {
    const navigate = vi.fn();
    const barrier = composeSheetLeaveBarrier({
      sheetBarrier: async () => {
        throw new Error("题纸保存控制器缺失");
      },
      noteBarrier: noteBarrierOk(async () => {}),
    });

    const result = await barrier(navigate);

    expect(result.ok).toBe(false);
    expect(result.failedBy).toBe("sheet");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("笔记屏障抛异常：同样拒答并归因 note（适配层失手也不放行）", async () => {
    const navigate = vi.fn();
    const sheetBarrier = vi.fn(async () => true);
    const barrier = composeSheetLeaveBarrier({
      sheetBarrier,
      noteBarrier: async () => {
        throw new Error("适配层异常");
      },
    });

    const result = await barrier(navigate);

    expect(result.ok).toBe(false);
    expect(result.failedBy).toBe("note");
    expect(navigate).not.toHaveBeenCalled();
    expect(sheetBarrier).not.toHaveBeenCalled();
  });

  it("导航动作抛异常：如实回报（已放行的导航失败不吞错）", async () => {
    const barrier = composeSheetLeaveBarrier({
      sheetBarrier: async () => true,
      noteBarrier: null,
    });

    const result = await barrier(async () => {
      throw new Error("导航失败");
    });

    expect(result.ok).toBe(false);
    expect(result.failedBy).toBe("navigation");
  });

  it("并发重入：同一次离开只执行一次导航（双击/连点不重复导航）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const navigate = vi.fn(async () => {});
    const barrier = composeSheetLeaveBarrier({
      sheetBarrier: async () => {
        await gate;
        return true;
      },
      noteBarrier: null,
    });

    const first = barrier(navigate);
    const second = barrier(navigate); // 屏障挂起期间的重复请求
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.failedBy).toBe("busy");
  });
});
