/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3ReadingView } from "@/frontend/components/l3/L3ReadingView";

// 仓库无 @testing-library/react，按 tests/l3-manual-editor-page.test.ts 惯例
// 用 createRoot + act 手动挂载，queries 用 @testing-library/dom。

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "@/frontend/api/client";

const SPACE = {
  source: { id: "s1", title: "The Economist", source_type: "web", language: "en", content_text: "Alpha beta. Gamma delta epsilon. Zeta." },
  contexts: [
    { id: "c1", text: "Gamma delta epsilon.", position: { start: 12, end: 32 } },
  ],
  occurrences: [],
  links: [],
  words: [{ id: "w-1", slug: "delta", title: "delta" }],
  stats: {},
  limit: 200, cursor: null, nextCursor: null,
};

// 用例 2 的深链断言要求高亮渲染为 Link（context 已绑词）：
// SPACE.occurrences 为空时组件按计划渲染 <mark>，closest("a") 恒为 null，
// 故仅该用例补一条 occurrence 绑定，其余 mock 值与计划保持一致。
const SPACE_WITH_LINK = {
  ...SPACE,
  occurrences: [{ context_id: "c1", word_id: "w-1" }],
};

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

async function renderView(sourceId: string, space: unknown): Promise<void> {
  const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
  apiFetchMock.mockResolvedValue(space);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(L3ReadingView, { sourceId }) as ReactElement,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
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

describe("L3ReadingView", () => {
  beforeEach(() => { (apiFetch as ReturnType<typeof vi.fn>).mockReset(); });

  it("renders full text with highlight only at captured anchors", async () => {
    await renderView("s1", SPACE);
    await waitFor(() => expect(screen.getByText(/Gamma delta epsilon/)).toBeTruthy());
    expect(screen.getByText(/Alpha beta/)).toBeTruthy();
    const mark = screen.getByText(/Gamma delta epsilon/).closest("mark");
    expect(mark).toBeTruthy();
  });

  it("navigates to word detail on highlight click", async () => {
    await renderView("s1", SPACE_WITH_LINK);
    await screen.findByText(/Gamma delta epsilon/);
    await act(async () => {
      fireEvent.click(screen.getByText(/Gamma delta epsilon/));
    });
    // 深链断言：跳词卡由 Link to=/words/delta 完成
    expect(screen.getByText(/Gamma delta epsilon/).closest("a")).toBeTruthy();
  });

  it("shows empty state when source has no content_text", async () => {
    await renderView("s1", {
      ...SPACE, source: { ...SPACE.source, content_text: null },
    });
    await waitFor(() => expect(screen.getByText("该来源无正文")).toBeTruthy());
  });
});
