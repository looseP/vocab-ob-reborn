/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * useTypingFlow 阻塞式逐字状态机单元测试（ADR-0036 / LW-1 验收）：
 * - 正确流：逐位推进，大小写归一；
 * - 错键流：阻塞不前进、wrongFlash 标注、wrongTimes 只增不减；
 * - 完成回调：一次性触发，携带累计 wrongTimes。
 */

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTypingFlow } from "@/frontend/hooks/useTypingFlow";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) mounted.root.unmount();
  });
  document.body.innerHTML = "";
});

/** Hook 测试挂具：把状态机快照透出到 data 属性供断言。 */
function mountTypingFlow(initialTarget: string, onDone?: (r: { wrongTimes: number }) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let latest: ReturnType<typeof useTypingFlow> | null = null;
  // 目标词存 ref，由 setTarget 改写后经 rerender 重新渲染 Harness——与真实组件
  // 「父级换 prop」等价，而非卸载重挂载（那样会绕过我们想验证的 hook 内部重置）。
  const targetRef = { current: initialTarget };
  function Harness() {
    latest = useTypingFlow(targetRef.current, onDone);
    return createElement("div", {
      "data-typed": String(latest.typedLength),
      "data-expected": latest.expectedChar ?? "",
      "data-flash": latest.wrongFlash ?? "",
      "data-wrong": String(latest.wrongTimes),
      "data-done": String(latest.done),
    });
  }
  const root = createRoot(container);
  const rerender = () => {
    act(() => {
      root.render(createElement(Harness));
    });
  };
  rerender();
  mountedRoots.push({ root, container });
  return {
    get snap() {
      return latest!;
    },
    key(ch: string) {
      act(() => {
        latest!.handleKey(ch);
      });
    },
    /** 模拟父级换词：改 target 后重渲染，组件实例保持不变。 */
    setTarget(next: string) {
      targetRef.current = next;
      rerender();
    },
    /** 同 target 重渲染（不应触发重置）。 */
    rerender,
  };
}

describe("useTypingFlow", () => {
  it("正确流：逐位推进，大小写归一（字母全归答案）", () => {
    const h = mountTypingFlow("Cat");
    expect(h.snap.expectedChar).toBe("C");
    h.key("c");
    expect(h.snap.typedLength).toBe(1);
    h.key("a");
    expect(h.snap.typedLength).toBe(2);
    h.key("T");
    expect(h.snap.typedLength).toBe(3);
    expect(h.snap.done).toBe(true);
    expect(h.snap.expectedChar).toBeNull();
  });

  it("错键流：阻塞不前进、wrongTimes 只增不减、正确键入清除闪示", () => {
    const h = mountTypingFlow("hi");
    h.key("x");
    expect(h.snap.typedLength).toBe(0);
    expect(h.snap.wrongTimes).toBe(1);
    expect(h.snap.wrongFlash).toBe("x");
    h.key("y");
    expect(h.snap.wrongTimes).toBe(2); // 只增不减
    expect(h.snap.wrongFlash).toBe("y");
    h.key("h");
    expect(h.snap.typedLength).toBe(1);
    expect(h.snap.wrongFlash).toBeNull(); // 正确键入清除闪示
    expect(h.snap.wrongTimes).toBe(2); // 计数不回退
  });

  it("完成回调一次性触发并携带累计错键数", () => {
    const onDone = vi.fn();
    const h = mountTypingFlow("go", onDone);
    h.key("g");
    h.key("o");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith({ wrongTimes: 0 });
    // 完成后多余键入不推进也不重复回调
    h.key("g");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(h.snap.typedLength).toBe(2);
  });

  it("多错键后完成：回调携带累计 wrongTimes", () => {
    const onDone = vi.fn();
    const h = mountTypingFlow("ab", onDone);
    h.key("z");
    h.key("z");
    h.key("a");
    h.key("b");
    expect(onDone).toHaveBeenCalledWith({ wrongTimes: 2 });
  });

  /**
   * 回归：换词不清进度 → 巩固轮死锁（P0，2026-09-29 实测）。
   *
   * 现象：卡面显示「跟写完成」但输入框消失、也不调 onDone，会话无按钮可点。
   * 成因：视图缺 key 时 React 按位置复用实例，useTypingFlow 的 typedLength /
   * doneRef 跨卡残留；新词比旧词短时 done 立即为真、onDone 因 doneRef 已置位永不重触发。
   *
   * 本组断言纵深防御（目标词变化即清零）的两条不变量。
   */
  it("换词：typedLength / wrongTimes / doneRef 全部清零", () => {
    const onDone = vi.fn();
    const h = mountTypingFlow("cat", onDone);
    h.key("c");
    h.key("a");
    h.key("x"); // 故意错键
    h.key("t");
    expect(h.snap.done).toBe(true);
    expect(onDone).toHaveBeenCalledTimes(1);

    h.setTarget("ox"); // 更短的新词
    expect(h.snap.typedLength).toBe(0);
    expect(h.snap.wrongTimes).toBe(0);
    expect(h.snap.done).toBe(false);
    expect(h.snap.expectedChar).toBe("o");
  });

  it("换词：新词长度不短于旧词也不带旧进度开局（避免无关字符被高亮为已正确）", () => {
    const h = mountTypingFlow("ab", vi.fn());
    h.key("a");
    h.key("b");
    expect(h.snap.typedLength).toBe(2);

    h.setTarget("abnormal");
    expect(h.snap.typedLength).toBe(0);
    expect(h.snap.expectedChar).toBe("a");
  });

  it("换词后：上一词已触发的 doneRef 不再压制新词的完成回调", () => {
    const onDone = vi.fn();
    const h = mountTypingFlow("go", onDone);
    h.key("g");
    h.key("o");
    expect(onDone).toHaveBeenCalledTimes(1);

    h.setTarget("hi");
    h.key("h");
    h.key("i");
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenLastCalledWith({ wrongTimes: 0 });
  });

  it("目标词不变：不得重置（切档/重渲染不应清掉用户已键入的进度）", () => {
    const h = mountTypingFlow("cat", vi.fn());
    h.key("c");
    h.key("a");
    expect(h.snap.typedLength).toBe(2);
    h.rerender(); // 同 target 再渲染
    expect(h.snap.typedLength).toBe(2);
  });
});
