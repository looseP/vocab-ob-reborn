/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 笔记条目共享 UI（ux-notes-redesign，2026-10-10）：
 *  - NoteEntryContent：F1 Markdown + 单换行（breaks）；F3 kind chip 内联首段
 *    （内置彩色 / 自定义中性灰 / general 不显示）；渲染失败降级纯文本。
 *  - NoteKindChips：内置点选；「＋新类型」1..16 字 Enter 确认 → localStorage
 *    持久 + onChange；重名拒绝；上限 12。
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({
  useToast: () => ({ addToast: addToastMock }),
}));

import { NoteEntryContent, NoteKindChips } from "@/frontend/components/notes/noteEntryUi";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => {
  localStorage.clear();
  addToastMock.mockClear();
});

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) mounted.root.unmount();
  });
  document.body.innerHTML = "";
});

function mount(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mountedRoots.push({ root, container });
  return container;
}

describe("NoteEntryContent（F1 渲染 + F3 chip）", () => {
  it("Markdown + 单换行：**加粗** 生效、裸换行成 <br>；story chip 内联首段", async () => {
    const container = mount(
      createElement(NoteEntryContent, {
        content: "parade 游行 → ap-para-tus\n想象一支**游行队伍**",
        kind: "story",
      }),
    );
    await waitFor(() => {
      expect(container.querySelector("strong")?.textContent).toBe("游行队伍");
    });
    expect(container.textContent).toContain("故事会");
    expect(container.querySelector("br")).not.toBeNull();
    // chip 在首个段落内（内联首行），不是独立块
    const firstP = container.querySelector("p")!;
    expect(firstP.textContent).toContain("故事会");
    expect(firstP.querySelector("strong")?.textContent).toBe("游行队伍");
  });

  it("general 不显示 chip；自定义 kind 以原文+中性灰 chip 呈现", async () => {
    const general = mount(createElement(NoteEntryContent, { content: "一条笔记记一个点", kind: "general" }));
    await waitFor(() => {
      expect(general.textContent).toContain("一条笔记记一个点");
    });
    expect(general.textContent).not.toContain("普通");

    const custom = mount(createElement(NoteEntryContent, { content: "三单不可数", kind: "易错点" }));
    await waitFor(() => {
      expect(custom.textContent).toContain("易错点");
    });
    expect(custom.textContent).toContain("三单不可数");
  });
});

describe("NoteKindChips（F3 选择器）", () => {
  it("内置点选回调 + 新类型 Enter 确认（localStorage 持久 + onChange）", async () => {
    const onChange = vi.fn();
    const container = mount(createElement(NoteKindChips, { value: "general", onChange }));

    act(() => {
      fireEvent.click(
        Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "故事会")!,
      );
    });
    expect(onChange).toHaveBeenCalledWith("story");

    act(() => {
      fireEvent.click(
        Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("新类型"))!,
      );
    });
    const input = container.querySelector("input")!;
    act(() => {
      fireEvent.change(input, { target: { value: "易错点" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onChange).toHaveBeenCalledWith("易错点");
    expect(JSON.parse(localStorage.getItem("note-entry-kinds-v1")!)).toEqual(["易错点"]);
  });

  it("重名拒绝（内置标签/已有自定义），不回调", async () => {
    const onChange = vi.fn();
    const container = mount(createElement(NoteKindChips, { value: "general", onChange }));

    act(() => {
      fireEvent.click(
        Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("新类型"))!,
      );
    });
    const input = container.querySelector("input")!;
    act(() => {
      fireEvent.change(input, { target: { value: "故事会" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(addToastMock).toHaveBeenCalledWith("info", expect.stringContaining("重名"));
  });
});
