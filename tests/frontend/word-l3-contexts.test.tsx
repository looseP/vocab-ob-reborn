/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WordL3Contexts } from "@/frontend/components/words/WordL3Contexts";

// 仓库无 @testing-library/react，按 tests/frontend/l3-reading-view.test.tsx 惯例
// 用 createRoot + act 手动挂载，queries 用 @testing-library/dom。

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
// useToast 依赖 ToastProvider 上下文，直接 mock 掉。addToast 引用必须跨渲染稳定
// （参照 tests/frontend/l3-bookshelf.test.tsx 的 vi.hoisted 手法，避免无限 refetch）。
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));
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
  beforeEach(() => {
    (apiFetch as ReturnType<typeof vi.fn>).mockReset();
    addToastMock.mockReset();
  });

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

  it("submits quick capture and prepends the new context", async () => {
    (apiFetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PAGE)
      .mockResolvedValueOnce({ ok: true, sourceId: "s", contextId: "c2", occurrenceId: "o" })
      .mockResolvedValueOnce({
        items: [
          { context: { id: "c2", text: "新造的句子 ephemeral here.", created_at: "2026-09-07T01:00:00Z" }, source: { id: "s2", title: "手动记录" } },
          ...PAGE.items,
        ],
        limit: 10, cursor: null, nextCursor: null,
      });
    await renderContexts("ephemeral", PAGE);
    await waitFor(() => expect(screen.getByText(/ephemeral beauty/)).toBeTruthy());
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/粘贴句子/), { target: { value: "新造的句子 ephemeral here." } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText("快记"));
    });
    await screen.findByText(/新造的句子/);
    expect((apiFetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe("/l3/quick-context");
  });

  // P0 语境管理出口（2026-09-08 评估）：capture-first 无门控必然产生噪音，
  // 用户面必须有删除出口（复用 DELETE /api/l3/contexts/:id + 服务端 blockers）。
  const realConfirm = window.confirm.bind(window);
  afterEach(() => {
    Object.defineProperty(window, "confirm", { value: realConfirm, configurable: true, writable: true });
  });

  it("deletes a context after confirmation and reloads the list", async () => {
    (apiFetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PAGE) // 初始加载
      .mockResolvedValueOnce({ deleted: { entityType: "context", id: "c1" }, activeReadInvalidation: true }) // DELETE
      .mockResolvedValueOnce({ items: [], limit: 10, cursor: null, nextCursor: null }); // reload
    Object.defineProperty(window, "confirm", { value: () => true, configurable: true, writable: true });
    await renderContexts("ephemeral", PAGE);
    await waitFor(() => expect(screen.getByText(/ephemeral beauty/)).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("删除"));
    });
    await screen.findByText("暂无语境记录");
    const calls = (apiFetch as ReturnType<typeof vi.fn>).mock.calls;
    const deleteCall = calls.find(([url]) => String(url) === "/l3/contexts/c1");
    expect(deleteCall).toBeTruthy();
    expect((deleteCall![1] as { method?: string }).method).toBe("DELETE");
  });

  it("keeps the context when confirmation is dismissed", async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE);
    Object.defineProperty(window, "confirm", { value: () => false, configurable: true, writable: true });
    await renderContexts("ephemeral", PAGE);
    await waitFor(() => expect(screen.getByText(/ephemeral beauty/)).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("删除"));
    });
    await waitFor(() => expect(screen.getByText(/ephemeral beauty/)).toBeTruthy());
    expect((apiFetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url) === "/l3/contexts/c1")).toBe(false);
  });

  it("toasts a friendly error when delete fails", async () => {
    (apiFetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PAGE)
      .mockRejectedValueOnce(new Error("conflict"));
    Object.defineProperty(window, "confirm", { value: () => true, configurable: true, writable: true });
    await renderContexts("ephemeral", PAGE);
    await waitFor(() => expect(screen.getByText(/ephemeral beauty/)).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("删除"));
      await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("error", "删除失败，请重试"));
    });
  });
});
