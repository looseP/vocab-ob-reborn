/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { L3ExamPaper, type ExamPaper } from "@/frontend/components/l3/L3ExamPaper";
import { L3QuestionAnalysis } from "@/frontend/components/l3/L3QuestionAnalysis";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));
import { apiFetch } from "@/frontend/api/client";

const PAPER_ID = "00000000-0000-4000-8000-000000000009";
const SHEET_ID = "00000000-0000-4000-8000-000000000401";
const Q1 = "00000000-0000-4000-8000-000000000101";
const Q2 = "00000000-0000-4000-8000-000000000102";
const A1 = "00000000-0000-4000-8000-000000000201";

const paper: ExamPaper = {
  id: PAPER_ID,
  title: "2025 英语一",
  direction: "考研",
  metadata: { year: 2025 },
  sections: [{
    key: "s1",
    title: "Text 1",
    questionType: "reading_choice",
    sourceId: null,
    fileKey: "rls-file-1",
    questionIds: [Q1, Q2],
    missing: false,
    source_title: null,
    source_content: null,
    questions: [
      {
        id: Q1, ordinal: 0, stem: "21. Why did the author?",
        options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
        answer: { choice: "B" }, explanation: "【词义辨析】测试解析", evidence: [],
      },
      {
        id: Q2, ordinal: 1, stem: "22. What does the phrase mean?",
        options: [{ key: "A", text: "丙" }, { key: "B", text: "丁" }],
        answer: { choice: "A" }, explanation: null, evidence: [],
      },
    ],
  }],
};

function sheetFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SHEET_ID,
    user_id: "00000000-0000-4000-8000-000000000001",
    scope: "paper",
    scope_key: `paper:${PAPER_ID}`,
    source_id: null,
    question_type: null,
    paper_id: PAPER_ID,
    status: "sealed",
    answers: {},
    seal_mode: "full",
    summary: null,
    sealed_at: "2026-09-17T00:00:00Z",
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function annotationFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: A1,
    user_id: "00000000-0000-4000-8000-000000000001",
    question_id: Q1,
    ordinal: 0,
    anchor_start: 12,
    anchor_end: 20,
    excerpt: "trap phrase",
    note: "选项 B 偷换概念",
    entry_tags: ["推断题"],
    option_tags: {},
    stage: "submitted",
    sheet_id: SHEET_ID,
    review: { verdict: "questionable", corrected_tags: ["细节题"], comment: "锚点偏了" },
    status: "active",
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function gradingFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000801",
    user_id: "00000000-0000-4000-8000-000000000001",
    sheet_id: SHEET_ID,
    question_id: Q1,
    verdict: "wrong",
    analysis_md: "定位偏移：把举例当论点。",
    graded_by: "agent-a",
    graded_at: "2026-09-17T01:00:00Z",
    ...overrides,
  };
}

type MockOptions = {
  sheet?: Record<string, unknown>;
  gradingResults?: unknown[];
  annotations?: unknown[];
};

function setupMock(options: MockOptions = {}) {
  const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
  const state = { gradingCalls: 0 };
  apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    // ① 评卷读面（GET /l3/sheets/:id/grading）——挂在通用 sheets GET 之前。
    if (String(path) === `/l3/sheets/${SHEET_ID}/grading` && !init?.method) {
      state.gradingCalls += 1;
      return { sheet: sheetFixture(), results: options.gradingResults ?? [] };
    }
    if (path === "/l3/sheets" && (!init || init.method === "POST")) {
      return { sheet: options.sheet ?? sheetFixture() };
    }
    if (String(path).startsWith("/l3/sheets/") && !init?.method) {
      return { sheet: sheetFixture(), attempts: [] };
    }
    if (String(path).startsWith("/l3/attempts")) return { items: [] };
    if (String(path).startsWith("/l3/question-annotations")) return { items: options.annotations ?? [] };
    if (path === "/l3/annotation-tags") return { entry: [], option: [] };
    if (String(path).endsWith("/assessment")) return { item: null };
    return {};
  });
  return { apiFetchMock, state };
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] { return []; }
}
(globalThis as Record<string, unknown>).IntersectionObserver ??= ResizeObserverStub;

const roots: Root[] = [];
async function renderPaper(flushes = 6): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(L3ExamPaper, { paper, onBack: vi.fn() }) as ReactElement);
    for (let i = 0; i < flushes; i += 1) await Promise.resolve();
  });
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(target);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  (apiFetch as ReturnType<typeof vi.fn>).mockReset();
  addToastMock.mockReset();
});

describe("L3ExamPaper 解析模式判读（批次三①）", () => {
  it("verdict 徽标 + agent 分析折叠区：仅揭示后渲染，做题中零泄漏", async () => {
    setupMock({ gradingResults: [gradingFixture()] });
    await renderPaper();
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());

    // 未揭示：不显示任何判读（D8 精神延伸至 verdict）。
    expect(screen.queryByText(/评卷：/)).toBeNull();

    await click(screen.getByRole("button", { name: "显示全部答案与解析" }));
    expect(screen.getByText(/评卷：错/)).toBeTruthy();
    expect(screen.getByText(/agent 评卷 · agent-a/)).toBeTruthy();

    // 分析默认为折叠态，展开后显示全文。
    expect(screen.queryByText(/定位偏移：把举例当论点。/)).toBeNull();
    await click(screen.getByRole("button", { name: /展开分析/ }));
    expect(screen.getByText(/定位偏移：把举例当论点。/)).toBeTruthy();
  });

  it("sealed 且无评卷结果 → 「待评卷」提示（引导找 agent 评卷）", async () => {
    setupMock({ gradingResults: [] });
    await renderPaper();
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/待评卷 · 可请 agent 评卷/)).toBeTruthy());
  });

  it("做题模式（draft）零变更：不请求评卷读面、无判读、无「待评卷」", async () => {
    const { state } = setupMock({
      sheet: sheetFixture({ status: "draft", seal_mode: null, sealed_at: null }),
      gradingResults: [gradingFixture()],
    });
    await renderPaper();
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    expect(state.gradingCalls).toBe(0);
    expect(screen.queryByText(/评卷：/)).toBeNull();
    expect(screen.queryByText(/待评卷/)).toBeNull();
  });
});

describe("L3QuestionAnalysis 注记 review 对照（批次三①）", () => {
  const question = paper.sections[0]!.questions[0]!;

  async function renderAnalysis(props: Record<string, unknown>): Promise<void> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(L3QuestionAnalysis, {
        question,
        annotations: [annotationFixture()],
        tagDict: { entry: [], option: [] },
        onLocate: vi.fn(),
        onCreate: vi.fn(),
        onPatch: vi.fn(),
        onDelete: vi.fn(),
        onSaveTagDict: vi.fn(),
        ...props,
      } as never) as ReactElement);
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
    });
  }

  it("questionable review：徽标 + corrected_tags 差异（+/−）+ comment；「确认」钮回调", async () => {
    const onConfirm = vi.fn(async () => {});
    await renderAnalysis({ onConfirm });
    await click(screen.getByRole("button", { name: /原文分析 · 1/ }));

    expect(screen.getByText("? 待商榷")).toBeTruthy();
    expect(screen.getByText("锚点偏了")).toBeTruthy();
    expect(screen.getByText("建议")).toBeTruthy();
    expect(screen.getByText("+细节题")).toBeTruthy();
    expect(screen.getByText("−推断题")).toBeTruthy();

    await click(screen.getByRole("button", { name: "确认" }));
    expect(onConfirm).toHaveBeenCalledWith(A1);
  });

  it("无 review 的 submitted 注记不渲染 review 块也不渲染「确认」钮", async () => {
    const onConfirm = vi.fn(async () => {});
    await renderAnalysis({
      onConfirm,
      annotations: [annotationFixture({ review: null })],
    });
    await click(screen.getByRole("button", { name: /原文分析 · 1/ }));

    expect(screen.queryByText(/待商榷/)).toBeNull();
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
    // 撤回通道不受影响（owner 处置第二条路）。
    expect(screen.getByRole("button", { name: "撤回" })).toBeTruthy();
  });
});
