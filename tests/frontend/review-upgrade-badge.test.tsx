/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * L1 首学徽标（ADR-0018 / T10）组件测试：
 * - 有工单 → 档位徽标（链接 /upgrade）；
 * - 无工单 + 首学窗口 → 「标记升级」轻量入口，点击触发 POST mark；
 * - 窗口外 / preview 模式 → 不展示入口。
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
// 卡面 Markdown 依赖 marked/dompurify 懒加载（jsdom 下不稳定）——本文件不涉及
// Tier 0 义项渲染，直接替身掉。
vi.mock("@/frontend/components/ui/Markdown", () => ({
  Markdown: (props: { content: string }) => createElement("div", null, props.content),
}));

import { apiFetch } from "@/frontend/api/client";
import { ReviewCardView } from "@/frontend/components/review/ReviewCardView";
import type { ReviewCard } from "@/frontend/hooks/useReview";

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

function makeCard(overrides: Partial<ReviewCard> = {}): ReviewCard {
  return {
    progressId: "p1",
    word: {
      id: "word-1",
      slug: "comprehend",
      title: "comprehend",
      lemma: "comprehend",
      short_definition: "理解",
      ipa: null,
      pos: "v.",
      cefr: "CET6",
    },
    state: "new",
    dueAt: null,
    lastRating: null,
    reviewCount: 0,
    note_entries: [],
    ...overrides,
  };
}

async function renderCard(props: Partial<Parameters<typeof ReviewCardView>[0]> = {}): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(ReviewCardView, {
          card: makeCard(),
          loading: false,
          error: null,
          onAnswer: vi.fn(),
          onSkip: vi.fn(),
          ...props,
        }) as ReactElement,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  // 词条详情预取失败 → 优雅降级只显 Tier 0（不打断本文件的断言）。
  apiFetchMock.mockRejectedValue(new Error("offline"));
  addToastMock.mockReset();
});

describe("ReviewCardView upgrade badge (ADR-0018)", () => {
  it("renders the suggestion badge linking to /upgrade when a work order exists", async () => {
    const container = await renderCard({
      card: makeCard({ state: "review", reviewCount: 5 }),
      upgradeHint: { suggestion: "strong", workOrderId: "wo-1" },
    });

    await waitFor(() => expect(screen.getByText("强烈推荐升级")).toBeTruthy());
    const badge = container.querySelector("[data-testid='upgrade-badge']") as HTMLAnchorElement | null;
    expect(badge?.getAttribute("href")).toBe("/upgrade");
    // 有工单时不显示标记入口（工单已存在）。
    expect(container.querySelector("[data-testid='mark-upgrade']")).toBeNull();
  });

  it("shows the mark-upgrade entry in the first-learn window and calls the handler", async () => {
    const onMarkUpgrade = vi.fn(async () => {});
    const container = await renderCard({
      card: makeCard({ state: "new", reviewCount: 0 }),
      upgradeHint: null,
      onMarkUpgrade,
    });

    const button = await waitFor(() => {
      const found = container.querySelector("[data-testid='mark-upgrade']") as HTMLButtonElement | null;
      expect(found).toBeTruthy();
      return found as HTMLButtonElement;
    });

    await act(async () => {
      fireEvent.click(button);
    });

    expect(onMarkUpgrade).toHaveBeenCalledWith("word-1");
    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("success", expect.stringContaining("待升级清单")));
  });

  it("treats a just-reviewed card (reviewCount 1) as inside the first-learn window", async () => {
    const onMarkUpgrade = vi.fn(async () => {});
    const container = await renderCard({
      card: makeCard({ state: "learning", reviewCount: 1 }),
      upgradeHint: null,
      onMarkUpgrade,
    });

    await waitFor(() =>
      expect(container.querySelector("[data-testid='mark-upgrade']")).toBeTruthy(),
    );
  });

  it("hides the mark-upgrade entry outside the first-learn window", async () => {
    const container = await renderCard({
      card: makeCard({ state: "review", reviewCount: 5 }),
      upgradeHint: null,
      onMarkUpgrade: vi.fn(async () => {}),
    });

    // 等待一次渲染 tick，确认入口不存在。
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid='mark-upgrade']")).toBeNull();
    expect(container.querySelector("[data-testid='upgrade-badge']")).toBeNull();
  });

  it("hides both entries in preview mode", async () => {
    const container = await renderCard({
      card: makeCard({ state: "new", reviewCount: 0 }),
      preview: true,
      upgradeHint: { suggestion: "normal", workOrderId: "wo-1" },
      onMarkUpgrade: vi.fn(async () => {}),
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid='mark-upgrade']")).toBeNull();
    expect(container.querySelector("[data-testid='upgrade-badge']")).toBeNull();
  });

  it("surfaces a toast when marking fails", async () => {
    const onMarkUpgrade = vi.fn(async () => {
      throw new Error("boom");
    });
    const container = await renderCard({
      card: makeCard({ state: "new", reviewCount: 0 }),
      upgradeHint: null,
      onMarkUpgrade,
    });

    const button = await waitFor(() => {
      const found = container.querySelector("[data-testid='mark-upgrade']") as HTMLButtonElement | null;
      expect(found).toBeTruthy();
      return found as HTMLButtonElement;
    });
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() =>
      expect(addToastMock).toHaveBeenCalledWith("error", expect.stringContaining("标记失败")),
    );
  });
});
