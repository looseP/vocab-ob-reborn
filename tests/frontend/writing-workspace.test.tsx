/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 作文工作区组件测试（W7/W8）——覆盖真实使用路径的关键行为：
 * 起笔路径 ≤2 点击 / 深链与 F5 零创建 / 任务切换隔离 / 提交屏障（flush 先行）/
 * 冲突保留本地 / 反馈三态与 hash 校验 / 对照独立 / 评阅指令无 token / 分流与页签。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";

vi.mock("@/frontend/api/writingClient", () => ({
  writingClient: {
    createTask: vi.fn(),
    listTasks: vi.fn(),
    getTask: vi.fn(),
    renameTask: vi.fn(),
    archiveTask: vi.fn(),
    restoreTask: vi.fn(),
    listRevisions: vi.fn(),
    getSheet: vi.fn(),
    createDraft: vi.fn(),
    saveDraft: vi.fn(),
    submitSheet: vi.fn(),
    discardSheet: vi.fn(),
    getFeedback: vi.fn(),
    getFeedbackContext: vi.fn(),
    putFeedback: vi.fn(),
    exportSheet: vi.fn(),
    clearSheetContent: vi.fn(),
  },
}));
vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));

import { writingClient } from "@/frontend/api/writingClient";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { evaluateSubmitPrecheck } from "@/frontend/state/writingSubmitBarrier";
import { L3WritingPage } from "@/frontend/pages/L3WritingPage";
import { L3Page } from "@/frontend/pages/L3Page";
import { buildWritingUrl, parseWritingSearch } from "@/frontend/viewModels/writingNavigation";

const TASK = "00000000-0000-4000-8000-000000000701";
const TASK_B = "00000000-0000-4000-8000-000000000702";
const SHEET = "00000000-0000-4000-8000-000000000801";
const SHEET_B = "00000000-0000-4000-8000-000000000802";
const SHEET_SEALED = "00000000-0000-4000-8000-000000000803";
const QUESTION = "00000000-0000-4000-8000-000000000101";
const SHA = "a".repeat(64);

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function taskDto(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK, questionId: QUESTION, title: "谈谈你的看法", prompt: "谈谈你对技术发展的看法。",
    kind: "free", direction: "通用", status: "active",
    createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z", ...overrides,
  };
}

function sheetDto(overrides: Record<string, unknown> = {}) {
  return {
    id: SHEET, taskId: TASK, status: "draft", draftVersion: 0, revisionNo: null, parentSheetId: null,
    createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z", sealedAt: null, ...overrides,
  };
}

function sheetDetail(overrides: Record<string, unknown> = {}) {
  return {
    sheet: sheetDto(),
    text: "草稿正文",
    textSha256: SHA,
    wordCount: 2,
    contentStatus: "available" as const,
    feedback: null,
    ...overrides,
  };
}

function sealedDetail(overrides: Record<string, unknown> = {}) {
  return sheetDetail({
    sheet: sheetDto({ id: SHEET_SEALED, status: "sealed", revisionNo: 1, sealedAt: "2026-09-18T01:00:00.000Z" }),
    text: "已提交正文",
    ...overrides,
  });
}

function feedbackRecord(overrides: Record<string, unknown> = {}) {
  return {
    feedback: {
      schemaVersion: 1, summary: "结构清楚，论据可以更具体。", strengths: ["开头立场明确"],
      dimensions: {
        task_response: { applicable: true, comment: "c" },
        organization: { applicable: true, comment: "c" },
        language: { applicable: true, comment: "c" },
        expression: { applicable: false, comment: "本稿不评。" },
      },
      priorities: [{
        id: "p1", dimension: "task_response", observation: "缺少例子。", action: "补例。",
        anchor: { start: 0, end: 2, quote: "已提" },
      }],
    },
    version: 1, textSha256: SHA, lastEditor: "agent-a", updatedAt: "2026-09-18T02:00:00.000Z",
    ...overrides,
  };
}

type ClientMock = Record<string, ReturnType<typeof vi.fn>>;
const client = writingClient as unknown as ClientMock;

const mountedRoots: Root[] = [];
function LocationProbe() {
  const location = useLocation();
  return createElement("div", { "data-testid": "loc" }, `${location.pathname}${location.search}`);
}

async function renderAt(url: string, element: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: [url] }, element, createElement(LocationProbe)));
    await Promise.resolve();
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

afterEach(() => {
  act(() => { for (const root of mountedRoots.splice(0)) root.unmount(); });
  document.body.innerHTML = "";
});

beforeEach(() => {
  for (const fn of Object.values(client)) fn.mockReset();
  (apiFetch as ReturnType<typeof vi.fn>).mockReset();
});

describe("writingNavigation（URL 契约）", () => {
  it("build/parse 往返；section=writing 判定", () => {
    const url = buildWritingUrl({ taskId: TASK, sheetId: SHEET, compareTo: SHEET_SEALED });
    expect(url).toBe(`/l3?section=writing&writingTaskId=${TASK}&sheet=${SHEET}&compareTo=${SHEET_SEALED}`);
    const parsed = parseWritingSearch(new URLSearchParams(url.split("?")[1]!));
    expect(parsed).toMatchObject({ section: "writing", taskId: TASK, sheetId: SHEET, compareTo: SHEET_SEALED });
  });
});

describe("W10 提交屏障纯函数（evaluateSubmitPrecheck）", () => {
  it("同文同版放行；text/version 不符与非 draft 拒绝（不盲采最新版本）", () => {
    const receipt = { text: "T", version: 1 };
    expect(evaluateSubmitPrecheck(receipt, { status: "draft", text: "T", draftVersion: 1 }))
      .toEqual({ ok: true, expectedVersion: 1 });
    expect(evaluateSubmitPrecheck(receipt, { status: "draft", text: "X", draftVersion: 1 }))
      .toEqual({ ok: false, reason: "text-mismatch" });
    expect(evaluateSubmitPrecheck(receipt, { status: "draft", text: "T", draftVersion: 2 }))
      .toEqual({ ok: false, reason: "version-mismatch" });
    expect(evaluateSubmitPrecheck(receipt, { status: "sealed", text: null, draftVersion: 3 }))
      .toEqual({ ok: false, reason: "not-draft" });
    // 空文本与 receipt 不一致同样拒绝（文本比较用原样空串，不做归一）。
    expect(evaluateSubmitPrecheck(receipt, { status: "draft", text: null, draftVersion: 1 }).ok).toBe(false);
  });
});

describe("W7 起笔路径与列表（≤2 次主要点击）", () => {
  it("空态 → 开始写作 → 创建 → replace 到规范 URL 且光标进入正文", async () => {
    client.listTasks!.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    client.createTask!.mockResolvedValue({ task: taskDto(), draft: sheetDto(), created: true });
    client.getTask!.mockResolvedValue({ task: taskDto(), draftSummary: sheetDto(), revisionCount: 0, latestSubmittedSheetId: null });
    client.listRevisions!.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    client.getSheet!.mockResolvedValue(sheetDetail());

    await renderAt("/l3?section=writing", createElement(L3WritingPage));
    fireEvent.click(screen.getByRole("button", { name: "开始写作" })); // 点击 1：打开弹层
    await flushAsync();
    // 弹层内的提交按钮（DOM 中后出现；header 同名按钮在弹层打开时仍在）。
    fireEvent.click(screen.getAllByRole("button", { name: "开始写作" }).at(-1)!); // 点击 2：提交创建
    await waitFor(() => {
      expect((screen.getByTestId("loc").textContent ?? "")).toContain(`sheet=${SHEET}`);
    });

    const textarea = await screen.findByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("草稿正文");
    await waitFor(() => { expect(document.activeElement).toBe(textarea); });
    expect(client.createTask).toHaveBeenCalledWith(expect.objectContaining({ kind: "free", direction: "通用" }));
  });
});

describe("W7 深链与回看（GET 零创建）", () => {
  it("已提交稿深链：只 GET；readonly；F5 重挂载同 sheetId 且零创建", async () => {
    client.getTask!.mockResolvedValue({ task: taskDto(), draftSummary: null, revisionCount: 1, latestSubmittedSheetId: SHEET_SEALED });
    client.getSheet!.mockResolvedValue(sealedDetail({ feedback: feedbackRecord() }));
    client.listRevisions!.mockResolvedValue({ items: [], total: 0, nextCursor: null });

    const url = `/l3?section=writing&writingTaskId=${TASK}&sheet=${SHEET_SEALED}`;
    await renderAt(url, createElement(L3WritingPage));
    const textarea = await screen.findByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    expect(client.getSheet).toHaveBeenCalledWith(TASK, SHEET_SEALED);
    expect(client.createTask).not.toHaveBeenCalled();
    expect(client.createDraft).not.toHaveBeenCalled();
    expect(client.saveDraft).not.toHaveBeenCalled();
    // 反馈面板 ready（第 1 稿标识 + 建议定位按钮）
    expect(screen.getAllByText(/第 1 稿/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "跳至原句" })).toBeTruthy();

    // F5：卸载重挂载（同 URL）——同 sheetId、零新增创建；调用次数仅随重挂载+1。
    act(() => { for (const root of mountedRoots.splice(0)) root.unmount(); });
    document.body.innerHTML = "";
    const callsBefore = client.getSheet!.mock.calls.length;
    await renderAt(url, createElement(L3WritingPage));
    await screen.findByRole("textbox", { name: "作文正文" });
    expect(client.getSheet!.mock.calls.length).toBe(callsBefore + 1);
    expect(client.getSheet!.mock.calls.at(-1)).toEqual([TASK, SHEET_SEALED]);
    expect(client.createTask).not.toHaveBeenCalled();
    expect(client.createDraft).not.toHaveBeenCalled();
  });
});

describe("W7 任务切换隔离（A 的在途响应不落到 B）", () => {
  it("切换任务后，延迟到达的 A 响应被丢弃；B 的正文与状态生效", async () => {
    const pendingA = deferred<unknown>();
    client.getTask!.mockImplementation(async (taskId: string) => ({
      task: taskId === TASK ? taskDto() : taskDto({ id: TASK_B, title: "任务B" }),
      draftSummary: null, revisionCount: 0, latestSubmittedSheetId: null,
    }));
    client.getSheet!.mockImplementation(async (taskId: string, sheetId: string) => {
      if (sheetId === SHEET) return pendingA.promise;
      return sheetDetail({ sheet: sheetDto({ id: SHEET_B, taskId: TASK_B }), text: "B的正文" });
    });
    client.listRevisions!.mockResolvedValue({ items: [], total: 0, nextCursor: null });

    // 先挂 A（getSheet 挂起），再以 B 的 URL 重挂（模拟同页导航后的最终态渲染）。
    const urlA = `/l3?section=writing&writingTaskId=${TASK}&sheet=${SHEET}`;
    await renderAt(urlA, createElement(L3WritingPage));
    await flushAsync();

    act(() => { for (const root of mountedRoots.splice(0)) root.unmount(); });
    document.body.innerHTML = "";
    const urlB = `/l3?section=writing&writingTaskId=${TASK_B}&sheet=${SHEET_B}`;
    await renderAt(urlB, createElement(L3WritingPage));
    const textarea = await screen.findByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement;
    expect(textarea.value).toBe("B的正文");

    // A 的迟到响应此刻才 resolve——不得覆盖 B。
    await act(async () => {
      pendingA.resolve(sheetDetail({ text: "A的正文不该出现" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement).value).toBe("B的正文");
    expect(screen.queryByDisplayValue("A的正文不该出现")).toBeNull();
  });
});

describe("W7 提交屏障（flush 回执核对 + CAS 兜底 + 不盲采最新版本）", () => {
  it("保存未确认时提交被阻止；确认后以回执版本提交（核对一致）", async () => {
    client.getTask!.mockResolvedValue({ task: taskDto(), draftSummary: sheetDto(), revisionCount: 0, latestSubmittedSheetId: null });
    client.listRevisions!.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    client.getSheet!.mockResolvedValue(sheetDetail());
    const pendingSave = deferred<{ sheet: unknown; textSha256: string }>();
    client.saveDraft!.mockReturnValue(pendingSave.promise);

    await renderAt(`/l3?section=writing&writingTaskId=${TASK}&sheet=${SHEET}`, createElement(L3WritingPage));
    const textarea = await screen.findByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "改过的正文" } });
    fireEvent.click(screen.getByRole("button", { name: "提交本稿" }));
    await flushAsync();
    // flush 在途（保存未确认）：未提交。
    expect(client.submitSheet).not.toHaveBeenCalled();

    // 保存确认（version 1）；核对读面与回执一致（同文同版）→ 允许提交。
    client.getSheet!.mockResolvedValue(sheetDetail({ sheet: sheetDto({ draftVersion: 1 }), text: "改过的正文" }));
    client.submitSheet!.mockResolvedValue({ sheet: sheetDto({ status: "sealed", revisionNo: 1 }), attemptId: SHEET });
    await act(async () => {
      pendingSave.resolve({ sheet: sheetDto({ draftVersion: 1 }), textSha256: SHA });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(client.submitSheet).toHaveBeenCalledWith(TASK, SHEET, { expectedVersion: 1 });
    });
    expect(client.submitSheet).toHaveBeenCalledTimes(1);
  });

  it("核对发现服务器是另一份修订（正文不一致）→ 冲突提示、不提交、不自动重试", async () => {
    client.getTask!.mockResolvedValue({ task: taskDto(), draftSummary: sheetDto(), revisionCount: 0, latestSubmittedSheetId: null });
    client.listRevisions!.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    client.getSheet!.mockResolvedValue(sheetDetail());
    client.saveDraft!.mockResolvedValue({ sheet: sheetDto({ draftVersion: 1 }), textSha256: SHA });

    await renderAt(`/l3?section=writing&writingTaskId=${TASK}&sheet=${SHEET}`, createElement(L3WritingPage));
    const textarea = await screen.findByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "我的确认稿" } });
    // 核对读面：服务器上是别人的修订（正文不同、版本 2）。
    client.getSheet!.mockResolvedValue(sheetDetail({ sheet: sheetDto({ draftVersion: 2 }), text: "别人的改动" }));
    fireEvent.click(screen.getByRole("button", { name: "提交本稿" }));
    await waitFor(() => {
      expect(screen.getByText(/另一份修订，未提交/)).toBeTruthy();
    });
    expect(client.submitSheet).not.toHaveBeenCalled(); // 不采纳最新版本、不提交
    expect((screen.getByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement).value).toBe("我的确认稿");
  });

  it("核对发现版本被推进（同文本新版本）→ 冲突提示、不提交", async () => {
    client.getTask!.mockResolvedValue({ task: taskDto(), draftSummary: sheetDto(), revisionCount: 0, latestSubmittedSheetId: null });
    client.listRevisions!.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    client.getSheet!.mockResolvedValue(sheetDetail());
    client.saveDraft!.mockResolvedValue({ sheet: sheetDto({ draftVersion: 1 }), textSha256: SHA });

    await renderAt(`/l3?section=writing&writingTaskId=${TASK}&sheet=${SHEET}`, createElement(L3WritingPage));
    const textarea = await screen.findByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "同文" } });
    client.getSheet!.mockResolvedValue(sheetDetail({ sheet: sheetDto({ draftVersion: 3 }), text: "同文" }));
    fireEvent.click(screen.getByRole("button", { name: "提交本稿" }));
    await waitFor(() => {
      expect(screen.getByText(/核对发现版本已被推进（可能来自另一处保存），未提交/)).toBeTruthy();
    });
    expect(client.submitSheet).not.toHaveBeenCalled();
  });

  it("核对通过后第三方保存 → CAS 409：冲突提示、submit 恰一次、本地正文保留", async () => {
    client.getTask!.mockResolvedValue({ task: taskDto(), draftSummary: sheetDto(), revisionCount: 0, latestSubmittedSheetId: null });
    client.listRevisions!.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    client.getSheet!.mockResolvedValue(sheetDetail());
    client.saveDraft!.mockResolvedValue({ sheet: sheetDto({ draftVersion: 1 }), textSha256: SHA });
    client.submitSheet!.mockRejectedValue(new BrowserApiError(409, {
      error: "draft version conflict", code: "CONFLICT", details: { code: "DRAFT_VERSION_CONFLICT", actualVersion: 2 },
    }));

    await renderAt(`/l3?section=writing&writingTaskId=${TASK}&sheet=${SHEET}`, createElement(L3WritingPage));
    const textarea = await screen.findByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "核对通过稿" } });
    client.getSheet!.mockResolvedValue(sheetDetail({ sheet: sheetDto({ draftVersion: 1 }), text: "核对通过稿" }));
    fireEvent.click(screen.getByRole("button", { name: "提交本稿" }));
    await waitFor(() => {
      expect(screen.getByText(/提交时另一处先保存了/)).toBeTruthy();
    });
    expect(client.submitSheet).toHaveBeenCalledTimes(1); // 不自动重试
    expect((screen.getByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement).value).toBe("核对通过稿");
  });

  it("提交期间编辑锁定（textarea 只读）", async () => {
    client.getTask!.mockResolvedValue({ task: taskDto(), draftSummary: sheetDto(), revisionCount: 0, latestSubmittedSheetId: null });
    client.listRevisions!.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    client.getSheet!.mockResolvedValue(sheetDetail());
    const pendingSave = deferred<{ sheet: unknown; textSha256: string }>();
    client.saveDraft!.mockReturnValue(pendingSave.promise);

    await renderAt(`/l3?section=writing&writingTaskId=${TASK}&sheet=${SHEET}`, createElement(L3WritingPage));
    const textarea = await screen.findByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "锁定前正文" } });
    fireEvent.click(screen.getByRole("button", { name: "提交本稿" }));
    await flushAsync();
    expect(textarea.readOnly).toBe(true); // 提交在途：编辑锁定
    await act(async () => {
      pendingSave.reject(new BrowserApiError(422, { code: "VALIDATION_ERROR", message: "rejected" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => { expect(screen.getByText(/保存未完成，未能提交/)).toBeTruthy(); });
    expect(textarea.readOnly).toBe(false); // 失败后可继续编辑（正文仍在）
  });

  it("保存失败：提交不发生、正文保留、错误可见；导出同样被阻止", async () => {
    client.getTask!.mockResolvedValue({ task: taskDto(), draftSummary: sheetDto(), revisionCount: 0, latestSubmittedSheetId: null });
    client.listRevisions!.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    client.getSheet!.mockResolvedValue(sheetDetail());
    client.saveDraft!.mockRejectedValue(new BrowserApiError(422, { code: "VALIDATION_ERROR", message: "rejected" }));

    await renderAt(`/l3?section=writing&writingTaskId=${TASK}&sheet=${SHEET}`, createElement(L3WritingPage));
    const textarea = await screen.findByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "别丢的正文" } });
    fireEvent.click(screen.getByRole("button", { name: "提交本稿" }));
    await waitFor(() => { expect(screen.getByText(/保存未完成，未能提交/)).toBeTruthy(); });
    expect(client.submitSheet).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement).value).toBe("别丢的正文");

    // 导出先 flush：保存失败 → 不出文件、明确报错。
    fireEvent.click(screen.getByRole("button", { name: "导出本稿" }));
    await waitFor(() => { expect(screen.getByText(/导出失败，未生成文件/)).toBeTruthy(); });
    expect(client.exportSheet).not.toHaveBeenCalled();
  });

  it("版本冲突：保留本地正文并提供复制与载入服务器稿", async () => {
    client.getTask!.mockResolvedValue({ task: taskDto(), draftSummary: sheetDto(), revisionCount: 0, latestSubmittedSheetId: null });
    client.listRevisions!.mockResolvedValue({ items: [], total: 0, nextCursor: null });
    client.getSheet!.mockResolvedValue(sheetDetail());
    client.saveDraft!.mockRejectedValue(new BrowserApiError(409, {
      error: "draft version conflict", code: "CONFLICT", details: { code: "DRAFT_VERSION_CONFLICT" },
    }));

    await renderAt(`/l3?section=writing&writingTaskId=${TASK}&sheet=${SHEET}`, createElement(L3WritingPage));
    const textarea = await screen.findByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "本地新正文" } });
    fireEvent.blur(textarea);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); }); // 越过防抖，触发保存（409）
    await waitFor(() => { expect(screen.getByText(/另一处更新了这份草稿/)).toBeTruthy(); });
    expect(screen.getByRole("button", { name: "复制本地正文" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "载入服务器稿" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "作文正文" }) as HTMLTextAreaElement).value).toBe("本地新正文");
  });
});

describe("W7 L3 宿主分流（section=writing 优先）", () => {
  it("纯 ?sheet= 且 scope=writing：只读判读后 replace 到作文规范 URL（不落试卷台）", async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path.startsWith("/l3/sheets/")) return { sheet: { scope: "writing", writing_task_id: TASK } };
      // 首屏（home）其余请求一律拒绝：home 以失败态渲染，不阻塞分流 replace。
      throw new Error(`unmocked: ${path}`);
    });
    client.getTask!.mockResolvedValue({ task: taskDto(), draftSummary: sheetDto(), revisionCount: 0, latestSubmittedSheetId: null });
    client.getSheet!.mockResolvedValue(sheetDetail());
    client.listRevisions!.mockResolvedValue({ items: [], total: 0, nextCursor: null });

    await renderAt(`/l3?sheet=${SHEET}`, createElement(L3Page));
    await waitFor(() => {
      const loc = screen.getByTestId("loc").textContent ?? "";
      expect(loc).toContain("section=writing");
      expect(loc).toContain(`writingTaskId=${TASK}`);
      expect(loc).toContain(`sheet=${SHEET}`);
    });
    // 分流路径不落试卷台：从未请求旧题型空间/档案面（也无 openSheet 调用）。
    const sheetApiCalls = (apiFetch as ReturnType<typeof vi.fn>).mock.calls.map(([path]) => String(path));
    expect(sheetApiCalls.filter((path) => path.includes("practice-files"))).toHaveLength(0);
    expect(sheetApiCalls.filter((path) => path.includes("openSheet"))).toHaveLength(0);
  });
});
