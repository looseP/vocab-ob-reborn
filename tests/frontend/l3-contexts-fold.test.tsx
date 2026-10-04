/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/dom";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { L3ContextsFold, type ReviewL3ContextItem } from "@/frontend/components/review/L3ContextsFold";

// 仓库无 @testing-library/react，按 tests/frontend/l3-reading-view.test.tsx 惯例
// 用 createRoot + act 手动挂载，queries 用 @testing-library/dom。

const ITEMS: ReviewL3ContextItem[] = [
  {
    context_id: "c1",
    source_id: "s1",
    text: "The ephemeral beauty of cherry blossoms.",
    source_title: "阅读 Text B",
    bound_sense: null,
    surface: "ephemeral",
  },
];

/** 真题形态：卷面空号 `〖45〗` 是**数据编码**，不得原样落到用户眼前。 */
const EXAM_ITEMS: ReviewL3ContextItem[] = [
  {
    context_id: "c2",
    source_id: "s2",
    text: "〖45〗 When pitching a new idea, it's important to use the language of abundance instead of the language of deficit.",
    source_title: "2025 英语二 · Part B 职场提建议五步法（小标题匹配）",
    bound_sense: "丰富的；充裕的；大量的",
    surface: "abundance",
  },
];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function LocationProbe() {
  const location = useLocation();
  return createElement("span", { "data-testid": "loc" }, `${location.pathname}|${JSON.stringify(location.state ?? null)}`);
}

function mountFold(items: ReviewL3ContextItem[], slug: string): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(LocationProbe),
        createElement(L3ContextsFold, { items, slug }) as ReactElement,
      ),
    );
  });
  return container;
}

function expand(): void {
  act(() => {
    fireEvent.click(screen.getByText("1 条语境"));
  });
}

afterEach(() => {
  act(() => {
    for (const { root } of mountedRoots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
});

describe("L3ContextsFold", () => {
  it("renders nothing without items", () => {
    const container = mountFold([], "ephemeral");
    // 无条目 ⇒ 折叠块整体缺席（容器里只剩位置探针，不属于本组件）
    expect(container.querySelector("details")).toBeNull();
    expect(screen.queryByText("1 条语境")).toBeNull();
  });

  it("shows collapsed entry with count and expands to text + deep link", () => {
    mountFold(ITEMS, "ephemeral");
    expect(screen.getByText("1 条语境")).toBeTruthy();
    // 折叠展开：summary 点击在 jsdom 下经由 details 原生行为/act 包裹驱动
    expand();
    expect(screen.getByText(/ephemeral beauty/)).toBeTruthy();
    expect(screen.getByText(/阅读 Text B/)).toBeTruthy();
    // P0-2：逐条语境深链携带 sourceId + contextId（阅读视图滚动+闪高亮落点）
    const link = screen.getByText(/在素材空间查看/).closest("a");
    expect(link?.getAttribute("href")).toBe("/l3?sourceId=s1&contextId=c1");
  });

  // ── 〖n〗 卷面空号（2026-10-04，FR-12 接线1）：不得泄漏给用户 ──────────────
  it("卷面空号渲染为角标，正文不含 〖 〗 原文", () => {
    const container = mountFold(EXAM_ITEMS, "abundant");
    expand();
    const badge = screen.getByTestId("passage-blank-badge");
    expect(badge.textContent).toBe("45");
    expect(badge.getAttribute("title")).toBe("试卷第 45 空");
    // 泄漏回归：整块文本里不能再出现占位符字符
    expect(container.textContent).not.toContain("〖");
    expect(container.textContent).not.toContain("〗");
    // 句子内容本身必须完整（解析只许剥编码，不许吞内容）
    expect(container.textContent).toContain("When pitching a new idea");
    expect(container.textContent).toContain("instead of the language of deficit.");
  });

  it("无空号的语境不受影响（不引入空白角标）", () => {
    mountFold(ITEMS, "ephemeral");
    expand();
    expect(screen.queryByTestId("passage-blank-badge")).toBeNull();
  });

  // ── 回程标记（2026-10-04）：跳去 L3 时带上"从复习卡来"的标记 ──────────────
  it("深链点击携带 state.fromReview（L3 侧据此给出返回复习出口）", async () => {
    mountFold(ITEMS, "ephemeral");
    expand();
    const link = screen.getByText(/在素材空间查看/).closest("a") as HTMLAnchorElement;
    await act(async () => {
      fireEvent.click(link);
      await Promise.resolve();
    });
    expect(screen.getByTestId("loc").textContent).toBe('/l3|{"fromReview":true}');
  });
});
