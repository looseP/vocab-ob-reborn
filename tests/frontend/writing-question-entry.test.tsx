/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * I3 共享作文入口组件测试（B 批）——摘要驱动的状态机：
 * 尚未开始→开始（显式 createTask；单次意图 requestId 跨未知结果重试保持；点击防重）／
 * 有草稿→继续（按已知 ID 只读导航）／无草稿有已提交稿→查看本稿／
 * 多记录与仅归档→记录选择（不替用户挑第一条）／读取失败→重试；
 * URL 一律经 origin 契约构造（返回目标不丢来源）。
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/writingClient", () => ({
  writingClient: { createTask: vi.fn() },
}));

import { writingClient } from "@/frontend/api/writingClient";
import { WritingQuestionEntry } from "@/frontend/components/writing/WritingQuestionEntry";
import { parseWritingSearch, type WritingOrigin } from "@/frontend/viewModels/writingNavigation";

const Q = "00000000-0000-4000-8000-000000000101";
const TASK = "00000000-0000-4000-8000-000000000701";
const TASK2 = "00000000-0000-4000-8000-000000000702";
const SHEET = "00000000-0000-4000-8000-000000000801";
const SEALED = "00000000-0000-4000-8000-000000000803";
const FILE_KEY = "writing-short-1";

const ORIGIN: WritingOrigin = {
  v: 1, kind: "file", questionId: Q, questionType: "short_essay",
  fileKey: FILE_KEY, sourceId: null, sheetId: null,
};

function taskSummary(overrides: Record<string, unknown> = {}) {
  return {
    taskId: TASK, taskStatus: "active",
    draftSheetId: null, latestSubmittedSheetId: null,
    latestRevisionNo: null, revisionCount: 0,
    feedbackState: null, contentStatus: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const client = writingClient as unknown as { createTask: ReturnType<typeof vi.fn> };
const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const navigations: string[] = [];

async function renderEntry(overrides: Record<string, unknown> = {}): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(createElement(WritingQuestionEntry, {
      questionId: Q,
      kind: "whole",
      direction: "通用",
      origin: ORIGIN,
      tasks: [],
      state: "ready",
      onRetry: vi.fn(),
      onNavigate: (url: string) => { navigations.push(url); },
      ...overrides,
    } as never));
    await Promise.resolve();
  });
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function lastNavigation(): URLSearchParams {
  expect(navigations.length).toBeGreaterThan(0);
  return new URLSearchParams(navigations.at(-1)!.split("?")[1]!);
}

afterEach(() => {
  act(() => { for (const root of mountedRoots.splice(0)) root.unmount(); });
  document.body.innerHTML = "";
});

beforeEach(() => {
  client.createTask.mockReset();
  navigations.length = 0;
});

describe("WritingQuestionEntry（I3 共享入口状态机）", () => {
  it("尚未开始：显示开始写作；点击显式 createTask（questionId/kind/direction/requestId）并带 origin 导航", async () => {
    client.createTask.mockResolvedValue({ task: { id: TASK }, draft: { id: SHEET }, created: true });
    await renderEntry();

    expect(screen.getByText(/专项写作/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    await waitFor(() => expect(navigations.length).toBe(1));

    expect(client.createTask).toHaveBeenCalledWith(expect.objectContaining({
      requestId: expect.any(String), kind: "whole", direction: "通用", questionId: Q,
    }));
    const search = lastNavigation();
    expect(search.get("section")).toBe("writing");
    expect(search.get("writingTaskId")).toBe(TASK);
    expect(search.get("sheet")).toBe(SHEET);
    const origin = parseWritingSearch(search).origin;
    expect(origin).toMatchObject({
      kind: "file", questionId: Q, questionType: "short_essay", fileKey: FILE_KEY,
    });
  });

  it("有草稿：继续写作——按已知 ID 只读导航（不调用 createTask）", async () => {
    await renderEntry({ tasks: [taskSummary({ draftSheetId: SHEET })] });
    expect(screen.getByText(/草稿未提交/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "继续写作" }));
    expect(client.createTask).not.toHaveBeenCalled();
    const search = lastNavigation();
    expect(search.get("writingTaskId")).toBe(TASK);
    expect(search.get("sheet")).toBe(SHEET);
    expect(parseWritingSearch(search).origin?.questionId).toBe(Q);
  });

  it("无草稿有已提交稿：查看本稿 → 精确 sealed sheetId；待反馈/已有反馈文案", async () => {
    await renderEntry({
      tasks: [taskSummary({
        latestSubmittedSheetId: SEALED, latestRevisionNo: 1, revisionCount: 1,
        feedbackState: "pending", contentStatus: "available",
      })],
    });
    expect(screen.getByText(/已提交 1 稿/)).toBeTruthy();
    expect(screen.getByText(/待反馈/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看本稿" }));
    expect(client.createTask).not.toHaveBeenCalled();
    expect(lastNavigation().get("sheet")).toBe(SEALED);
  });

  it("已提交稿有反馈：文案显示已有反馈", async () => {
    await renderEntry({
      tasks: [taskSummary({
        latestSubmittedSheetId: SEALED, latestRevisionNo: 2, revisionCount: 2,
        feedbackState: "ready", contentStatus: "available",
      })],
    });
    expect(screen.getByText(/已有反馈/)).toBeTruthy();
  });

  it("多活跃记录：记录选择（不替用户挑第一条），点哪条去哪条", async () => {
    await renderEntry({
      tasks: [
        taskSummary({ taskId: TASK, draftSheetId: SHEET }),
        taskSummary({
          taskId: TASK2, latestSubmittedSheetId: SEALED,
          latestRevisionNo: 1, revisionCount: 1, feedbackState: "ready", contentStatus: "available",
        }),
      ],
    });

    // 两条记录都在，各自给动作按钮；不自动替用户进入任何一条。
    expect(navigations).toHaveLength(0);
    expect(screen.getByRole("button", { name: "继续写作" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看本稿" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看本稿" }));
    const search = lastNavigation();
    expect(search.get("writingTaskId")).toBe(TASK2);
    expect(search.get("sheet")).toBe(SEALED);
  });

  it("仅归档：记录选择展示归档记录，并可显式开始新写作", async () => {
    client.createTask.mockResolvedValue({ task: { id: TASK2 }, draft: null, created: true });
    await renderEntry({ tasks: [taskSummary({ taskStatus: "archived", draftSheetId: SHEET })] });

    expect(screen.getByText(/已归档/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "继续写作" }));
    expect(lastNavigation().get("writingTaskId")).toBe(TASK);

    // 归档之外仍可显式开始新写作（创建新任务；不因打开而自动创建）。
    expect(client.createTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "开始新写作" }));
    await waitFor(() => expect(client.createTask).toHaveBeenCalledTimes(1));
    expect(lastNavigation().get("writingTaskId")).toBe(TASK2);
  });

  it("读取失败：重试按钮触发 onRetry（不隐藏入口）", async () => {
    const onRetry = vi.fn();
    await renderEntry({ state: "error", onRetry });
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("点击防重：创建在途重复点击只发一次 createTask", async () => {
    const pending = deferred<unknown>();
    client.createTask.mockReturnValueOnce(pending.promise);
    await renderEntry();

    const button = screen.getByRole("button", { name: "开始写作" });
    fireEvent.click(button);
    fireEvent.click(button);
    await flushAsync();
    expect(client.createTask).toHaveBeenCalledTimes(1);

    // 结果未知（失败）：正文入口保留，重试沿用同一 requestId（单次意图）。
    const firstRequestId = client.createTask.mock.calls[0]![0].requestId as string;
    pending.reject(new Error("network"));
    await flushAsync();
    expect(screen.getByText(/进入失败/)).toBeTruthy();

    client.createTask.mockResolvedValueOnce({ task: { id: TASK }, draft: null, created: true });
    fireEvent.click(screen.getByRole("button", { name: /重试进入写作/ }));
    await waitFor(() => expect(navigations.length).toBe(1));
    expect(client.createTask).toHaveBeenCalledTimes(2);
    expect(client.createTask.mock.calls[1]![0].requestId).toBe(firstRequestId);
    expect(lastNavigation().get("writingTaskId")).toBe(TASK);
    expect(lastNavigation().get("sheet")).toBeNull(); // 无草稿不伪造 sheet
  });
});

describe("WritingQuestionEntry · 跳转前屏障（原卷语义）", () => {
  it("屏障拒绝：开始不创建不导航（留页、按钮恢复）；继续同样留页", async () => {
    const deny = vi.fn(async () => false);
    client.createTask.mockResolvedValue({ task: { id: TASK }, draft: null, created: true });
    await renderEntry({ beforeAction: deny });

    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    await flushAsync();
    expect(deny).toHaveBeenCalledTimes(1);
    expect(client.createTask).not.toHaveBeenCalled(); // 不悄悄创建任务
    expect(navigations).toHaveLength(0);
    expect(screen.getByRole("button", { name: "开始写作" })).toBeTruthy(); // 留页可重试（非错误态）

    // 继续（只读导航）同样受屏障约束：拒绝即留页
    act(() => { for (const root of mountedRoots.splice(0)) root.unmount(); });
    document.body.innerHTML = "";
    const deny2 = vi.fn(async () => false);
    await renderEntry({ tasks: [taskSummary({ draftSheetId: SHEET })], beforeAction: deny2 });
    fireEvent.click(screen.getByRole("button", { name: "继续写作" }));
    await flushAsync();
    expect(deny2).toHaveBeenCalledTimes(1);
    expect(navigations).toHaveLength(0);
  });

  it("慢屏障：放行前零创建零导航；在途重复点击防重（单次）；放行后恰一次导航与创建", async () => {
    const gate = deferred<boolean>();
    const beforeAction = vi.fn(() => gate.promise);
    client.createTask.mockResolvedValue({ task: { id: TASK }, draft: { id: SHEET }, created: true });
    await renderEntry({ beforeAction });

    const button = screen.getByRole("button", { name: "开始写作" });
    fireEvent.click(button);
    fireEvent.click(button);
    await flushAsync();
    expect(beforeAction).toHaveBeenCalledTimes(1); // 防重：屏障只跑一次
    expect(client.createTask).not.toHaveBeenCalled(); // 屏障未放行 → 不创建
    expect(navigations).toHaveLength(0);

    gate.resolve(true);
    await waitFor(() => expect(navigations.length).toBe(1));
    expect(client.createTask).toHaveBeenCalledTimes(1);
    expect(lastNavigation().get("writingTaskId")).toBe(TASK);
    expect(lastNavigation().get("sheet")).toBe(SHEET);
  });
});
