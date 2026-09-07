/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen, waitFor } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WordL3Contexts } from "@/frontend/components/words/WordL3Contexts";

// 仓库无 @testing-library/react，按 tests/frontend/l3-reading-view.test.tsx 惯例
// 用 createRoot + act 手动挂载，queries 用 @testing-library/dom。

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "@/frontend/api/client";

const PAGE = {
  items: [{
    context: { id: "c1", text: "The ephemeral beauty of cherry blossoms.", created_at: "2026-09-07T00:00:00Z" },
    source: { id: "s1", title: "阅读 Text B" },
  }],
  limit: 10, cursor: null, nextCursor: null,
};

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

async function renderContexts(slug: string, page: unknown): Promise<void> {
  const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
  apiFetchMock.mockResolvedValue(page);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(WordL3Contexts, { slug }) as ReactElement,
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

describe("WordL3Contexts", () => {
  beforeEach(() => { (apiFetch as ReturnType<typeof vi.fn>).mockReset(); });

  it("loads and renders contexts with per-item source deep links", async () => {
    await renderContexts("ephemeral", PAGE);
    await waitFor(() => expect(screen.getByText(/ephemeral beauty/)).toBeTruthy());
    expect(screen.getByText(/阅读 Text B/)).toBeTruthy();
    const link = screen.getAllByText(/素材空间/)[0].closest("a");
    expect(link?.getAttribute("href")).toBe("/l3?sourceId=s1");
  });

  it("renders empty hint when no contexts", async () => {
    await renderContexts("ephemeral", { items: [], limit: 10, cursor: null, nextCursor: null });
    await waitFor(() => expect(screen.getByText("暂无语境记录")).toBeTruthy());
  });
});
