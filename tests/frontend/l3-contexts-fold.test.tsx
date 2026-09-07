/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";
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
  },
];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

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
        createElement(L3ContextsFold, { items, slug }) as ReactElement,
      ),
    );
  });
  return container;
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
    expect(container.firstChild).toBeNull();
  });

  it("shows collapsed entry with count and expands to text + deep link", () => {
    mountFold(ITEMS, "ephemeral");
    expect(screen.getByText("1 条语境")).toBeTruthy();
    // 折叠展开：summary 点击在 jsdom 下经由 details 原生行为/act 包裹驱动
    act(() => {
      fireEvent.click(screen.getByText("1 条语境"));
    });
    expect(screen.getByText(/ephemeral beauty/)).toBeTruthy();
    expect(screen.getByText(/阅读 Text B/)).toBeTruthy();
    const link = screen.getByText("在素材空间查看").closest("a");
    expect(link?.getAttribute("href")).toContain("sourceId=s1");
  });
});
