/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * L3 回程条（FR-12 接线1 回程，2026-10-04）。
 *
 * 覆盖真实使用路径：从复习卡语境深链进入 `/l3` 时，页面上必须出现一条能回到
 * **原复习会话**的出口；普通进入 `/l3`（无标记）不得出现这条出口。
 *
 * 这里挂的是**真 L3Page**（沿用 tests/frontend/writing-workspace.test.tsx 的
 * renderAt 手法），因为要钉的正是"页面级接线"：判定对了但没渲染，等于没做。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/frontend/api/client";
import { L3Page } from "@/frontend/pages/L3Page";

/** 当前位置探针：同时验证"去了哪"和"带了什么 state"。 */
function LocationProbe() {
  const location = useLocation();
  return createElement(
    "span",
    { "data-testid": "loc" },
    `${location.pathname}|${JSON.stringify(location.state ?? null)}`,
  );
}

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function renderL3Page(entry: string | { pathname: string; state?: unknown }): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [entry] },
        createElement(LocationProbe),
        createElement(L3Page) as ReactElement,
      ),
    );
    await Promise.resolve();
  });
}

beforeEach(() => {
  (apiFetch as ReturnType<typeof vi.fn>).mockReset();
  // 首屏（home）请求一律失败即可：home 以失败态渲染，不影响回程条的断言。
  (apiFetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("unmocked"));
});

afterEach(() => {
  act(() => {
    for (const { root } of mounted.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("L3 回程条", () => {
  it("带 state.fromReview 进入 → 显示出口与说明", async () => {
    await renderL3Page({ pathname: "/l3", state: { fromReview: true } });
    const bar = screen.getByTestId("l3-back-to-review");
    expect(bar.textContent).toContain("← 返回复习");
    expect(bar.textContent).toContain("原卡位置会复原");
  });

  it("普通进入（无标记）→ 不显示出口", async () => {
    await renderL3Page("/l3");
    expect(screen.queryByTestId("l3-back-to-review")).toBeNull();
  });

  it("标记非严格 true（如 'yes'）→ 不显示出口（不因「有个键」就放行）", async () => {
    await renderL3Page({ pathname: "/l3", state: { fromReview: "yes" } });
    expect(screen.queryByTestId("l3-back-to-review")).toBeNull();
  });

  it("点击出口 → 回 /review 并继续携带回程标记（复习页据此自动续接原会话）", async () => {
    await renderL3Page({ pathname: "/l3", state: { fromReview: true } });
    await act(async () => {
      fireEvent.click(screen.getByText("← 返回复习"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("loc").textContent).toBe('/review|{"fromReview":true}');
  });
});
