/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3Shell } from "@/frontend/components/L3Shell";

/**
 * 侧栏上下折叠（专注做题态，2026-10-02）。
 *
 * 断言的重点不是「点了按钮样式变了」，而是核心行为契约：
 * 1. 上下折叠：非当前入口垂直折叠隐藏，当前活动面（试卷台）依然可见，
 *    侧栏宽度保持 200px 稳定卡片，下方留出选区停靠区；
 * 2. 入口始终可达：折叠态下可点击活动面切面，或通过「展开全部目录」一键展开；
 * 3. 快捷键与按钮是同一个动作，且在输入控件里不抢键（Ctrl+B 在 input 里有自己的语义）；
 * 4. 偏好落 localStorage —— 做题是几十分钟的连续会话，刷新不该把目录弹回来。
 */
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Root[] = [];

async function mount(onNavigate = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () => {
    root.render(createElement(L3Shell, {
      activeSection: "papers",
      onNavigate,
      children: createElement("p", null, "卷面内容"),
    }) as ReactElement);
    await Promise.resolve();
  });
  return onNavigate;
}

function shell(): HTMLElement {
  return document.querySelector<HTMLElement>(".l3-shell")!;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("L3Shell 侧栏上下折叠（2026-10-02）", () => {
  it("默认展开：显示文字导航与工程工具，收起按钮 aria-expanded=true 且为 ▴", async () => {
    await mount();
    expect(shell().classList.contains("sidebar-collapsed")).toBe(false);
    expect(screen.getByRole("button", { name: "试卷台" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "空间首页" })).toBeTruthy();
    expect(screen.getByText("工程工具")).toBeTruthy();
    const toggle = screen.getByTestId("l3-sidebar-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("▴");
  });

  it("上下折叠：折叠后隐藏非当前入口并保留当前活动面，可照常切面与展开", async () => {
    const onNavigate = await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId("l3-sidebar-toggle"));
      await Promise.resolve();
    });
    expect(shell().classList.contains("sidebar-collapsed")).toBe(true);
    const toggle = screen.getByTestId("l3-sidebar-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("▾");

    // 上下折叠：非当前入口（如空间首页、工程工具）折叠隐藏，当前活动面（试卷台）依然可见
    expect(screen.getByRole("button", { name: "试卷台" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "空间首页" })).toBeNull();
    expect(screen.queryByText("工程工具")).toBeNull();
    const unfoldBtn = screen.getByRole("button", { name: "展开全部目录" });
    expect(unfoldBtn).toBeTruthy();

    // 点击当前活动面依然触发 onNavigate
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "试卷台" }));
      await Promise.resolve();
    });
    expect(onNavigate).toHaveBeenCalledWith("papers");

    // 点击展开按钮恢复完整目录
    await act(async () => {
      fireEvent.click(unfoldBtn);
      await Promise.resolve();
    });
    expect(shell().classList.contains("sidebar-collapsed")).toBe(false);
    expect(screen.getByRole("button", { name: "空间首页" })).toBeTruthy();
    expect(screen.getByText("工程工具")).toBeTruthy();
    expect(screen.getByTestId("l3-sidebar-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("l3-sidebar-toggle").textContent).toBe("▴");
  });

  it("Ctrl+B 与按钮同一动作；输入控件内不抢键", async () => {
    await mount();
    await act(async () => {
      fireEvent.keyDown(document, { key: "b", ctrlKey: true });
      await Promise.resolve();
    });
    expect(shell().classList.contains("sidebar-collapsed")).toBe(true);

    // 焦点在 input 内：Ctrl+B 交还给浏览器（不切收折态）
    const input = document.createElement("input");
    document.body.appendChild(input);
    await act(async () => {
      fireEvent.keyDown(input, { key: "b", ctrlKey: true });
      await Promise.resolve();
    });
    expect(shell().classList.contains("sidebar-collapsed")).toBe(true);

    // ⌘+B（macOS）同样生效
    await act(async () => {
      fireEvent.keyDown(document, { key: "b", metaKey: true });
      await Promise.resolve();
    });
    expect(shell().classList.contains("sidebar-collapsed")).toBe(false);
  });

  it("收折偏好持久化：重挂载后保持收起", async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId("l3-sidebar-toggle"));
      await Promise.resolve();
    });
    expect(localStorage.getItem("vocab-l3-sidebar-collapsed")).toBe("1");

    act(() => { for (const root of mounted.splice(0)) root.unmount(); });
    document.body.innerHTML = "";

    await mount();
    expect(shell().classList.contains("sidebar-collapsed")).toBe(true);
    expect(screen.getByRole("button", { name: "试卷台" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "空间首页" })).toBeNull();
  });
});
