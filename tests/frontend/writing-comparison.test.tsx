/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * W8 双稿对照测试：两稿独立读取、互不借用反馈；cleared 侧占位；非 sealed 拒绝。
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/writingClient", () => ({
  writingClient: {
    getSheet: vi.fn(),
  },
}));

import { writingClient } from "@/frontend/api/writingClient";
import { WritingComparison } from "@/frontend/components/writing/WritingComparison";

const TASK = "00000000-0000-4000-8000-000000000701";
const SHEET_L = "00000000-0000-4000-8000-000000000811";
const SHEET_R = "00000000-0000-4000-8000-000000000812";
const SHA = "a".repeat(64);

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function sealedDetail(sheetId: string, revisionNo: number, overrides: Record<string, unknown> = {}) {
  return {
    sheet: {
      id: sheetId, taskId: TASK, status: "sealed", draftVersion: 2, revisionNo, parentSheetId: null,
      createdAt: "x", updatedAt: "x", sealedAt: "2026-09-18T01:00:00.000Z",
    },
    text: `正文-${revisionNo}`,
    textSha256: SHA,
    wordCount: 2,
    contentStatus: "available" as const,
    feedback: null,
    ...overrides,
  };
}

const client = writingClient as unknown as Record<string, ReturnType<typeof vi.fn>>;
const mountedRoots: Root[] = [];

afterEach(() => {
  act(() => { for (const root of mountedRoots.splice(0)) root.unmount(); });
  document.body.innerHTML = "";
});
beforeEach(() => { client.getSheet!.mockReset(); });

describe("W8 对照（独立读取，不互相借用）", () => {
  it("两稿各自反馈；未评侧显示尚无反馈；cleared 侧占位不复活", async () => {
    client.getSheet!.mockImplementation(async (_taskId: string, sheetId: string) => {
      if (sheetId === SHEET_L) {
        return sealedDetail(SHEET_L, 1, {
          feedback: {
            feedback: {
              schemaVersion: 1, summary: "左稿评语", strengths: [],
              dimensions: {
                task_response: { applicable: true, comment: "c" },
                organization: { applicable: true, comment: "c" },
                language: { applicable: true, comment: "c" },
                expression: { applicable: false, comment: "-" },
              },
              priorities: [],
            },
            version: 1, textSha256: SHA, lastEditor: "agent-a", updatedAt: "x",
          },
        });
      }
      return sealedDetail(SHEET_R, 2, { text: null, textSha256: null, contentStatus: "cleared" });
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(createElement(WritingComparison, {
        taskId: TASK, leftSheetId: SHEET_L, rightSheetId: SHEET_R, onClose: () => {},
      }));
      await Promise.resolve();
    });

    await waitFor(() => { expect(screen.getByText("正文-1")).toBeTruthy(); });
    // 左稿反馈存在，右稿（cleared）不得借用左稿反馈。
    expect(screen.getByText(/左稿评语/)).toBeTruthy();
    expect(screen.getAllByText(/左稿评语/)).toHaveLength(1);
    expect(screen.getByText(/本稿正文已清理，仅保留稿次记录/)).toBeTruthy();
    expect(screen.getByText(/评语随正文清理，不再展示/)).toBeTruthy();
    expect(client.getSheet).toHaveBeenCalledWith(TASK, SHEET_L);
    expect(client.getSheet).toHaveBeenCalledWith(TASK, SHEET_R);
  });

  it("非 sealed 稿（草稿）拒绝参与对照", async () => {
    client.getSheet!.mockResolvedValue(sealedDetail(SHEET_L, 1, {
      sheet: {
        id: SHEET_L, taskId: TASK, status: "draft", draftVersion: 0, revisionNo: null, parentSheetId: null,
        createdAt: "x", updatedAt: "x", sealedAt: null,
      },
    }));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(createElement(WritingComparison, {
        taskId: TASK, leftSheetId: SHEET_L, rightSheetId: SHEET_R, onClose: () => {},
      }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => { expect(screen.getAllByText(/仅已提交稿可参与对照/).length).toBeGreaterThan(0); });
  });
});
