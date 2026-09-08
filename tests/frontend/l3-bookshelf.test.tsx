/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3Bookshelf } from "@/frontend/components/l3/L3Bookshelf";

// 仓库无 @testing-library/react，按 tests/frontend/l3-reading-view.test.tsx 惯例
// 用 createRoot + act 手动挂载，queries 用 @testing-library/dom。

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
// useToast 依赖 ToastProvider 上下文，直接 mock 掉。注意 addToast 引用必须跨渲染稳定：
// load 的 useCallback 依赖 addToast，若每次渲染返回新引用会导致 effect 无限 refetch。
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";

const PAGE = {
  items: [{ id: "s1", title: "The Economist", source_type: "web", url: null, created_at: "2026-09-07T00:00:00Z", context_count: 12 }],
  total: 1, limit: 20, offset: 0,
};

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

async function renderBookshelf(onOpen: (sourceId: string) => void): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(L3Bookshelf, { onOpen }) as ReactElement,
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

describe("L3Bookshelf", () => {
  beforeEach(() => {
    (apiFetch as ReturnType<typeof vi.fn>).mockReset();
    addToastMock.mockReset();
  });

  it("lists sources with badges and opens via onOpen", async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE);
    const onOpen = vi.fn();
    await renderBookshelf(onOpen);
    await waitFor(() => expect(screen.getByText(/The Economist/)).toBeTruthy());
    expect(screen.getByText("12 语境")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText(/The Economist/));
    });
    expect(onOpen).toHaveBeenCalledWith("s1");
  });

  it("type filter refetches with sourceType param", async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    await renderBookshelf(vi.fn());
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await act(async () => {
      fireEvent.click(screen.getByText("公众号/网页"));
    });
    await waitFor(() => {
      const last = (apiFetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
      expect(last).toContain("sourceType=web");
    });
  });

  it("import form defaults title from first line and posts contentText", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    apiFetchMock
      .mockResolvedValueOnce({ items: [], total: 0, limit: 20, offset: 0 }) // 初始 load
      .mockResolvedValueOnce({ source: { id: "s2", title: "New article" } }) // POST /l3/sources
      .mockResolvedValueOnce(PAGE); // 导入成功后 reload
    await renderBookshelf(vi.fn());
    await act(async () => {
      fireEvent.click(screen.getByText("导入文章"));
    });
    const textarea = screen.getByPlaceholderText(/粘贴正文/) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "New article\nBody here..." } });
      fireEvent.blur(textarea);
    });
    await act(async () => {
      fireEvent.click(screen.getByText("导入"));
    });
    await waitFor(() => {
      const post = apiFetchMock.mock.calls.find(([, init]) => (init as RequestInit).method === "POST");
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.title).toBe("New article");
      expect(body.contentText).toBe("New article\nBody here...");
    });
  });

  it("deletes a source after confirm and reloads the shelf", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    apiFetchMock
      .mockResolvedValueOnce(PAGE) // 初始 load
      .mockResolvedValueOnce({ deleted: true }) // DELETE /l3/sources/s1
      .mockResolvedValueOnce({ items: [], total: 0, limit: 20, offset: 0 }); // 删除后 reload
    await renderBookshelf(vi.fn());
    await waitFor(() => expect(screen.getByText(/The Economist/)).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByLabelText("删除来源 The Economist"));
    });
    await waitFor(() => {
      const del = apiFetchMock.mock.calls.find(([, init]) => (init as RequestInit).method === "DELETE");
      expect(del?.[0]).toBe("/l3/sources/s1");
    });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("success", "已删除该来源"));
    confirmSpy.mockRestore();
  });

  it("surfaces a friendly blocker message when delete is rejected with 409", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    apiFetchMock
      .mockResolvedValueOnce(PAGE) // 初始 load
      .mockRejectedValueOnce(new BrowserApiError(409, {
        error: "CONFLICT",
        message: "Cannot delete L3 source with active dependencies",
        details: { entityType: "source", id: "s1", blockers: { contextCount: 2, inboundContextLinkCount: 0, importJobCount: 0 } },
      }));
    await renderBookshelf(vi.fn());
    await waitFor(() => expect(screen.getByText(/The Economist/)).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByLabelText("删除来源 The Economist"));
    });
    await waitFor(() =>
      expect(addToastMock).toHaveBeenCalledWith("error", "先清理该来源的 2 条语境，再删除来源"),
    );
    // 409 后不应 reload（列表保持原样）
    expect(apiFetchMock.mock.calls.filter(([, init]) => (init as RequestInit).method === "DELETE")).toHaveLength(1);
    expect(apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith("/l3/sources?"))).toHaveLength(1);
    confirmSpy.mockRestore();
  });

  it("does not call the delete endpoint when confirm is dismissed", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    apiFetchMock.mockResolvedValue(PAGE);
    await renderBookshelf(vi.fn());
    await waitFor(() => expect(screen.getByText(/The Economist/)).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByLabelText("删除来源 The Economist"));
    });
    expect(apiFetchMock.mock.calls.filter(([, init]) => (init as RequestInit).method === "DELETE")).toHaveLength(0);
    expect(addToastMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
