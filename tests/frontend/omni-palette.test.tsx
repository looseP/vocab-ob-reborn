/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * 命令面板（2026-09-26 升级）+ 文件顺序条。
 *
 * 面板的关键性质：它必须是**完整地图**（空查询即列出全部入口，按族分组），
 * 而不是一个只能搜单词的搜索框 —— 否则"从键盘直达某个做题面"依然做不到。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmniPalette } from "@/frontend/components/search/OmniPalette";
import { NAVIGATION } from "@/frontend/viewModels/navigationRegistry";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];
let navigated: string[] = [];

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

async function mountPalette(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(OmniPalette, null) as ReactElement,
        createElement(LocationProbe, null),
      ),
    );
    await Promise.resolve();
  });
}

function openPalette(): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  });
}

function type(text: string): void {
  act(() => {
    fireEvent.change(screen.getByLabelText("命令面板"), { target: { value: text } });
  });
}

afterEach(() => {
  act(() => {
    for (const { root } of mountedRoots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  navigated = [];
});

beforeEach(() => {
  vi.restoreAllMocks();
  // 词搜索走网络，面板测试里不需要（也不该真发请求）
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
    status: 200, headers: { "content-type": "application/json" },
  })));
});

describe("命令面板 · 完整地图", () => {
  it("⌘K 打开；关闭后卸载", async () => {
    await mountPalette();
    expect(screen.queryByLabelText("命令面板")).toBeNull();
    openPalette();
    expect(screen.getByLabelText("命令面板")).toBeTruthy();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(screen.queryByLabelText("命令面板")).toBeNull();
  });

  it("空查询即列出**全部**登记入口（面板即地图，不需先知道叫什么）", async () => {
    await mountPalette();
    openPalette();
    const commands = screen.getAllByTestId("palette-command");
    expect(commands).toHaveLength(NAVIGATION.length);
  });

  it("按族分组渲染（做题族排最前）", async () => {
    await mountPalette();
    openPalette();
    const labels = screen.getAllByText(/^(做题|复习|词汇|素材|系统)$/).map((n) => n.textContent);
    expect(labels[0]).toBe("做题");
    expect(new Set(labels)).toEqual(new Set(["做题", "复习", "词汇", "素材", "系统"]));
  });

  it("做题面在面板里可直达：做题 / 错题库 / 练习 / 会话 / 作文 / 学习笔记", async () => {
    await mountPalette();
    openPalette();
    for (const label of ["做题", "错题库", "练习", "会话", "作文", "学习笔记"]) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
  });

  it("Enter 直达：走到目标命令并回车 → 地址变为该入口的规范 URL", async () => {
    await mountPalette();
    openPalette();
    type("错题库");
    await waitFor(() => expect(screen.getByTestId("palette-command")).toBeTruthy());
    act(() => {
      fireEvent.keyDown(screen.getByLabelText("命令面板"), { key: "Enter" });
    });
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/l3?section=error-book"));
    // 面板在跳转后关闭
    expect(screen.queryByLabelText("命令面板")).toBeNull();
  });

  it("点击命令同样直达", async () => {
    await mountPalette();
    openPalette();
    type("素材宇宙");
    await waitFor(() => expect(screen.getByTestId("palette-command")).toBeTruthy());
    act(() => {
      fireEvent.click(screen.getByTestId("palette-command"));
    });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/l3?section=home"));
  });

  it("输入过滤：只留命中的命令", async () => {
    await mountPalette();
    openPalette();
    type("作文");
    await waitFor(() => expect(screen.getAllByTestId("palette-command").length).toBeGreaterThan(0));
    const texts = screen.getAllByTestId("palette-command").map((n) => n.textContent ?? "");
    expect(texts.filter((t) => t.includes("作文")).length).toBeGreaterThanOrEqual(1);
    // 非命中项（复习 / 词条库 / 仪表盘…）不得残留
    for (const noise of ["间隔重复训练", "浏览和管理词汇", "学习进度和统计"]) {
      expect(texts.some((t) => t.includes(noise)), noise).toBe(false);
    }
  });

  it("按族名也能命中（做题 / 素材 / 系统）", async () => {
    await mountPalette();
    openPalette();
    type("系统");
    await waitFor(() => expect(screen.getAllByTestId("palette-command").length).toBeGreaterThan(0));
    const texts = screen.getAllByTestId("palette-command").map((n) => n.textContent ?? "");
    expect(texts.every((t) => t.includes("偏好") || t.includes("批量导入") || t.includes("设置"))).toBe(true);
  });

  it("无命中时给出明确空态（不静默）", async () => {
    await mountPalette();
    openPalette();
    type("zzzz-不存在");
    await waitFor(() => expect(screen.getByText(/没有匹配/)).toBeTruthy());
  });

  it("↑↓ 不会停在分组标题上（只走真实条目）", async () => {
    await mountPalette();
    openPalette();
    type("错题库");
    await waitFor(() => expect(screen.getAllByTestId("palette-command")).toHaveLength(1));
    act(() => {
      fireEvent.keyDown(screen.getByLabelText("命令面板"), { key: "ArrowDown" });
    });
    // 仍是同一条（唯一可选行），Enter 仍能直达 —— 没有落到"做题"组标题
    act(() => {
      fireEvent.keyDown(screen.getByLabelText("命令面板"), { key: "Enter" });
    });
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/l3?section=error-book"));
  });
});
