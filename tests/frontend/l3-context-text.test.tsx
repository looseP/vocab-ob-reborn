/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * L3ContextText：语境正文的共享渲染件（2026-10-04）。
 *
 * 两条口径都要钉住：
 * - `〖n〗` 卷面空号 → 角标，绝不原样泄漏；
 * - `masked` 时遮盖目标词（提示级用法），未遮盖时原样（卡背折叠用法）。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/dom";
import { afterEach, describe, expect, it } from "vitest";
import { L3ContextText } from "@/frontend/components/review/L3ContextText";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(props: Parameters<typeof L3ContextText>[0]): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  act(() => {
    root.render(createElement(L3ContextText, props) as ReactElement);
  });
  return container;
}

afterEach(() => {
  act(() => {
    for (const { root } of mountedRoots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

const EXAM_TEXT = "〖45〗 When pitching a new idea, use the language of abundance.";

describe("L3ContextText", () => {
  it("不遮盖时原样呈现正文，空号渲染为角标", () => {
    const container = mount({ text: EXAM_TEXT });
    expect(screen.getByTestId("passage-blank-badge").textContent).toBe("45");
    expect(container.textContent).not.toContain("〖");
    expect(container.querySelectorAll('[data-testid="clue-mask"]')).toHaveLength(0);
    expect(container.textContent).toContain("abundance");
  });

  it("masked + maskTerm：目标词进入遮罩（同色底字占位，点击揭示）", () => {
    const container = mount({ text: EXAM_TEXT, maskTerm: "abundance", masked: true });
    const masks = container.querySelectorAll('[data-testid="clue-mask"]');
    expect(masks).toHaveLength(1);
    // 未揭示：同色底 + 同色字（隐形但占位）
    expect((masks[0] as HTMLElement).style.color).toBe("var(--color-highlight)");
    // 空号角标与遮罩共存（两个渲染规则互不干扰）
    expect(screen.getByTestId("passage-blank-badge").textContent).toBe("45");
  });

  it("点击遮罩 → 揭示词形（遮罩节点消失，词形以强调色呈现）", () => {
    const container = mount({ text: EXAM_TEXT, maskTerm: "abundance", masked: true });
    act(() => {
      (container.querySelector('[data-testid="clue-mask"]') as HTMLElement).click();
    });
    expect(container.querySelectorAll('[data-testid="clue-mask"]')).toHaveLength(0);
    expect(container.textContent).toContain("abundance");
  });

  it("maskTerm 在正文中定位不到 → 不产生遮罩（不猜、不误遮）", () => {
    const container = mount({ text: EXAM_TEXT, maskTerm: "incentive", masked: true });
    expect(container.querySelectorAll('[data-testid="clue-mask"]')).toHaveLength(0);
    expect(container.textContent).toContain("abundance");
  });

  it("maskTerm 为空（卡背折叠用法）→ 不遮盖", () => {
    const container = mount({ text: EXAM_TEXT, masked: true });
    expect(container.querySelectorAll('[data-testid="clue-mask"]')).toHaveLength(0);
    expect(container.textContent).toContain("abundance");
  });
});
