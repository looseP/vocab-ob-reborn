/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 升级工作台页（T10）组件测试：
 * - 待升级清单渲染（词面 / 方向 / 档位 / 快照时间）；
 * - 行内 start / cancel / complete；
 * - 工作台展开把工单 direction 注入 composer（锁定）；
 * - onConfirmed → POST :id/complete。
 * Composer 用 stub 替身（真实 Composer 的行为在 frontend-word-l2.test.ts 覆盖），
 * 让本文件聚焦页面接线。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast: addToastMock }),
}));
vi.mock("@/frontend/components/words/WordL2Composer", async () => {
  const { createElement } = await import("react");
  return {
    WordL2Composer: (props: {
      slug: string;
      direction?: string;
      directionLocked?: boolean;
      onConfirmed: () => void;
    }) =>
      createElement(
        "button",
        {
          "data-testid": "composer-stub",
          "data-slug": props.slug,
          "data-direction": props.direction,
          "data-locked": String(props.directionLocked),
          onClick: props.onConfirmed,
        },
        "composer-stub",
      ),
  };
});

import { apiFetch } from "@/frontend/api/client";
import { resetDefaultWordbookCache } from "@/frontend/api/wordbooks";
import { UpgradePage } from "@/frontend/pages/UpgradePage";

const apiFetchMock = vi.mocked(apiFetch);

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) {
      mounted.root.unmount();
    }
  });
  document.body.innerHTML = "";
});

const ITEM = {
  id: "wo-1",
  user_id: "user-1",
  word_id: "word-1",
  wordbook_id: "wb-1",
  direction: "考研",
  status: "标记中",
  suggestion_snapshot: { level: "normal", capturedAt: "2026-09-11T08:00:00.000Z" },
  created_at: "2026-09-11T07:00:00.000Z",
  updated_at: "2026-09-11T07:00:00.000Z",
  completed_at: null,
  word: { slug: "comprehend", text: "comprehend" },
  suggestion: "normal",
};

async function renderPage(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(createElement(MemoryRouter, null, createElement(UpgradePage) as ReactElement));
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button as HTMLButtonElement;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  addToastMock.mockReset();
  resetDefaultWordbookCache();
});

describe("UpgradePage", () => {
  it("lists pending work orders with word surface, direction, suggestion and snapshot time", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/wordbooks/default") {
        return { id: "wb-1", name: "默认词书", description: null, isDefault: true };
      }
      if (path.startsWith("/upgrade-work-orders?")) return { items: [ITEM] };
      throw new Error(`unexpected path: ${path}`);
    });

    const container = await renderPage();
    await waitFor(() => expect(container.textContent).toContain("comprehend"));
    expect(container.textContent).toContain("考研");
    expect(container.textContent).toContain("推荐升级");
    expect(container.textContent).toContain("快照");
    expect(container.textContent).toContain("标记中");
    expect(container.textContent).toContain("默认词书");
    // 词面链接到词条详情。
    const link = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/words/comprehend",
    );
    expect(link).toBeTruthy();
  });

  it("start moves 标记中 → 升级中 and reveals the workbench with the locked direction", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/wordbooks/default") {
        return { id: "wb-1", name: "默认词书", description: null, isDefault: true };
      }
      if (path.startsWith("/upgrade-work-orders?")) return { items: [ITEM] };
      if (path === "/upgrade-work-orders/wo-1/start") return { ...ITEM, status: "升级中" };
      throw new Error(`unexpected path: ${path}`);
    });

    const container = await renderPage();
    await waitFor(() => expect(container.textContent).toContain("comprehend"));

    await act(async () => {
      fireEvent.click(findButton(container, "开始升级"));
    });

    const startCall = apiFetchMock.mock.calls.find((call) => call[0] === "/upgrade-work-orders/wo-1/start");
    expect(startCall).toBeTruthy();
    expect((startCall?.[1] as RequestInit | undefined)?.method).toBe("POST");
    expect(container.textContent).toContain("升级中");

    await act(async () => {
      fireEvent.click(findButton(container, "打开工作台"));
    });

    const stub = container.querySelector("[data-testid='composer-stub']") as HTMLElement | null;
    expect(stub).toBeTruthy();
    expect(stub?.getAttribute("data-slug")).toBe("comprehend");
    expect(stub?.getAttribute("data-direction")).toBe("考研");
    expect(stub?.getAttribute("data-locked")).toBe("true");
  });

  it("onConfirmed completes the upgrade and removes the row", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/wordbooks/default") {
        return { id: "wb-1", name: "默认词书", description: null, isDefault: true };
      }
      if (path.startsWith("/upgrade-work-orders?")) return { items: [{ ...ITEM, status: "升级中" }] };
      if (path === "/upgrade-work-orders/wo-1/complete") {
        return { workOrder: { ...ITEM, status: "已完成" }, alreadyPromoted: false, l2DueAt: null, seeded: false };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const container = await renderPage();
    await waitFor(() => expect(container.textContent).toContain("comprehend"));

    await act(async () => {
      fireEvent.click(findButton(container, "打开工作台"));
    });
    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid='composer-stub']") as HTMLButtonElement);
    });

    const completeCall = apiFetchMock.mock.calls.find((call) => call[0] === "/upgrade-work-orders/wo-1/complete");
    expect(completeCall).toBeTruthy();
    expect((completeCall?.[1] as RequestInit | undefined)?.method).toBe("POST");
    expect(addToastMock).toHaveBeenCalledWith("success", expect.stringContaining("升级完成"));
    await waitFor(() => expect(container.textContent).not.toContain("comprehend"));
  });

  it("cancel removes the row and posts cancel", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/wordbooks/default") {
        return { id: "wb-1", name: "默认词书", description: null, isDefault: true };
      }
      if (path.startsWith("/upgrade-work-orders?")) return { items: [ITEM] };
      if (path === "/upgrade-work-orders/wo-1/cancel") return { ...ITEM, status: "已取消" };
      throw new Error(`unexpected path: ${path}`);
    });

    const container = await renderPage();
    await waitFor(() => expect(container.textContent).toContain("comprehend"));

    await act(async () => {
      fireEvent.click(findButton(container, "取消"));
    });

    const cancelCall = apiFetchMock.mock.calls.find((call) => call[0] === "/upgrade-work-orders/wo-1/cancel");
    expect(cancelCall).toBeTruthy();
    await waitFor(() => expect(container.textContent).not.toContain("comprehend"));
  });

  it("renders an empty state when there are no pending work orders", async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/wordbooks/default") {
        return { id: "wb-1", name: "默认词书", description: null, isDefault: true };
      }
      if (path.startsWith("/upgrade-work-orders?")) return { items: [] };
      throw new Error(`unexpected path: ${path}`);
    });

    const container = await renderPage();
    await waitFor(() => expect(container.textContent).toContain("没有待升级的词"));
    // 清单请求带 wordbookId（默认词书）。
    const listCall = apiFetchMock.mock.calls.find((call) => String(call[0]).startsWith("/upgrade-work-orders?"));
    expect(String(listCall?.[0])).toContain("wordbookId=wb-1");
  });
});
