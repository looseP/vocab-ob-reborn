/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { L3ExamPaper, type ExamPaper } from "@/frontend/components/l3/L3ExamPaper";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));
import { apiFetch } from "@/frontend/api/client";

const QUESTION_ID = "00000000-0000-4000-8000-000000000101";
const ANNOTATION_ID = "00000000-0000-4000-8000-000000000201";

const paper: ExamPaper = {
  id: "00000000-0000-4000-8000-000000000009",
  title: "2025 英语一",
  direction: "考研",
  metadata: { year: 2025 },
  sections: [{
    key: "s1",
    title: "Text 1",
    questionType: "reading_choice",
    sourceId: "00000000-0000-4000-8000-000000000002",
    fileKey: null,
    questionIds: [QUESTION_ID],
    missing: false,
    source_title: "Text 1",
    source_content: "The trap phrase hides in this sentence. More text follows.",
    questions: [{
      id: QUESTION_ID,
      ordinal: 0,
      stem: "21. Why did the author?",
      options: [
        { key: "A", text: "甲" },
        { key: "B", text: "乙" },
      ],
      answer: { choice: "B" },
      explanation: null,
      evidence: [],
    }],
  }],
};

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 不提供 IntersectionObserver（卷面节导航观察器）。
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] { return []; }
}
(globalThis as Record<string, unknown>).IntersectionObserver ??= ResizeObserverStub;

const roots: Root[] = [];
async function render(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(L3ExamPaper, { paper, onBack: vi.fn() }) as ReactElement);
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  (apiFetch as ReturnType<typeof vi.fn>).mockReset();
});

describe("L3ExamPaper 做题注记装配", () => {
  it("卷面加载后批量拉取注记与标签字典，并在题卡渲染折叠子区", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    // 批次二起卷面进卷会自动开纸（POST /l3/sheets）；按 URL 分派 mock，
    // 避免序列式 mock 被新请求错位。
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/l3/sheets") {
        return {
          sheet: {
            id: "00000000-0000-4000-8000-000000000401",
            user_id: "00000000-0000-4000-8000-000000000001",
            scope: "paper",
            scope_key: "paper:00000000-0000-4000-8000-000000000009",
            source_id: null,
            question_type: null,
            paper_id: "00000000-0000-4000-8000-000000000009",
            status: "draft",
            answers: {},
            seal_mode: null,
            summary: null,
            sealed_at: null,
            created_at: "2026-09-17T00:00:00Z",
            updated_at: "2026-09-17T00:00:00Z",
          },
        };
      }
      if (path.startsWith("/l3/question-annotations")) {
        return {
          items: [{
            id: ANNOTATION_ID,
            user_id: "00000000-0000-4000-8000-000000000001",
            question_id: QUESTION_ID,
            ordinal: 0,
            anchor_start: 4,
            anchor_end: 15,
            excerpt: "trap phrase",
            note: "B 项偷换概念",
            entry_tags: ["推断题"],
            option_tags: { B: ["偷换概念"] },
            stage: "confirmed",
            sheet_id: null,
            review: null,
            status: "active",
            created_at: "2026-09-16T00:00:00Z",
            updated_at: "2026-09-16T00:00:00Z",
          }],
        };
      }
      if (path === "/l3/annotation-tags") {
        return { entry: ["细节题", "推断题"], option: ["偷换概念"] };
      }
      return {};
    });

    await render();

    await waitFor(() => expect(screen.getByRole("button", { name: /原文分析 · 1/ })).toBeTruthy());
    const calls = apiFetchMock.mock.calls.map(([path]: [string]) => path);
    expect(calls.some((p) => p.startsWith("/l3/question-annotations"))).toBe(true);
    expect(calls).toContain("/l3/annotation-tags");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /原文分析/ }));
      await Promise.resolve();
    });
    expect(screen.getByText("B 项偷换概念")).toBeTruthy();
    // 锚点 mark 渲染在文栏（下划线通道）
    const mark = document.querySelector("[data-ann-id]");
    expect(mark?.textContent).toBe("trap phrase");
  });
});
