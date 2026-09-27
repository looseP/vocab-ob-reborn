// @vitest-environment jsdom

/**
 * 卷面三模式的组件行为（批次 B3）。
 *
 * B2 验的是判定表本身；本文件验的是**组件有没有照表渲染**，两者的失败含义不同：
 * B2 挂 = 矩阵写错；本文件挂 = 接线接错（典型症状：某处仍按旧的 `revealAll` 走）。
 *
 * 护栏对应（执行文档 §4）：G-1 纯净只读 / G-2 隐藏即声明 / G-3 模式不得越权 /
 * G-4 往返不丢作答 / G-7 切换器只在有意义处。
 */
vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { L3ExamPaper } from "@/frontend/components/l3/L3ExamPaper";
import type { ExamPaper } from "@/frontend/components/l3/examTypes";
import { apiFetch } from "@/frontend/api/client";
import type { ExamMode } from "@/frontend/viewModels/examModeNavigation";

const PAPER_ID = "00000000-0000-4000-8000-000000000031";
const SHEET_ID = "00000000-0000-4000-8000-000000000032";
const Q1 = "00000000-0000-4000-8000-000000000041";
const Q2 = "00000000-0000-4000-8000-000000000042";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] { return []; }
}
(globalThis as Record<string, unknown>).IntersectionObserver ??= ResizeObserverStub;

const paper: ExamPaper = {
  id: PAPER_ID,
  title: "2025 英语一",
  direction: "考研",
  metadata: { year: 2025 },
  sections: [{
    key: "s1",
    title: "Text 1",
    questionType: "reading_choice",
    sourceId: "00000000-0000-4000-8000-000000000051",
    fileKey: null,
    questionIds: [Q1, Q2],
    missing: false,
    source_title: "Text 1 · 出处",
    source_content: "The quick brown fox jumps over the lazy dog near the trap phrase today.",
    questions: [
      {
        id: Q1, ordinal: 0, stem: "21. What does the fox do?",
        options: [{ key: "A", text: "jumps" }, { key: "B", text: "sleeps" }],
        answer: { choice: "B" }, explanation: "【词义辨析】fox 与 sleep 搭配不当。",
        evidence: [{ start: 4, end: 15, label: "21" }],
      },
      {
        id: Q2, ordinal: 1, stem: "22. What is 'trap phrase'?",
        options: [{ key: "A", text: "陷阱短语" }, { key: "B", text: "旅行用语" }],
        answer: { choice: "A" }, explanation: null, evidence: [],
      },
    ],
  }],
};

interface MockOptions {
  sheetStatus?: "draft" | "sealed";
  /** draft 恢复路径：题纸 answers jsonb（含 choice 与 marks）。 */
  sheetOverrides?: Record<string, unknown>;
  attempts?: unknown[];
  annotations?: unknown[];
  /** 批量评析读面（2026-09-27）：`{ items: [...] }`；缺省 = 本卷无评析。 */
  assessments?: unknown[];
  /** 让这些路径片段的读面抛错（验证「读不出 ≠ 没有」）。 */
  failPaths?: string[];
}

function sheetFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SHEET_ID,
    user_id: "00000000-0000-4000-8000-000000000001",
    scope: "file",
    scope_key: "file:00000000-0000-4000-8000-000000000051:reading_choice",
    source_id: "00000000-0000-4000-8000-000000000051",
    question_type: "reading_choice",
    paper_id: null,
    status: "draft",
    answers: {},
    seal_mode: null,
    summary: null,
    sealed_at: null,
    created_at: "2026-09-27T00:00:00Z",
    updated_at: "2026-09-27T00:00:00Z",
    ...overrides,
  };
}

function gradingFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000061",
    user_id: "00000000-0000-4000-8000-000000000001",
    sheet_id: SHEET_ID,
    question_id: Q1,
    verdict: "wrong",
    analysis_md: "定位偏移：把举例当论点。",
    graded_by: "agent-a",
    graded_at: "2026-09-27T01:00:00Z",
    ...overrides,
  };
}

function annotationFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000071",
    user_id: "00000000-0000-4000-8000-000000000001",
    question_id: Q1,
    ordinal: 0,
    anchor_start: 20,
    anchor_end: 31,
    excerpt: "over the lazy",
    note: "与第 21 题同源",
    entry_tags: ["推断题"],
    option_tags: {},
    stage: "confirmed",
    sheet_id: null,
    review: null,
    review_sheet_id: null,
    status: "active",
    created_at: "2026-09-27T00:00:00Z",
    updated_at: "2026-09-27T00:00:00Z",
    ...overrides,
  };
}

function assessmentFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000081",
    user_id: "00000000-0000-4000-8000-000000000001",
    question_id: Q1,
    content_md: "判据：题干问的是主旨，不是举例。",
    last_editor: "owner",
    created_at: "2026-09-27T00:00:00Z",
    updated_at: "2026-09-27T00:00:00Z",
    ...overrides,
  };
}

function setupMock(options: MockOptions = {}): ReturnType<typeof vi.fn> {
  const attempts = options.attempts ?? [];
  const annotations = options.annotations ?? [];
  /** 读面失败的路径（2026-09-27）：抛错而不是回空 —— 「读不出」必须与「没有」分开。 */
  const failPaths = options.failPaths ?? [];
  return vi.fn(async (path: string, init?: { method?: string }) => {
    for (const fragment of failPaths) {
      if (String(path).includes(fragment)) throw new Error(`read failed: ${fragment}`);
    }
    if (path === "/l3/sheets" && (!init || init.method === "POST")) {
      return { sheet: sheetFixture({ status: options.sheetStatus ?? "draft", ...options.sheetOverrides }) };
    }
    if (String(path).startsWith("/l3/sheets/")) return { sheet: sheetFixture({ status: options.sheetStatus ?? "draft", ...options.sheetOverrides }), attempts };
    if (String(path).startsWith("/l3/attempts")) return { items: [] };
    if (String(path).includes("question-annotations")) return { items: annotations };
    if (String(path).includes("annotation-tags")) return { entry: [], option: [] };
    if (String(path).includes("question-assessments")) return { items: options.assessments ?? [] };
    if (String(path).includes("/assessment")) return { item: null };
    if (String(path).includes("/grading")) return { results: [gradingFixture()], gradableCount: 1 };
    if (String(path).includes("/writing-tasks")) return { items: [] };
    return {};
  }) as unknown as ReturnType<typeof vi.fn>;
}

const roots: Root[] = [];
let lastRoot: Root | null = null;
let lastExtra: Record<string, unknown> = {};

async function renderPaper(
  mode: ExamMode,
  flushes = 6,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  lastRoot = root;
  lastExtra = extra;
  await actRender(root, mode, flushes);
}

async function switchMode(mode: ExamMode, flushes = 6): Promise<void> {
  if (!lastRoot) throw new Error("switchMode 必须在 renderPaper 之后调用");
  await actRender(lastRoot, mode, flushes);
}

async function actRender(root: Root, mode: ExamMode, flushes: number): Promise<void> {
  await act(async () => {
    root.render(createElement(L3ExamPaper, { paper, onBack: vi.fn(), mode, ...lastExtra }) as ReactElement);
    for (let i = 0; i < flushes; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  (apiFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(setupMock());
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  lastRoot = null;
  lastExtra = {};
  document.body.innerHTML = "";
  (apiFetch as unknown as ReturnType<typeof vi.fn>).mockReset();
});

/** 选一个选项（做题档唯一允许写的动作）。 */
async function pickOption(label: RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await Promise.resolve();
  });
}

describe("B3 · 三档渲染（照表）", () => {
  it("纯净档：答案面全隐（无 evidence 高亮 / 无判定色 / 无解析 / 无评卷判读）", async () => {
    await renderPaper("pure");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    expect(document.querySelector('[data-evidence]')).toBeNull();
    expect(document.querySelector('[data-option-key="B"]')!.textContent).not.toContain("✓");
    expect(screen.queryByText("解析")).toBeNull();
    expect(screen.queryByText(/评卷：/)).toBeNull();
  });

  it("做题档：痕迹显、答案面隐、已选可见", async () => {
    await renderPaper("practice");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    await pickOption(/sleeps/);
    expect(document.querySelector('[data-option-key="B"][data-selected="true"]')).toBeTruthy();
    // 答案面仍隐
    expect(document.querySelector('[data-evidence]')).toBeNull();
    expect(screen.queryByText("解析")).toBeNull();
  });

  it("解析档：答案面全显、只读陈列（不可改选）", async () => {
    await renderPaper("review");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    expect(document.querySelector('[data-evidence]')).toBeTruthy();
    // 正确答案 B 的徽标显示 ✓（判定色无 data 属性，按徽标字符断言）
    const optionB = document.querySelector('[data-option-key="B"]')!;
    expect(optionB.textContent).toContain("✓");
    expect(screen.getAllByText(/解析|词义辨析/).length).toBeGreaterThan(0);
    // G-3：只读 —— 选项按钮 disabled
    expect((screen.getByRole("button", { name: /sleeps/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("G-1：纯净档无写入口（选项不可点）", async () => {
    await renderPaper("pure");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    expect((screen.getByRole("button", { name: /jumps/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("B3 · 用户痕迹（划重点 / 注记）与纯净档", () => {
  /**
   * draft 题纸的 `answers` jsonb（含划重点）。**必须走这条路**：attempts 只在 sealed
   * 派生里读（`applyDerived`），draft 恢复读的是题纸 answers（`restoreDraftAnswers`）。
   */
  const markedAnswers = {
    [Q1]: { choice: "B", marks: [{ scope: "passage", start: 4, end: 15, quote: "quick brown fox" }] },
  };
  const markedSheet = { answers: markedAnswers };

  it("做题档：用户划重点与注记锚点都渲染", async () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      setupMock({ sheetOverrides: markedSheet, annotations: [annotationFixture()] }),
    );
    await renderPaper("practice");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    await waitFor(() => expect(document.querySelector('[data-passage-mark]')).toBeTruthy());
    expect(document.querySelector('[data-ann-id]')).toBeTruthy();
  });

  it("G-2 纯净档：痕迹全隐 + **必须**给出隐藏声明条（否则用户以为丢了）", async () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      setupMock({ sheetOverrides: markedSheet, annotations: [annotationFixture()] }),
    );
    await renderPaper("pure");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    // 痕迹确实被藏了
    expect(document.querySelector('[data-passage-mark]')).toBeNull();
    expect(document.querySelector('[data-ann-id]')).toBeNull();
    // 且被如实告知
    const notice = screen.getByTestId("exam-mode-hidden-notice");
    expect(notice.textContent).toContain("1 处高亮");
    expect(notice.textContent).toContain("1 条注记");
    expect(notice.textContent).toContain("1 处已选作答");
  });

  it("G-2 反向：无痕迹的纯净档不出声明条（不显示「已隐藏 0 处」）", async () => {
    await renderPaper("pure");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    expect(screen.queryByTestId("exam-mode-hidden-notice")).toBeNull();
  });

  it("评析（2026-09-27 批量读面）：纯净档隐藏评析且声明条报出条数；解析档照常给出", async () => {
    const assessments = [assessmentFixture({ content_md: "定位偏移：把举例当论点。" })];
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      setupMock({ sheetOverrides: markedSheet, annotations: [annotationFixture()], assessments }),
    );
    await renderPaper("pure");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    // 断言「行」而不是正文：评析默认折叠，正文在**任何档**都不渲染 —— 拿正文做断言
    // 会让纯档那条恒真（等于没测）。行上的「已沉淀」徽标才是可见判据。
    expect(screen.queryByText(/评析 · 已沉淀/)).toBeNull();
    // 且如实告知藏了几条 —— 这是 S-1 的核心：数不出就不敢藏，能数出就必须说
    const notice = screen.getByTestId("exam-mode-hidden-notice");
    expect(notice.textContent).toContain("1 条评析");

    // 同一份数据在解析档直出（计数与渲染同源，不会出现「声明说藏了、切回来没有」）
    switchMode("review");
    await waitFor(() => expect(screen.getByText(/评析 · 已沉淀/)).toBeTruthy());
  });

  it("评析读面只发一次批量请求（不是每题一个 GET）", async () => {
    const apiFetchMock = setupMock({ assessments: [assessmentFixture()] }) as unknown as ReturnType<typeof vi.fn>;
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(apiFetchMock);
    await renderPaper("review");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    const batchCalls = apiFetchMock.mock.calls.filter(([path]) => String(path).includes("question-assessments"));
    const singleCalls = apiFetchMock.mock.calls.filter(([path]) => /questions\/.+\/assessment/.test(String(path)));
    expect(batchCalls).toHaveLength(1);
    expect(singleCalls).toHaveLength(0);
  });
});

/**
 * 痕迹读面失败（2026-09-27）——「读不出」必须与「没有」分开。
 *
 * 两处危害，都不是 UI 小疵：
 *  1. 谎报空态：「原文分析 · 0」/「还没有评析」是关于用户自己劳动的**假陈述**
 *     （F-1/F-2 族：行为合理但未言明 ⇒ 后来者误判为缺陷并「修复」）。
 *  2. 数据丢失：评析 PUT 是 latest-wins upsert。读失败时若仍给「写评析」入口，
 *     用户在没看到旧内容的情况下就把它覆盖了。
 */
describe("B6 · 读失败 ≠ 没有（痕迹读面降级）", () => {
  it("评析读失败：显示「未能读取 · 重读评析」，不谎报待沉淀，且**没有写入口**", async () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      setupMock({ failPaths: ["question-assessments"] }),
    );
    await renderPaper("review");
    await waitFor(() => expect(screen.getAllByText(/评析 · 未能读取/).length).toBeGreaterThan(0));

    // 危害 2：upsert 会覆盖未读到的旧内容 ⇒ 任何写入口都不能给
    expect(screen.queryByRole("button", { name: "写评析" })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存评析" })).toBeNull();
    // 危害 1：不能显示成「还没有评析」
    expect(screen.queryByText(/评析 · 待沉淀/)).toBeNull();
    // 给一个出口，而不是让用户只能刷新整页
    expect(screen.getAllByRole("button", { name: "重读评析" }).length).toBeGreaterThan(0);
  });

  it("注记读失败：显示「未能读取 · 重读原文分析」，不谎报 · 0，且不给新建入口", async () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      setupMock({ failPaths: ["question-annotations"] }),
    );
    await renderPaper("review");
    await waitFor(() => expect(screen.getAllByText(/原文分析 · 未能读取/).length).toBeGreaterThan(0));

    expect(screen.queryByText(/原文分析 · 0/)).toBeNull();
    // 往一个看不见的集合里追加，追加完的计数仍是假的 ⇒ 不给入口
    expect(screen.queryByRole("button", { name: /新建|写注记|添加注记/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: "重读原文分析" }).length).toBeGreaterThan(0);
  });

  it("纯净档 + 读失败：声明条明说「未能读取」，不把数不出当 0（否则是静默隐藏）", async () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      setupMock({ failPaths: ["question-annotations", "question-assessments"] }),
    );
    await renderPaper("pure");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    const notice = screen.getByTestId("exam-mode-hidden-notice");
    expect(notice.textContent).toContain("未能读取");
    expect(notice.textContent).toContain("未计入其中");
    expect(notice.textContent).not.toContain("0 条评析");
    expect(notice.textContent).not.toContain("0 条注记");
  });

  it("重试真的重发读面（不是装饰按钮）", async () => {
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>;
    mock.mockImplementation(setupMock({ failPaths: ["question-assessments"] }));
    await renderPaper("review");
    await waitFor(() => expect(screen.getAllByText(/评析 · 未能读取/).length).toBeGreaterThan(0));
    const before = mock.mock.calls.filter(([p]) => String(p).includes("question-assessments")).length;

    // 换成读得到的 mock 再点重试：effect 依赖 nonce，必须真的重发
    mock.mockImplementation(setupMock({ assessments: [assessmentFixture()] }));
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "重读评析" })[0]!);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    await waitFor(() => expect(screen.getAllByText(/评析 · 已沉淀/).length).toBeGreaterThan(0));
    const after = mock.mock.calls.filter(([p]) => String(p).includes("question-assessments")).length;
    expect(after).toBe(before + 1);
  });
});

describe("B3 · G-4 往返不丢作答", () => {
  it("做题档选中 → 切纯净 → 回解析：选中态与判定结论都还在", async () => {
    await renderPaper("practice");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    // 选**错**项（jumps / A，正确答案是 B）——解析档才有可判的「错选」。
    await pickOption(/jumps/);
    expect(document.querySelector('[data-option-key="A"][data-selected="true"]')).toBeTruthy();

    await switchMode("pure");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    await switchMode("review");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    // 作答没被模式切换冲掉：解析档下仍能判它是错选（✕）
    expect(document.querySelector('[data-option-key="A"]')!.textContent).toContain("✕");
    expect(document.querySelector('[data-option-key="B"]')!.textContent).toContain("✓");
  });
});

describe("B3 · G-7 切换器只在有意义处", () => {
  it("传了 onModeChange：渲染三档切换器，点击回调带上目标档", async () => {
    const seen: ExamMode[] = [];
    await renderPaper("practice", 6, { onModeChange: (next: ExamMode) => seen.push(next) });
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    expect(screen.getByTestId("exam-mode-switcher")).toBeTruthy();
    expect((screen.getByTestId("exam-mode-practice") as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("exam-mode-review"));
    expect(seen).toEqual(["review"]);
  });

  it("未传 onModeChange（宿主没接 URL 通道）：不渲染切换器", async () => {
    await renderPaper("practice");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    expect(screen.queryByTestId("exam-mode-switcher")).toBeNull();
  });
});
