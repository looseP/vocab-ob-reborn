/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { L3ExamPaper, type ExamPaper } from "@/frontend/components/l3/L3ExamPaper";
import { L3QuestionAnalysis } from "@/frontend/components/l3/L3QuestionAnalysis";
import { MemoryRouter, useLocation } from "react-router-dom";
import { L3PapersPage } from "@/frontend/components/l3/L3PapersPage";

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
    review_sheet_id: SHEET_ID,
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
  /** 契约漂移注入：直接提供读面原始响应（含非法形状），优先于 gradingResults。 */
  gradingRaw?: () => unknown;
  annotations?: unknown[];
  /** F-1 回看：GET 单纸返回行与 attempts（缺省 sealed 空 attempts）。 */
  fetchSheet?: Record<string, unknown>;
  attempts?: unknown[];
};

function setupMock(options: MockOptions = {}) {
  const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
  const state = { gradingCalls: 0, openSheetCalls: 0 };
  apiFetchMock.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    // ① 评卷读面（GET /l3/sheets/:id/grading）——挂在通用 sheets GET 之前。
    if (String(path) === `/l3/sheets/${SHEET_ID}/grading` && !init?.method) {
      state.gradingCalls += 1;
      if (options.gradingRaw) return options.gradingRaw();
      return { sheet: sheetFixture(), results: options.gradingResults ?? [] };
    }
    if (path === "/l3/sheets" && (!init || init.method === "POST")) {
      state.openSheetCalls += 1;
      return { sheet: options.sheet ?? sheetFixture() };
    }
    if (String(path).startsWith("/l3/sheets/") && !init?.method) {
      return { sheet: options.fetchSheet ?? sheetFixture(), attempts: options.attempts ?? [] };
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
async function renderPaper(flushes = 6, props: Record<string, unknown> = {}): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(L3ExamPaper, { paper, onBack: vi.fn(), ...props }) as ReactElement);
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

describe("契约漂移防御（深测 OB-2/3 转正；F-1 起失败显式化）", () => {
  it("读面请求 reject（网络失败）→ 显式失败态 + 「重试」（不误报「待评卷」、页面不崩溃）", async () => {
    setupMock({ gradingRaw: () => { throw new Error("network down"); } });
    await renderPaper(8);
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("评卷加载失败")).toBeTruthy());
    expect(screen.queryByText(/待评卷/)).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "显示全部答案与解析" })).toBeTruthy();
  });

  it("读面成功但形状非法（results 非数组）→ 失败态可重试，不误报「待评卷」", async () => {
    setupMock({ gradingRaw: () => ({ results: "boom" }) });
    await renderPaper(8);
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("评卷加载失败")).toBeTruthy());
    expect(screen.queryByText(/待评卷/)).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("读面成功但 body 为 null → 同样走失败态（不误报「待评卷」）", async () => {
    setupMock({ gradingRaw: () => null });
    await renderPaper(8);
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("评卷加载失败")).toBeTruthy());
    expect(screen.queryByText(/待评卷/)).toBeNull();
  });

  it("grading 行未知 verdict（alien）→ 显示「评卷：未知」而非误导为「错」", async () => {
    setupMock({ gradingResults: [gradingFixture({ verdict: "alien" })] });
    await renderPaper(8);
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());
    await click(screen.getByRole("button", { name: "显示全部答案与解析" }));
    const node = document.querySelector("[data-grading-verdict]");
    expect(node?.getAttribute("data-grading-verdict")).toBe("alien");
    expect(screen.getByText(/评卷：未知/)).toBeTruthy();
    expect(screen.queryByText(/评卷：错/)).toBeNull();
  });
});

describe("F-1 评卷协作闭环（刷新评卷 / 回看 / 再做一次）", () => {
  const gradingStatusText = (): string =>
    document.querySelector('[data-grading-status="ready"]')?.textContent ?? "";

  it("刷新评卷：失败态「重试」→ 成功后显示「已评 n/m 题」与最近评卷时间", async () => {
    let failMode = true;
    setupMock({
      gradingRaw: () => {
        if (failMode) throw new Error("down");
        return { sheet: sheetFixture(), results: [gradingFixture()] };
      },
    });
    await renderPaper(8);
    await waitFor(() => expect(screen.getByText("评卷加载失败")).toBeTruthy());
    failMode = false;
    await click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(gradingStatusText()).toContain("1/2"));
    expect(gradingStatusText()).toContain("最近评卷");
    expect(screen.queryByText("评卷加载失败")).toBeNull();
  });

  it("改判后手动「刷新评卷」拉到新 verdict（latest-wins 消费链）", async () => {
    let verdict = "wrong";
    setupMock({ gradingRaw: () => ({ sheet: sheetFixture(), results: [gradingFixture({ verdict })] }) });
    await renderPaper(6);
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());
    await click(screen.getByRole("button", { name: "显示全部答案与解析" }));
    expect(screen.getByText(/评卷：错/)).toBeTruthy();
    verdict = "partial";
    await click(screen.getByRole("button", { name: "刷新评卷" }));
    await waitFor(() => expect(screen.getByText(/评卷：半对/)).toBeTruthy());
    expect(screen.queryByText(/评卷：错/)).toBeNull();
  });

  it("回看模式（replaySheetId）：只读指定题纸——不调 openSheet（不新建草稿）、verdict 直出", async () => {
    const { state } = setupMock({ gradingResults: [gradingFixture()] });
    await renderPaper(8, { replaySheetId: SHEET_ID });
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());
    expect(state.openSheetCalls).toBe(0);
    expect(state.gradingCalls).toBe(1);
    await click(screen.getByRole("button", { name: "显示全部答案与解析" }));
    expect(screen.getByText(/评卷：错/)).toBeTruthy();
    expect(screen.getByText(/agent 评卷 · agent-a/)).toBeTruthy();
  });

  it("sealed + onRetake：渲染「再做一次」并回调（父层决定新开/跳转）", async () => {
    setupMock({ gradingResults: [] });
    const onRetake = vi.fn();
    await renderPaper(6, { onRetake });
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());
    await click(screen.getByRole("button", { name: "再做一次" }));
    expect(onRetake).toHaveBeenCalledTimes(1);
  });

  it("未提供 onRetake 或非 sealed：不渲染「再做一次」", async () => {
    setupMock({ gradingResults: [] });
    await renderPaper(6);
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "再做一次" })).toBeNull();
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

  // ── 深测 dt 用例转正：review 脏值族（契约漂移不得渲染、不得崩溃）──
  it("review 为字符串 → 不渲染 review 块、不崩溃、撤回钮仍在", async () => {
    await renderAnalysis({ annotations: [annotationFixture({ review: "sound" })], onWithdraw: vi.fn(), onConfirm: vi.fn() });
    await click(screen.getByRole("button", { name: /原文分析 · 1/ }));
    expect(screen.queryByText(/待商榷/)).toBeNull();
    expect(document.querySelector("[data-annotation-review]")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
    expect(screen.getByRole("button", { name: "撤回" })).toBeTruthy();
  });

  it("review 缺 verdict 键 → 不渲染", async () => {
    await renderAnalysis({ annotations: [annotationFixture({ review: { comment: "只有评论" } })], onConfirm: vi.fn() });
    await click(screen.getByRole("button", { name: /原文分析 · 1/ }));
    expect(document.querySelector("[data-annotation-review]")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
  });

  it("review 脏子值：非字符串 corrected_tags 被过滤、数字 comment 不渲染、不崩溃", async () => {
    await renderAnalysis({
      annotations: [annotationFixture({ review: { verdict: "questionable", corrected_tags: [1, "细节题", null], comment: 42 } })],
      onConfirm: vi.fn(),
    });
    await click(screen.getByRole("button", { name: /原文分析 · 1/ }));
    expect(screen.getByText("? 待商榷")).toBeTruthy();
    expect(screen.getByText("+细节题")).toBeTruthy();
    expect(screen.queryByText("+1")).toBeNull();
    expect(screen.queryByText(/42/)).toBeNull();
    expect(screen.getByRole("button", { name: "确认" })).toBeTruthy();
  });

  it("review verdict 越白名单值（alien）→ 不渲染、不崩溃", async () => {
    await renderAnalysis({ annotations: [annotationFixture({ review: { verdict: "alien" } })], onConfirm: vi.fn() });
    await click(screen.getByRole("button", { name: /原文分析 · 1/ }));
    expect(document.querySelector("[data-annotation-review]")).toBeNull();
  });

  // ── F-1：评审轮次标识（注记为题目级资产——来源对比标注，防旧轮评语被读作本轮结果）──
  it("review 来源=当前题纸 → 「本轮评卷」标注", async () => {
    await renderAnalysis({ onConfirm: vi.fn(), currentSheetId: SHEET_ID });
    await click(screen.getByRole("button", { name: /原文分析 · 1/ }));
    expect(screen.getByText(/本轮评卷/)).toBeTruthy();
    expect(document.querySelector('[data-review-provenance="current"]')).toBeTruthy();
  });

  it("review 来源=他轮题纸 → 「历史评卷」标注", async () => {
    await renderAnalysis({
      onConfirm: vi.fn(),
      currentSheetId: SHEET_ID,
      annotations: [annotationFixture({ review_sheet_id: "00000000-0000-4000-8000-000000000499" })],
    });
    await click(screen.getByRole("button", { name: /原文分析 · 1/ }));
    expect(screen.getByText(/历史评卷/)).toBeTruthy();
    expect(document.querySelector('[data-review-provenance="history"]')).toBeTruthy();
  });

  it("旧数据无来源（review_sheet_id null）→ 保守标「历史评卷」", async () => {
    await renderAnalysis({
      onConfirm: vi.fn(),
      currentSheetId: SHEET_ID,
      annotations: [annotationFixture({ review_sheet_id: null })],
    });
    await click(screen.getByRole("button", { name: /原文分析 · 1/ }));
    expect(screen.getByText(/历史评卷/)).toBeTruthy();
  });
});

// ── F-1：题纸档案与回看深链（L3PapersPage 层）──────────────────────────────

const SOURCE_ID = "00000000-0000-4000-8000-000000000302";

function archiveItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000401",
    scope: "file",
    source_id: SOURCE_ID,
    question_type: "reading_choice",
    paper_id: null,
    status: "sealed",
    seal_mode: "full",
    sealed_at: "2026-09-18T00:10:00.000Z",
    created_at: "2026-09-18T00:00:00.000Z",
    graded_count: 3,
    venue_title: "WA 阅读理解文件",
    ...overrides,
  };
}

function LocationProbe(): ReactElement {
  const location = useLocation();
  return createElement("span", { "data-loc": `${location.pathname}${location.search}` });
}

describe("F-1 题纸档案与回看深链（L3PapersPage）", () => {
  const apiFetchMock = (): ReturnType<typeof vi.fn> => apiFetch as ReturnType<typeof vi.fn>;

  async function renderPapers(props: Record<string, unknown> = {}): Promise<void> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(
        MemoryRouter,
        { initialEntries: ["/l3"] },
        createElement(L3PapersPage, props as never),
        createElement(LocationProbe),
      ) as ReactElement);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
  }

  it("档案页签：渲染「待评卷/已评 n 题」状态与「查看解析」深链（?sheet=）", async () => {
    apiFetchMock().mockImplementation(async (path: string) => {
      if (String(path).startsWith("/l3/sheets?")) {
        return {
          items: [
            archiveItem(),
            archiveItem({
              id: "00000000-0000-4000-8000-000000000402",
              graded_count: 0,
            }),
            archiveItem({
              id: "00000000-0000-4000-8000-000000000403",
              status: "draft",
              graded_count: 0,
              seal_mode: null,
              sealed_at: null,
            }),
          ],
        };
      }
      if (path === "/l3/papers?limit=100") return { items: [] };
      return {};
    });
    await renderPapers();
    await click(screen.getByRole("tab", { name: "题纸档案" }));
    await waitFor(() => expect(screen.getByText(/已评 3 题/)).toBeTruthy());
    expect(screen.getByText(/待评卷/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "继续作答" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "查看解析" })).toHaveLength(2);

    await click(screen.getAllByRole("button", { name: "查看解析" })[0]!);
    expect(document.querySelector("[data-loc]")?.getAttribute("data-loc"))
      .toBe("/l3?sheet=00000000-0000-4000-8000-000000000401");
  });

  it("回看深链（paper 域）：只读指定题纸——全程不调 openSheet，「再做一次」给出常规入口", async () => {
    const state = { openSheetCalls: 0 };
    apiFetchMock().mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/l3/sheets" && init?.method === "POST") {
        state.openSheetCalls += 1;
        return { sheet: sheetFixture() };
      }
      if (String(path) === `/l3/sheets/${SHEET_ID}` && !init?.method) {
        return { sheet: sheetFixture(), attempts: [] };
      }
      if (String(path) === `/l3/sheets/${SHEET_ID}/grading`) {
        return { sheet: sheetFixture(), results: [gradingFixture()] };
      }
      if (String(path).startsWith(`/l3/papers/${PAPER_ID}`)) return paper;
      if (String(path).startsWith("/l3/attempts")) return { items: [] };
      if (String(path).startsWith("/l3/question-annotations")) return { items: [] };
      if (path === "/l3/annotation-tags") return { entry: [], option: [] };
      if (String(path).endsWith("/assessment")) return { item: null };
      return {};
    });
    await renderPapers({ deepLinkSheet: SHEET_ID });
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());
    expect(state.openSheetCalls).toBe(0);
    await waitFor(() => {
      expect(document.querySelector('[data-grading-status="ready"]')?.textContent).toContain("1/2");
    });

    await click(screen.getByRole("button", { name: "再做一次" }));
    expect(document.querySelector("[data-loc]")?.getAttribute("data-loc")).toBe(`/l3?paper=${PAPER_ID}`);
  });

  it("回看深链（file 域）：组装文件伪卷，回退/重做给出题型空间路径，不调 openSheet", async () => {
    const state = { openSheetCalls: 0 };
    apiFetchMock().mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/l3/sheets" && init?.method === "POST") {
        state.openSheetCalls += 1;
        return { sheet: sheetFixture() };
      }
      if (String(path) === `/l3/sheets/${SHEET_ID}` && !init?.method) {
        return {
          sheet: sheetFixture({
            scope: "file",
            source_id: SOURCE_ID,
            question_type: "reading_choice",
            paper_id: null,
            scope_key: `file:${SOURCE_ID}:reading_choice`,
          }),
          attempts: [],
        };
      }
      if (String(path) === `/l3/sheets/${SHEET_ID}/grading`) return { sheet: sheetFixture(), results: [] };
      if (String(path).startsWith("/l3/practice-files/detail")) {
        return {
          question_type: "reading_choice",
          source: { id: SOURCE_ID, title: "WA 阅读理解文件" },
          source_content: null,
          file_key: null,
          questions: paper.sections[0]!.questions,
        };
      }
      if (String(path).startsWith("/l3/attempts")) return { items: [] };
      if (String(path).startsWith("/l3/question-annotations")) return { items: [] };
      if (path === "/l3/annotation-tags") return { entry: [], option: [] };
      if (String(path).endsWith("/assessment")) return { item: null };
      return {};
    });
    await renderPapers({ deepLinkSheet: SHEET_ID });
    await waitFor(() => expect(screen.getByText("已定格")).toBeTruthy());
    expect(state.openSheetCalls).toBe(0);

    await click(screen.getByRole("button", { name: "再做一次" }));
    expect(document.querySelector("[data-loc]")?.getAttribute("data-loc"))
      .toBe(`/l3?venue=reading_choice&file=${SOURCE_ID}`);
  });
});
