/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3Shell } from "@/frontend/components/L3Shell";

/**
 * 侧栏收折（专注做题态）。
 *
 * 断言的重点不是「点了按钮样式变了」，而是三条行为契约：
 * 1. 收起后**导航仍然可达**（mini rail 是入口，不是装饰）；
 * 2. 快捷键与按钮是同一个动作，且在输入控件里不抢键（Ctrl+B 在 input 里有自己的语义）；
 * 3. 偏好落 localStorage —— 做题是几十分钟的连续会话，刷新不该把目录弹回来。
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

describe("L3Shell 侧栏收折", () => {
  it("默认展开：显示文字导航与工程工具，收起按钮 aria-expanded=true", async () => {
    await mount();
    expect(shell().classList.contains("sidebar-collapsed")).toBe(false);
    expect(screen.getByRole("button", { name: "试卷台" })).toBeTruthy();
    expect(screen.getByText("工程工具")).toBeTruthy();
    expect(screen.getByTestId("l3-sidebar-toggle").getAttribute("aria-expanded")).toBe("true");
  });

  it("收起后换 mini rail：导航仍可达，且能照常切面", async () => {
    const onNavigate = await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId("l3-sidebar-toggle"));
      await Promise.resolve();
    });
    expect(shell().classList.contains("sidebar-collapsed")).toBe(true);
    expect(screen.getByTestId("l3-sidebar-toggle").getAttribute("aria-expanded")).toBe("false");
    // 文字导航收起 —— 但入口必须还在（收起不等于导航消失）
    expect(document.querySelector(".l3-nav:not(.l3-sidebar-rail)")).toBeNull();
    const rail = document.querySelector<HTMLElement>(".l3-sidebar-rail");
    expect(rail).not.toBeNull();
    expect(rail!.querySelectorAll(".l3-rail-btn")).toHaveLength(9);
    const activeRail = rail!.querySelector<HTMLElement>(".l3-rail-btn.active")!;
    expect(activeRail.getAttribute("aria-label")).toBe("试卷台");
    await act(async () => {
      fireEvent.click(activeRail);
      await Promise.resolve();
    });
    expect(onNavigate).toHaveBeenCalledWith("papers");
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
  });
});
