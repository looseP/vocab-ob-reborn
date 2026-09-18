/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * W8 反馈面板与评阅指令测试：四态分离（pending/失败/cleared/hash 不一致）、
 * 刷新诚实（失败保留旧结果）、纯文本渲染、指令无 token。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WritingFeedbackPanel } from "@/frontend/components/writing/WritingFeedbackPanel";
import { WritingReviewInstruction, buildReviewInstruction } from "@/frontend/components/writing/WritingReviewInstruction";

const TASK = "00000000-0000-4000-8000-000000000701";
const SHEET = "00000000-0000-4000-8000-000000000801";
const QUESTION = "00000000-0000-4000-8000-000000000101";
const SHA = "a".repeat(64);

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function taskDto() {
  return {
    id: TASK, questionId: QUESTION, title: "谈谈你的看法", prompt: "题面",
    kind: "free", direction: "通用", status: "active",
    createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
  };
}

function sealedDetail(overrides: Record<string, unknown> = {}) {
  return {
    sheet: {
      id: SHEET, taskId: TASK, status: "sealed", draftVersion: 2, revisionNo: 1, parentSheetId: null,
      createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z", sealedAt: "2026-09-18T01:00:00.000Z",
    },
    text: "已提交正文", textSha256: SHA, wordCount: 5, contentStatus: "available", feedback: null,
    ...overrides,
  };
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

const mountedRoots: Root[] = [];
function renderDirect(element: ReactElement): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  void act(() => { root.render(element); });
}

async function flushAsync(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(() => {
  act(() => { for (const root of mountedRoots.splice(0)) root.unmount(); });
  document.body.innerHTML = "";
});

describe("W8 反馈面板（四态不混同 + 刷新诚实）", () => {
  it("pending / cleared / hash 不一致 三态分离（不一致隐藏内容防误导）", async () => {
    renderDirect(createElement(WritingFeedbackPanel, {
      task: taskDto() as never, detail: sealedDetail() as never, onRefresh: async () => {},
    }));
    await flushAsync();
    expect(screen.getByText(/尚无反馈/)).toBeTruthy();

    renderDirect(createElement(WritingFeedbackPanel, {
      task: taskDto() as never,
      detail: sealedDetail({ text: null, textSha256: null, contentStatus: "cleared" }) as never,
      onRefresh: async () => {},
    }));
    await flushAsync();
    expect(screen.getAllByText(/正文已清理/).length).toBeGreaterThan(0);

    renderDirect(createElement(WritingFeedbackPanel, {
      task: taskDto() as never,
      detail: sealedDetail({ feedback: feedbackRecord({ textSha256: "f".repeat(64) }) }) as never,
      onRefresh: async () => {},
    }));
    await flushAsync();
    expect(screen.getByText(/反馈与当前正文不一致/)).toBeTruthy();
    expect(screen.queryByText(/结构清楚，论据可以更具体/)).toBeNull();
  });

  it("ready：文本渲染 + 建议定位按钮存在（纯文本，无 HTML 执行面）", async () => {
    renderDirect(createElement(WritingFeedbackPanel, {
      task: taskDto() as never,
      detail: sealedDetail({
        feedback: feedbackRecord({
          feedback: {
            ...feedbackRecord().feedback,
            summary: "<img src=x onerror=alert(1)> 结构清楚。",
          },
        }),
      }) as never,
      onRefresh: async () => {},
    }));
    await flushAsync();
    // HTML 标签作为纯文本显示，未被解析为元素。
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)> 结构清楚。/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "跳至原句" })).toBeTruthy();
  });

  it("刷新失败：保留旧结果并明确提示（不假装最新）", async () => {
    let failing = false;
    renderDirect(createElement(WritingFeedbackPanel, {
      task: taskDto() as never,
      detail: sealedDetail({ feedback: feedbackRecord() }) as never,
      onRefresh: async () => { if (failing) throw new Error("net"); },
    }));
    await flushAsync();
    expect(screen.getByText(/结构清楚，论据可以更具体/)).toBeTruthy();
    failing = true;
    fireEvent.click(screen.getByRole("button", { name: "刷新反馈" }));
    await waitFor(() => { expect(screen.getByText(/刷新失败；以下仍为上次结果/)).toBeTruthy(); });
    expect(screen.getByText(/结构清楚，论据可以更具体/)).toBeTruthy();
  });
});

describe("W8 评阅指令（无 token）", () => {
  it("包含 taskId/sheetId 与 HTTP 契约；不含 Bearer/token 字样；复制可用", async () => {
    const instruction = buildReviewInstruction(TASK, SHEET);
    expect(instruction).toContain(TASK);
    expect(instruction).toContain(SHEET);
    expect(instruction).toContain("GET /api/l3/writing/tasks/");
    expect(instruction).toContain("PUT /api/l3/writing/tasks/");
    expect(instruction.toLowerCase()).not.toContain("bearer");
    expect(instruction.toLowerCase()).not.toContain("token");

    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    renderDirect(createElement(WritingReviewInstruction, { taskId: TASK, sheetId: SHEET }));
    await flushAsync();
    fireEvent.click(screen.getByRole("button", { name: "复制本地评阅指令" }));
    await waitFor(() => { expect(writeText).toHaveBeenCalledTimes(1); });
  });
});
