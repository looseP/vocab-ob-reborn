/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * 待录核对面（ADR-0037 决策 6）。
 *
 * 这组测试钉的是**核对面必须带足事实**这条纪律：答案键与证据原文切片必须在采纳
 * 前可见，越界锚点必须显式告警。少了任何一条，「采纳」就退化成盲签，闸门白设。
 */
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor, within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "@/frontend/api/client";
import { PendingQuestionsPanel } from "@/frontend/components/l3/PendingQuestionsPanel";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

/** 与同目录测试一致的挂载方式（本仓不用 @testing-library/react，只用 dom + createRoot）。 */
async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(createElement(PendingQuestionsPanel, { onToast: addToast }));
  });
}

afterEach(() => {
  act(() => {
    for (const { root } of mounted.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

const addToast = vi.fn();
const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;

const Q1 = "00000000-0000-4000-8000-000000000101";
const Q2 = "00000000-0000-4000-8000-000000000102";

function pendingItem(overrides: Record<string, unknown> = {}) {
  return {
    question: {
      id: Q1,
      source_id: "00000000-0000-4000-8000-000000000002",
      file_key: null,
      question_type: "reading_choice",
      stem: "21. The author suggests that",
      options: [{ key: "A", text: "选项 A" }, { key: "B", text: "选项 B" }],
      answer: { choice: "B" },
      explanation: "第三段由 will 转 must，是转折而非并列。",
      evidence: [{ start: 0, end: 12, label: "关键句" }],
      created_by: "claude-code",
      created_at: "2026-09-26T00:00:00Z",
      ...overrides,
    },
    sourceTitle: "2023 英一 Text 1",
    evidenceExcerpts: [{ excerpt: "The author s", outOfRange: false }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PendingQuestionsPanel（待录核对面）", () => {
  it("采纳前必须显示答案键、选项与证据原文切片（决策 6：否则采纳是盲签）", async () => {
    apiFetchMock.mockResolvedValueOnce({ items: [pendingItem()], total: 1 });
    await mount();

    await waitFor(() => expect(screen.getByTestId(`pending-item-${Q1}`)).toBeTruthy());
    expect(screen.getByTestId("pending-answer").textContent).toContain("选项 B");
    expect(screen.getByTestId("pending-option-A").textContent).toContain("选项 A");
    // 证据切片由服务端算好；owner 看到的是原文而不是一个 offset 数字
    expect(screen.getByTestId("pending-evidence").textContent).toContain("The author s");
    expect(screen.getByText(/由 claude-code 录/)).toBeTruthy();
  });

  it("越界锚点显式告警，不静默显示成合法短句", async () => {
    apiFetchMock.mockResolvedValueOnce({
      total: 1,
      items: [{
        ...pendingItem(),
        evidenceExcerpts: [{ excerpt: null, outOfRange: true }],
      }],
    });
    await mount();

    await waitFor(() => expect(screen.getByTestId(`pending-item-${Q1}`)).toBeTruthy());
    expect(screen.getByTestId("pending-evidence-out-of-range").textContent).toContain("锚点越界");
    expect(screen.queryByTestId("pending-evidence")).toBeNull();
    expect(screen.getByText(/证据位置与原文不符/)).toBeTruthy();
  });

  it("单条采纳走 /accept，成功后刷新列表", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ items: [pendingItem()], total: 1 })
      .mockResolvedValueOnce({ acceptedCount: 1, results: [{ id: Q1, ok: true, status: "active" }] })
      .mockResolvedValueOnce({ items: [], total: 0 });
    await mount();

    await waitFor(() => expect(screen.getByTestId(`pending-item-${Q1}`)).toBeTruthy());
    fireEvent.click(screen.getByText("采纳"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("success", "已采纳 1 道待录题"));
    const acceptCall = apiFetchMock.mock.calls.find((call) => String(call[0]).endsWith("/accept"));
    expect(acceptCall?.[1]).toMatchObject({ method: "POST" });
  });

  it("部分失败逐条可见（不整批报成功）", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ items: [pendingItem()], total: 1 })
      .mockResolvedValueOnce({
        acceptedCount: 1,
        results: [
          { id: Q1, ok: true, status: "active" },
          { id: Q2, ok: false, reason: "not_pending", status: "rejected" },
        ],
      })
      .mockResolvedValueOnce({ items: [], total: 0 });
    await mount();

    await waitFor(() => expect(screen.getByTestId(`pending-item-${Q1}`)).toBeTruthy());
    const article = screen.getByTestId(`pending-item-${Q1}`);
    fireEvent.click(within(article).getByText("采纳"));
    // 逐条结果里的失败数必须进提示（决策 4/9）
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("error", expect.stringContaining("未成功")));
  });

  it("多选走 accept-batch，body 带全部选中 id", async () => {
    apiFetchMock
      .mockResolvedValueOnce({
        total: 2,
        items: [
          pendingItem(),
          { ...pendingItem(), question: { ...pendingItem().question, id: Q2, stem: "22. 题干" } },
        ],
      })
      .mockResolvedValueOnce({ acceptedCount: 2, results: [] })
      .mockResolvedValueOnce({ items: [], total: 0 });
    await mount();

    await waitFor(() => expect(screen.getByTestId(`pending-item-${Q2}`)).toBeTruthy());
    fireEvent.click(screen.getByLabelText("全选"));
    fireEvent.click(screen.getByText(/采纳所选/));
    await waitFor(() => {
      const batch = apiFetchMock.mock.calls.find((call) => String(call[0]).endsWith("/accept-batch"));
      expect(batch).toBeTruthy();
      expect(JSON.parse(String((batch![1] as { body: string }).body))).toEqual({ questionIds: [Q1, Q2] });
    });
  });

  it("驳回走 /reject", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ items: [pendingItem()], total: 1 })
      .mockResolvedValueOnce({ question: { ...pendingItem().question, status: "rejected" } })
      .mockResolvedValueOnce({ items: [], total: 0 });
    await mount();

    await waitFor(() => expect(screen.getByTestId(`pending-item-${Q1}`)).toBeTruthy());
    fireEvent.click(screen.getByText("驳回"));
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("success", "已驳回该待录题"));
    const rejectCall = apiFetchMock.mock.calls.find((call) => String(call[0]).endsWith("/reject"));
    expect(rejectCall).toBeTruthy();
  });

  it("空列表说明来由（不是空白页）", async () => {
    apiFetchMock.mockResolvedValueOnce({ items: [], total: 0 });
    await mount();
    await waitFor(() => expect(screen.getByText("没有待录题。")).toBeTruthy());
    expect(screen.getByText(/答案键一旦被作答就永久不可改/)).toBeTruthy();
  });

  it("读取失败：如实报错并给空列表（不假装「没有待录」）", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("boom"));
    await mount();
    await waitFor(() => expect(addToast).toHaveBeenCalledWith("error", "待录列表读取失败"));
  });
});
