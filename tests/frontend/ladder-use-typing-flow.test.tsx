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
function mountTypingFlow(target: string, onDone?: (r: { wrongTimes: number }) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let latest: ReturnType<typeof useTypingFlow> | null = null;
  function Harness() {
    latest = useTypingFlow(target, onDone);
    return createElement("div", {
      "data-typed": String(latest.typedLength),
      "data-expected": latest.expectedChar ?? "",
      "data-flash": latest.wrongFlash ?? "",
      "data-wrong": String(latest.wrongTimes),
      "data-done": String(latest.done),
    });
  }
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Harness));
  });
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
});
