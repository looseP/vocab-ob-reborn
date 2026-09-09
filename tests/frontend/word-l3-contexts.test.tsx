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

async function renderContexts(slug: string, page: unknown, fallbackSense?: string | null): Promise<void> {
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
        createElement(WordL3Contexts, { slug, fallbackSense }) as ReactElement,
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
    expect(link?.getAttribute("href")).toBe("/l3?sourceId=s1&contextId=c1");
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

  it("explains delete blockers in Chinese on 409", async () => {
    const { BrowserApiError } = await import("@/frontend/api/browserRequest");
    (apiFetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PAGE)
      .mockRejectedValueOnce(new BrowserApiError(409, { error: "CONFLICT" }));
    Object.defineProperty(window, "confirm", { value: () => true, configurable: true, writable: true });
    await renderContexts("ephemeral", PAGE);
    await waitFor(() => expect(screen.getByText(/ephemeral beauty/)).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("删除"));
      await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("error", expect.stringContaining("关联引用")));
    });
  });

  // ── Context quiz（grill 2026-09-09）：无状态语境自测 ──────────────────────

  const QUIZ_PAGE = {
    items: [
      {
        context: { id: "q1", text: "The ephemeral beauty of cherry blossoms.", created_at: "2026-09-07T00:00:00Z" },
        source: { id: "s1", title: "阅读 Text B" },
        occurrence: { bound_sense: "转瞬即逝的" },
      },
      {
        context: { id: "q2", text: "An enduring friendship.", created_at: "2026-09-08T00:00:00Z" },
        source: { id: "s2", title: "阅读 Text C" },
      },
    ],
    limit: 10, cursor: null, nextCursor: null,
  };

  it("hides the quiz toggle when there are no contexts", async () => {
    await renderContexts("ephemeral", { items: [], limit: 10, cursor: null, nextCursor: null });
    await waitFor(() => expect(screen.getByText("暂无语境记录")).toBeTruthy());
    expect(screen.queryByTestId("context-quiz-toggle")).toBeNull();
  });

  it("keeps bound sense plain outside quiz mode and reveals it inside", async () => {
    await renderContexts("ephemeral", QUIZ_PAGE);
    await waitFor(() => expect(screen.getByText(/ephemeral beauty/)).toBeTruthy());
    // 非自测态：绑定释义平铺可见，无 Reveal 元素
    expect(screen.getByText("绑定释义：转瞬即逝的")).toBeTruthy();
    expect(screen.queryByTestId("reveal")).toBeNull();

    await act(async () => { fireEvent.click(screen.getByTestId("context-quiz-toggle")); });
    // 自测态：释义进 Reveal（初始遮盖），点击揭示
    const reveals = screen.getAllByTestId("reveal");
    expect(reveals.length).toBe(1);
    expect(reveals[0].getAttribute("data-shown")).toBe("false");
    expect(reveals[0].textContent).toContain("转瞬即逝的");
    await act(async () => { fireEvent.click(reveals[0]); });
    expect(reveals[0].getAttribute("data-shown")).toBe("true");
  });

  it("falls back to the word short definition in quiz mode when bound sense is empty", async () => {
    await renderContexts("ephemeral", QUIZ_PAGE, "易消逝的；短促的");
    await waitFor(() => expect(screen.getByText(/enduring friendship/)).toBeTruthy());
    // 非自测态：无 bound_sense 的条目不渲染释义行（维持既有展示）
    expect(screen.queryByText(/绑定释义：易消逝的/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId("context-quiz-toggle")); });
    // 自测态：fallback 短释义出现且被遮盖，UI 与 bound_sense 不区分
    const reveals = screen.getAllByTestId("reveal");
    expect(reveals.length).toBe(2);
    const fallbackReveal = reveals.find((r) => r.textContent?.includes("易消逝的"));
    expect(fallbackReveal).toBeTruthy();
    expect(fallbackReveal!.getAttribute("data-shown")).toBe("false");
  });
});
