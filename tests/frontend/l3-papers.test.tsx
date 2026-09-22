/// <reference lib="dom" />
// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { L3PapersPage } from "@/frontend/components/l3/L3PapersPage";

// 与 l3-bookshelf.test.tsx 同款手动挂载（仓库无 @testing-library/react）。

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));
// I3：fileKey 作文入口经 writingClient（批量摘要 + 显式创建）；页面测试按调用断言。
vi.mock("@/frontend/api/writingClient", () => ({
  writingClient: { questionSummaries: vi.fn(), createTask: vi.fn() },
}));
import { apiFetch } from "@/frontend/api/client";
import { writingClient } from "@/frontend/api/writingClient";
import { parseWritingSearch } from "@/frontend/viewModels/writingNavigation";

const SOURCE_ID = "00000000-0000-4000-8000-000000000002";
const QUESTION_ID = "00000000-0000-4000-8000-000000000101";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom 不提供 IntersectionObserver（做题表面节导航观察器，同 exam-sheet 先例）。
class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] { return []; }
}
(globalThis as Record<string, unknown>).IntersectionObserver ??= IntersectionObserverStub;

const mountedRoots: Root[] = [];

/** 路由位置探针（I3：断言入口导航目标 URL）。 */
function LocationProbe() {
  const location = useLocation();
  return createElement("div", { "data-testid": "loc" }, `${location.pathname}${location.search}`);
}

const locText = (): string => screen.getByTestId("loc").textContent ?? "";

async function renderPage(props: Record<string, unknown> = {}, opts: { strict?: boolean } = {}): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    // W7：做题台组件现含 useNavigate（作文入口/深链）——统一包 Router 提供上下文。
    const tree = createElement(
      "div",
      null,
      createElement(LocationProbe),
      createElement(L3PapersPage, props as never),
    );
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/l3"] },
        opts.strict ? createElement(StrictMode, null, tree) : tree,
      ) as ReactElement,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

beforeEach(() => {
  (apiFetch as ReturnType<typeof vi.fn>).mockReset();
  addToastMock.mockReset();
  (writingClient.questionSummaries as ReturnType<typeof vi.fn>).mockReset();
  (writingClient.createTask as ReturnType<typeof vi.fn>).mockReset();
});

// ── 夹具与分派式 mock ───────────────────────────────────────────────────────
// 文件详情自批次二补齐起 source 型走做题表面（L3ExamPaper）：挂载即并发拉
// sheets/attempts/annotations/tags——序列式 mock 极易错位，这里按路径分派。
const fileItem = (overrides: Record<string, unknown> = {}) => ({
  question_type: "reading_choice",
  source_id: SOURCE_ID,
  file_key: null,
  title: "2025 英语二 · Text 1 小费文化",
  direction: "考研",
  question_count: 5,
  latest_created_at: "2026-09-16T00:00:00Z",
  ...overrides,
});

const questionFixture = (stem: string) => ({
  id: QUESTION_ID, ordinal: 0, stem,
  options: [{ key: "A", text: "选项 A" }], answer: { choice: "A" },
  explanation: null, evidence: [],
});

function setupMock(options: { files?: unknown[]; detail?: Record<string, unknown> } = {}) {
  const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
  const sheet = {
    id: "00000000-0000-4000-8000-000000000401",
    user_id: "00000000-0000-4000-8000-000000000001",
    scope: "file",
    scope_key: `file:${SOURCE_ID}:reading_choice`,
    source_id: SOURCE_ID,
    question_type: "reading_choice",
    paper_id: null,
    status: "draft",
    answers: {},
    seal_mode: null,
    summary: null,
    sealed_at: null,
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
  };
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/l3/papers?")) return { items: [] };
    if (path.startsWith("/l3/practice-files?")) return { items: options.files ?? [] };
    if (path.startsWith("/l3/practice-files/detail?")) return options.detail ?? {};
    if (path === "/l3/sheets") return { sheet };
    if (path.startsWith("/l3/attempts")) return { items: [] };
    if (path.startsWith("/l3/question-annotations")) return { items: [] };
    if (path === "/l3/annotation-tags") return { entry: [], option: [] };
    return {};
  });
  return apiFetchMock;
}

describe("L3PapersPage 题型空间", () => {
  it("全景 → 单专题文件列表 → 文件详情接入做题表面（file venue 题纸）", async () => {
    const apiFetchMock = setupMock({
      files: [fileItem()],
      detail: {
        question_type: "reading_choice",
        source: { id: SOURCE_ID, title: "2025 英语二 · Text 1 小费文化" },
        source_content: "The passage.",
        file_key: null,
        questions: [questionFixture("21. 题干")],
      },
    });

    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "题型空间" }));
    });
    // 全景：七张专题卡片，阅读空间显示收录统计
    await waitFor(() => expect(screen.getByText(/七个题型专题/)).toBeTruthy());
    expect(screen.getByText(/1 个文件/)).toBeTruthy();
    expect(screen.getAllByText(/暂无真题文件/)).toHaveLength(6); // 除阅读外六个空空间

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /阅读理解/ }));
    });
    // 单空间：文件列表（前端按题型过滤，无额外请求）
    await waitFor(() => expect(screen.getByText(/2025 英语二 · Text 1 小费文化/)).toBeTruthy());
    const filesCall = apiFetchMock.mock.calls.find(([path]) => String(path).includes("/l3/practice-files?"));
    expect(String(filesCall![0])).toContain("/l3/practice-files?limit=100");

    await act(async () => {
      fireEvent.click(screen.getByText(/2025 英语二 · Text 1 小费文化/));
    });
    // 做题表面：题纸自动开（scope=file）+ 题干渲染 + 返回题型空间入口
    await waitFor(() => expect(screen.getByText("21. 题干")).toBeTruthy());
    expect(screen.getByText("题纸")).toBeTruthy();
    expect(screen.getByText("← 返回题型空间")).toBeTruthy();
    expect(screen.getByText("定格题纸")).toBeTruthy();
    const openSheetCall = apiFetchMock.mock.calls.find(([path, init]) =>
      String(path) === "/l3/sheets" && (init as RequestInit | undefined)?.method === "POST");
    expect(openSheetCall).toBeTruthy();
    expect(JSON.parse((openSheetCall![1] as RequestInit).body as string)).toEqual({
      scope: "file",
      sourceId: SOURCE_ID,
      questionType: "reading_choice",
    });
    const detailCall = apiFetchMock.mock.calls.find(([path]) => String(path).includes("/l3/practice-files/detail?"));
    expect(String(detailCall![0])).toContain("questionType=reading_choice");
    expect(String(detailCall![0])).toContain(`sourceId=${SOURCE_ID}`);
  });

  it("fileKey 型文件（无 source）保留浏览视图（含答案与解析）", async () => {
    setupMock({
      files: [fileItem({
        question_type: "sentence_translation",
        source_id: null,
        file_key: "translation-group-1",
        title: "翻译题组 A",
      })],
      detail: {
        question_type: "sentence_translation",
        source: null,
        source_content: null,
        file_key: "translation-group-1",
        questions: [{
          id: QUESTION_ID, ordinal: 0, stem: "46. 翻译题干",
          options: [], answer: { text: "参考译文" },
          explanation: "解析内容", evidence: [],
        }],
      },
    });

    await renderPage({ deepLinkVenue: "sentence_translation", deepLinkFile: "translation-group-1" });
    await waitFor(() => expect(screen.getByText("46. 翻译题干")).toBeTruthy());
    // 浏览视图特征：答案与解析直出；未走做题表面（无题纸/定格入口）——
    // fileKey 型不具备开纸条件（sheetOpenInputSchema 要求 sourceId）
    expect(screen.getByText(/答案：/)).toBeTruthy();
    expect(screen.queryByText("定格题纸")).toBeNull();
  });
});

describe("L3PapersPage 粘贴建卷", () => {
  it("提交 section × 题 × 选项/答案的结构化包并切回试卷列表", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    apiFetchMock
      // 初次挂载自动拉「我的试卷」列表
      .mockResolvedValueOnce({ items: [] })
      // 切到建卷 tab 后拉来源列表
      .mockResolvedValueOnce({ items: [{ id: SOURCE_ID, title: "2023 英一 Text 1" }] })
      // POST /l3/papers
      .mockResolvedValueOnce({ paper: { id: "paper-1" }, questions: [], questionCount: 1 })
      // 切回「我的试卷」后列表
      .mockResolvedValueOnce({ items: [] });

    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "粘贴建卷" }));
    });
    await waitFor(() => expect(screen.getByText("2023 英一 Text 1")).toBeTruthy());

    const sourceSelect = screen.getByText(/选择阅读材料/).closest("select") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/试卷标题/), { target: { value: "2023 英语一真题" } });
      fireEvent.change(screen.getByPlaceholderText(/节标题/), { target: { value: "Text 1" } });
      fireEvent.change(sourceSelect, { target: { value: SOURCE_ID } });
      fireEvent.change(screen.getByPlaceholderText("题干"), { target: { value: "21. 题干" } });
      fireEvent.change(screen.getByPlaceholderText("选项 A"), { target: { value: "选项 A 内容" } });
      fireEvent.click(screen.getByDisplayValue("A")); // 正确答案 radio
    });
    await act(async () => {
      fireEvent.click(screen.getByText("建卷"));
    });
    await waitFor(() => {
      const post = apiFetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "POST");
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.title).toBe("2023 英语一真题");
      expect(body.direction).toBe("考研");
      expect(body.sections[0]).toMatchObject({
        title: "Text 1",
        questionType: "reading_choice",
        sourceId: SOURCE_ID,
        fileKey: null,
      });
      expect(body.sections[0].questions[0].stem).toBe("21. 题干");
      expect(body.sections[0].questions[0].options).toEqual([{ key: "A", text: "选项 A 内容" }]);
      expect(body.sections[0].questions[0].answer).toEqual({ choice: "A" });
    });
    expect(addToastMock).toHaveBeenCalledWith("success", expect.stringContaining("已建卷"));
  });
});

describe("L3PapersPage 深链（批次二）", () => {
  it("?venue=&file= 直达题型空间并自动打开目标文件（做题表面）", async () => {
    const apiFetchMock = setupMock({
      files: [fileItem()],
      detail: {
        question_type: "reading_choice",
        source: { id: SOURCE_ID, title: "2025 英语二 · Text 1 小费文化" },
        source_content: "The passage.",
        file_key: null,
        questions: [questionFixture("21. 深链题干")],
      },
    });

    await renderPage({ deepLinkVenue: "reading_choice", deepLinkFile: SOURCE_ID });
    // 深链直达文件详情（无需手动切 tab / 点空间 / 点文件）——且已是做题表面
    await waitFor(() => expect(screen.getByText("21. 深链题干")).toBeTruthy());
    expect(screen.getByText("← 返回题型空间")).toBeTruthy();
    const detailCall = apiFetchMock.mock.calls.find(([path]) => String(path).includes("/l3/practice-files/detail?"));
    expect(String(detailCall![0])).toContain(`sourceId=${SOURCE_ID}`);
    expect(String(detailCall![0])).toContain("questionType=reading_choice");
    const openSheetCall = apiFetchMock.mock.calls.find(([path, init]) =>
      String(path) === "/l3/sheets" && (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse((openSheetCall![1] as RequestInit).body as string)).toMatchObject({ scope: "file" });
  });
});

// ── I3（B 批）：fileKey 作文入口——题组级一次批量摘要、三态按钮、显式创建与返回锚点 ──

describe("L3PapersPage fileKey 作文入口（I3）", () => {
  const Q1 = "00000000-0000-4000-8000-000000000101";
  const Q2 = "00000000-0000-4000-8000-000000000102";
  const Q3 = "00000000-0000-4000-8000-000000000103";
  const TASK_Q2 = "00000000-0000-4000-8000-000000000711";
  const SHEET_Q2 = "00000000-0000-4000-8000-000000000811";
  const SEALED_Q3 = "00000000-0000-4000-8000-000000000813";
  const TASK_NEW = "00000000-0000-4000-8000-000000000721";
  const SHEET_NEW = "00000000-0000-4000-8000-000000000821";

  const essayFile = () => fileItem({
    question_type: "short_essay",
    source_id: null,
    file_key: "writing-short-1",
    title: "小作文题组 A",
    direction: "考研",
    question_count: 3,
  });
  const essayDetail = (ids: string[]) => ({
    question_type: "short_essay",
    source: null,
    source_content: null,
    file_key: "writing-short-1",
    questions: ids.map((id, index) => ({
      id, ordinal: index, stem: `作文题 ${index + 1}`, options: [],
      answer: { sample: "样文" }, explanation: null, evidence: [],
    })),
  });
  const taskSummary = (overrides: Record<string, unknown> = {}) => ({
    taskId: TASK_Q2, taskStatus: "active",
    draftSheetId: null, latestSubmittedSheetId: null,
    latestRevisionNo: null, revisionCount: 0,
    feedbackState: null, contentStatus: null,
    ...overrides,
  });
  const summariesMock = () => writingClient.questionSummaries as ReturnType<typeof vi.fn>;

  it("题组级一次批量摘要；尚未开始/有草稿/已提交三态；继续与开始均带 origin（开始才 createTask）", async () => {
    setupMock({ files: [essayFile()], detail: essayDetail([Q1, Q2, Q3]) });
    summariesMock().mockResolvedValue({ items: [
      { questionId: Q1, tasks: [] },
      { questionId: Q2, tasks: [taskSummary({ draftSheetId: SHEET_Q2 })] },
      {
        questionId: Q3,
        tasks: [taskSummary({
          latestSubmittedSheetId: SEALED_Q3, latestRevisionNo: 1, revisionCount: 1,
          feedbackState: "pending", contentStatus: "available",
        })],
      },
    ] });

    await renderPage({ deepLinkVenue: "short_essay", deepLinkFile: "writing-short-1" });
    await waitFor(() => expect(screen.getByRole("button", { name: "继续写作" })).toBeTruthy());

    // 一次集合读取：全部题一次下传（按钮不自取整套；非逐题 N 次）
    expect(summariesMock()).toHaveBeenCalledTimes(1);
    expect(summariesMock().mock.calls[0]![0]).toEqual([Q1, Q2, Q3]);
    expect(summariesMock().mock.calls[0]![1]).toEqual({ kind: "whole", direction: "考研" });
    expect(screen.getByRole("button", { name: "开始写作" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看本稿" })).toBeTruthy();

    // 继续：按已知 ID 只读导航（零创建）+ origin 保留
    fireEvent.click(screen.getByRole("button", { name: "继续写作" }));
    await waitFor(() => expect(locText()).toContain(`writingTaskId=${TASK_Q2}`));
    const continued = new URLSearchParams(locText().split("?")[1]);
    expect(continued.get("sheet")).toBe(SHEET_Q2);
    expect(parseWritingSearch(continued).origin).toMatchObject({
      kind: "file", questionId: Q2, questionType: "short_essay", fileKey: "writing-short-1",
    });
    expect(writingClient.createTask).not.toHaveBeenCalled();

    // 开始：显式 createTask（唯一写入路径）→ 直达工作区（sheet+draft、origin 指向本题）
    (writingClient.createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      task: { id: TASK_NEW }, draft: { id: SHEET_NEW }, created: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    await waitFor(() => expect(locText()).toContain(`writingTaskId=${TASK_NEW}`));
    expect(writingClient.createTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: "whole", direction: "考研", questionId: Q1, requestId: expect.any(String),
    }));
    const started = new URLSearchParams(locText().split("?")[1]);
    expect(started.get("sheet")).toBe(SHEET_NEW);
    expect(parseWritingSearch(started).origin?.questionId).toBe(Q1);
  });

  it("?question= 返回原题：高亮目标题；重进重新读取进度（不沿用进入前的尚未开始）", async () => {
    setupMock({ files: [essayFile()], detail: essayDetail([Q1, Q2]) });
    summariesMock().mockResolvedValueOnce({ items: [
      { questionId: Q1, tasks: [] },
      { questionId: Q2, tasks: [] },
    ] });

    await renderPage({ deepLinkVenue: "short_essay", deepLinkFile: "writing-short-1", deepLinkQuestion: Q1 });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "开始写作" })).toHaveLength(2));
    expect(document.querySelector(`[data-question-id="${Q1}"]`)?.getAttribute("data-focused")).toBe("true");
    expect(document.querySelector(`[data-question-id="${Q2}"]`)?.getAttribute("data-focused")).toBeNull();

    // 「进入写作保存草稿后返回」= 重挂载：第二次读取反映最新进度（Q1 → 继续）
    act(() => { for (const root of mountedRoots.splice(0)) root.unmount(); });
    document.body.innerHTML = "";
    summariesMock().mockResolvedValueOnce({ items: [
      { questionId: Q1, tasks: [taskSummary({ draftSheetId: SHEET_Q2 })] },
      { questionId: Q2, tasks: [] },
    ] });
    await renderPage({ deepLinkVenue: "short_essay", deepLinkFile: "writing-short-1", deepLinkQuestion: Q1 });
    await waitFor(() => expect(screen.getByRole("button", { name: "继续写作" })).toBeTruthy());
    expect(summariesMock()).toHaveBeenCalledTimes(2);
    const q1 = document.querySelector(`[data-question-id="${Q1}"]`)!;
    expect(Array.from(q1.querySelectorAll("button")).map((b) => b.textContent)).toContain("继续写作");
  });

  it("摘要读取失败：显示重试（不冒充「尚未开始」）；重试触发第二次读取", async () => {
    setupMock({ files: [essayFile()], detail: essayDetail([Q1]) });
    summariesMock().mockRejectedValueOnce(new Error("boom"));

    await renderPage({ deepLinkVenue: "short_essay", deepLinkFile: "writing-short-1" });
    await waitFor(() => expect(screen.getByText(/进度读取失败/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "开始写作" })).toBeNull();

    summariesMock().mockResolvedValueOnce({ items: [{ questionId: Q1, tasks: [] }] });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "开始写作" })).toBeTruthy());
    expect(summariesMock()).toHaveBeenCalledTimes(2);
  });
});

// ── I3/C：原卷作文入口（整卷/source 文件/回看）＋ 跳转前保存屏障 ＋ 返回恢复 ──

describe("I3/C 原卷作文入口与返回恢复", () => {
  const Q_CHOICE = "00000000-0000-4000-8000-0000000001c0";
  const PAPER_1 = "00000000-0000-4000-8000-0000000009a1";
  const PAPER_2 = "00000000-0000-4000-8000-0000000009a2";
  const Q_ESSAY = "00000000-0000-4000-8000-0000000001c1";
  const TASK_W = "00000000-0000-4000-8000-0000000007c1";
  const SHEET_W = "00000000-0000-4000-8000-0000000008c1";
  const PAPER_SHEET = "00000000-0000-4000-8000-0000000008c2";
  const PAPER_SHEET_B = "00000000-0000-4000-8000-0000000008c5";
  const RESUME_DRAFT = "00000000-0000-4000-8000-0000000008c4";
  const RESUME_SEALED = "00000000-0000-4000-8000-0000000008c3";
  const MISSING_SHEET = "00000000-0000-4000-8000-0000000008c9";

  const essayFile = () => fileItem({
    question_type: "short_essay", source_id: SOURCE_ID, file_key: null,
    title: "合成来源 · 小作文文件", direction: "考研", question_count: 1,
  });
  const essaySourceDetail = () => ({
    question_type: "short_essay",
    source: { id: SOURCE_ID, title: "合成来源 · 小作文文件" },
    source_content: null, file_key: null,
    questions: [{ id: Q_ESSAY, ordinal: 0, stem: "47. 小作文题干", options: [], answer: { sample: "范文" }, explanation: null, evidence: [] }],
  });
  const sheetRow = (overrides: Record<string, unknown> = {}) => ({
    id: PAPER_SHEET, user_id: "00000000-0000-4000-8000-000000000001",
    scope: "paper", scope_key: "paper:paper-1", source_id: null, question_type: null, paper_id: "paper-1",
    status: "draft", answers: {}, seal_mode: null, summary: null, sealed_at: null,
    created_at: "2026-09-19T00:00:00Z", updated_at: "2026-09-19T00:00:00Z", ...overrides,
  });
  const essayPaper = (id = PAPER_1) => ({
    id, title: `合成试卷 ${id}`, direction: "考研", metadata: {},
    sections: [
      {
        key: "s1", title: "阅读", questionType: "reading_choice", sourceId: null, fileKey: null,
        questionIds: [Q_CHOICE], missing: false, source_title: null, source_content: null,
        questions: [{
          id: Q_CHOICE, ordinal: 0, stem: "1. 客观题干",
          options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }],
          answer: { choice: "B" }, explanation: null, evidence: [],
        }],
      },
      {
        key: "s2", title: "写作", questionType: "short_essay", sourceId: null, fileKey: null,
        questionIds: [Q_ESSAY], missing: false, source_title: null, source_content: null,
        questions: [{ id: Q_ESSAY, ordinal: 0, stem: "47. 小作文题干", options: [], answer: { sample: "范文" }, explanation: null, evidence: [] }],
      },
    ],
  });
  const translationPaper = () => ({
    id: "paper-1", title: "翻译合成卷", direction: "考研", metadata: {},
    sections: [{
      key: "t1", title: "翻译", questionType: "sentence_translation", sourceId: null, fileKey: null,
      questionIds: [Q_ESSAY], missing: false, source_title: null, source_content: null,
      questions: [{ id: Q_ESSAY, ordinal: 0, stem: "46. 翻译题干", options: [], answer: { text: "参考译文" }, explanation: null, evidence: [] }],
    }],
  });

  function setupEssayMock(options: {
    files?: unknown[];
    detail?: Record<string, unknown>;
    paper?: unknown;
    openSheet?: unknown;
    fetchSheets?: Record<string, unknown | null>;
  } = {}) {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path.startsWith("/l3/papers?")) return { items: [] };
      if (path.startsWith("/l3/papers/")) return options.paper ?? essayPaper();
      if (path === "/l3/sheets" && method === "POST") return { sheet: options.openSheet ?? sheetRow() };
      if (path.startsWith("/l3/sheets/") && method === "PATCH") return { sheet: sheetRow({ answers: {} }) };
      if (path.startsWith("/l3/sheets/") && method === "GET") {
        const id = path.split("/").pop()!;
        const hit = options.fetchSheets?.[id];
        if (hit === undefined) return { sheet: sheetRow({ id }), attempts: [] };
        if (hit === null) throw new Error("sheet missing");
        return { sheet: hit, attempts: [] };
      }
      if (path.startsWith("/l3/attempts")) return { items: [] };
      if (path.startsWith("/l3/question-annotations")) return { items: [] };
      if (path === "/l3/annotation-tags") return { entry: [], option: [] };
      if (path.startsWith("/l3/practice-files?")) return { items: options.files ?? [] };
      if (path.startsWith("/l3/practice-files/detail?")) return options.detail ?? {};
      throw new Error(`unmocked: ${path}`);
    });
    return apiFetchMock;
  }
  const summariesMock = () => writingClient.questionSummaries as ReturnType<typeof vi.fn>;
  const createTaskMock = () => writingClient.createTask as ReturnType<typeof vi.fn>;
  const patchCalls = () => (apiFetch as ReturnType<typeof vi.fn>).mock.calls
    .filter(([p, i]) => String(p).startsWith("/l3/sheets/") && (i as RequestInit | undefined)?.method === "PATCH");

  it("整卷草稿：题组级一次批量摘要 + 「专项练习（不计入本次试卷作答）」；开始 → paper origin（含当前题纸）", async () => {
    setupEssayMock();
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_ESSAY, tasks: [] }] });
    createTaskMock().mockResolvedValue({ task: { id: TASK_W }, draft: { id: SHEET_W }, created: true });

    await renderPage({ deepLinkPaper: PAPER_1 });
    await waitFor(() => expect(screen.getByText("专项练习（不计入本次试卷作答）")).toBeTruthy());

    // 一次集合读取（仅 essay 题；方向=卷方向）
    expect(summariesMock()).toHaveBeenCalledTimes(1);
    expect(summariesMock().mock.calls[0]![0]).toEqual([Q_ESSAY]);
    expect(summariesMock().mock.calls[0]![1]).toEqual({ kind: "whole", direction: "考研" });
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    await waitFor(() => expect(locText()).toContain(`writingTaskId=${TASK_W}`));
    expect(createTaskMock()).toHaveBeenCalledWith(expect.objectContaining({ questionId: Q_ESSAY, kind: "whole", direction: "考研" }));
    const origin = parseWritingSearch(new URLSearchParams(locText().split("?")[1])).origin;
    expect(origin).toMatchObject({ kind: "paper", paperId: PAPER_1, questionId: Q_ESSAY, sheetId: PAPER_SHEET });
  });

  it("翻译题不渲染作文入口（零摘要请求）", async () => {
    setupEssayMock({ paper: translationPaper() });
    await renderPage({ deepLinkPaper: PAPER_1 });
    await waitFor(() => expect(screen.getByText("46. 翻译题干")).toBeTruthy());
    expect(screen.queryByText("专项练习（不计入本次试卷作答）")).toBeNull();
    expect(summariesMock()).not.toHaveBeenCalled();
  });

  it("source 文件题纸：入口在卷内 + ?question= 定位高亮 + file origin（sourceId）", async () => {
    setupEssayMock({
      files: [essayFile()],
      detail: essaySourceDetail(),
      openSheet: sheetRow({ id: PAPER_SHEET, scope: "file", scope_key: `file:${SOURCE_ID}:short_essay`, source_id: SOURCE_ID, question_type: "short_essay", paper_id: null }),
    });
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_ESSAY, tasks: [] }] });
    createTaskMock().mockResolvedValue({ task: { id: TASK_W }, draft: { id: SHEET_W }, created: true });

    await renderPage({ deepLinkVenue: "short_essay", deepLinkFile: SOURCE_ID, deepLinkQuestion: Q_ESSAY });
    await waitFor(() => expect(screen.getByText("专项练习（不计入本次试卷作答）")).toBeTruthy());
    const anchor = document.getElementById(`question-${Q_ESSAY}`);
    expect(anchor?.getAttribute("data-focused")).toBe("true");
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    await waitFor(() => expect(locText()).toContain("writingTaskId"));
    const origin = parseWritingSearch(new URLSearchParams(locText().split("?")[1])).origin;
    expect(origin).toMatchObject({ kind: "file", sourceId: SOURCE_ID, questionId: Q_ESSAY, sheetId: PAPER_SHEET });
  });

  it("保存屏障成功路径：慢 PATCH 在途 + 之后又有新选中 → 二次 flush 全确认后才跳转", async () => {
    setupEssayMock();
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_ESSAY, tasks: [] }] });
    createTaskMock().mockResolvedValue({ task: { id: TASK_W }, draft: { id: SHEET_W }, created: true });

    await renderPage({ deepLinkPaper: PAPER_1 });
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    // 第一个 PATCH 挂起（慢保存）
    let resolveFirstPatch!: (value: unknown) => void;
    const firstPatch = new Promise((resolve) => { resolveFirstPatch = resolve; });
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    const base = apiFetchMock.getMockImplementation()!;
    let patchCount = 0;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (String(path).startsWith("/l3/sheets/") && init?.method === "PATCH") {
        patchCount += 1;
        if (patchCount === 1) return firstPatch;
        return { sheet: sheetRow({ answers: {} }) };
      }
      return base(path, init);
    });

    fireEvent.click(screen.getByRole("button", { name: /甲/ })); // 第一次选中
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); }); // 防抖到期 → PATCH#1 在途
    expect(patchCount).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /乙/ })); // 在途期间又有新选中

    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    await act(async () => { await Promise.resolve(); }); // 屏障进入等待（在途 PATCH）
    expect(createTaskMock()).not.toHaveBeenCalled(); // 未确认前不创建
    resolveFirstPatch({ sheet: sheetRow({ answers: {} }) }); // PATCH#1 完成
    await waitFor(() => expect(patchCount).toBe(2)); // 覆盖等待期间新输入的第二次 flush
    await waitFor(() => expect(locText()).toContain(`writingTaskId=${TASK_W}`));
    expect(createTaskMock()).toHaveBeenCalledTimes(1);
    // 两批内容都发出去了（甲先、乙后）
    const bodies = patchCalls().map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies[0].answers[Q_CHOICE]).toMatchObject({ choice: "A" });
    expect(bodies[1].answers[Q_CHOICE]).toMatchObject({ choice: "B" });
  });

  it("保存屏障失败：PATCH 失败 → 留页保留正文、不创建任务、显式提示", async () => {
    setupEssayMock();
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_ESSAY, tasks: [] }] });
    createTaskMock().mockResolvedValue({ task: { id: TASK_W }, draft: null, created: true });

    await renderPage({ deepLinkPaper: PAPER_1 });
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());

    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      // 整合后语义：无 status 的错误按网络故障自动重试（1/2/4s 退避）；本用例以服务端
      // 不可重试拒绝（422）固定失败路径，验证「失败 → 留页 → 显式提示」的确定行为。
      if (String(path).startsWith("/l3/sheets/") && init?.method === "PATCH") {
        throw Object.assign(new Error("save failed"), { status: 422 });
      }
      return base(path, init);
    });

    fireEvent.click(screen.getByRole("button", { name: /甲/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("error", expect.stringMatching(/暂不能离开|尚未保存成功/)));
    expect(createTaskMock()).not.toHaveBeenCalled();
    expect(locText()).not.toContain("writingTaskId=");
  });

  it("resume（source 文件·draft）：按 ID 读面可编辑；零 openSheet 新开", async () => {
    setupEssayMock({
      files: [essayFile()],
      detail: essaySourceDetail(),
      fetchSheets: {
        [RESUME_DRAFT]: sheetRow({ id: RESUME_DRAFT, scope: "file", scope_key: `file:${SOURCE_ID}:short_essay`, source_id: SOURCE_ID, question_type: "short_essay", paper_id: null, status: "draft" }),
      },
      openSheet: null as never,
    });
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_ESSAY, tasks: [] }] });

    await renderPage({ deepLinkVenue: "short_essay", deepLinkFile: SOURCE_ID, deepLinkQuestion: Q_ESSAY, deepLinkResumeSheet: RESUME_DRAFT });
    await waitFor(() => expect(screen.getByText("专项练习（不计入本次试卷作答）")).toBeTruthy());
    // 零 openSheet：POST /l3/sheets 未被调用
    const posts = (apiFetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([p, i]) => String(p) === "/l3/sheets" && (i as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(0);
    // Task C：卷面不再渲染无持久化链的可编辑输入框（作答与可编辑性在作文空间）
    expect(screen.queryByPlaceholderText(/在这里写作文/)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("resume（paper·sealed）：同 ID 只读；零 openSheet；不显示可编辑假象", async () => {
    setupEssayMock({
      fetchSheets: {
        [RESUME_SEALED]: sheetRow({ id: RESUME_SEALED, paper_id: PAPER_1, scope_key: `paper:${PAPER_1}`, status: "sealed", sealed_at: "2026-09-19T01:00:00Z" }),
      },
    });
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_ESSAY, tasks: [{ taskId: TASK_W, taskStatus: "active", draftSheetId: null, latestSubmittedSheetId: SHEET_W, latestRevisionNo: 1, revisionCount: 1, feedbackState: "pending", contentStatus: "available" }] }] });

    await renderPage({ deepLinkPaper: PAPER_1, deepLinkQuestion: Q_ESSAY, deepLinkResumeSheet: RESUME_SEALED });
    await waitFor(() => expect(screen.getByText("专项练习（不计入本次试卷作答）")).toBeTruthy());
    const posts = (apiFetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([p, i]) => String(p) === "/l3/sheets" && (i as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(0);
    // Task C：卷面无输入框（不存在可编辑假象；只读纪律由无输入框与揭示纪律承担）
    expect(screen.queryByRole("textbox")).toBeNull();
    // 入口显示精确 sealed 稿状态（查看本稿）
    expect(screen.getByRole("button", { name: "查看本稿" })).toBeTruthy();
  });

  it("resume 不可达：明确提示并停留来源列表（不打开详情、不建纸）", async () => {
    setupEssayMock({
      files: [essayFile()],
      detail: essaySourceDetail(),
      fetchSheets: { [MISSING_SHEET]: null },
    });
    summariesMock().mockResolvedValue({ items: [] });

    await renderPage({ deepLinkVenue: "short_essay", deepLinkFile: SOURCE_ID, deepLinkQuestion: Q_ESSAY, deepLinkResumeSheet: MISSING_SHEET });
    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("error", expect.stringMatching(/不可用|不匹配/)));
    expect(screen.queryByText("专项练习（不计入本次试卷作答）")).toBeNull(); // 未进入做题面
    const posts = (apiFetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([p, i]) => String(p) === "/l3/sheets" && (i as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(0);
  });

  it("多卷同题：各自 origin 返回各自卷（无全局来源串味）", async () => {
    setupEssayMock({ openSheet: sheetRow({ id: PAPER_SHEET }) });
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_ESSAY, tasks: [] }] });
    createTaskMock().mockResolvedValue({ task: { id: TASK_W }, draft: null, created: true });

    await renderPage({ deepLinkPaper: PAPER_1 });
    await waitFor(() => expect(screen.getByRole("button", { name: "开始写作" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    await waitFor(() => expect(locText()).toContain("writingTaskId"));
    const first = parseWritingSearch(new URLSearchParams(locText().split("?")[1])).origin;
    expect(first).toMatchObject({ kind: "paper", paperId: PAPER_1 });

    // 第二卷（同库同题）：重挂载后来源各自取自当前卷
    act(() => { for (const root of mountedRoots.splice(0)) root.unmount(); });
    document.body.innerHTML = "";
    setupEssayMock({
      paper: essayPaper(PAPER_2),
      openSheet: sheetRow({ id: PAPER_SHEET_B, scope_key: `paper:${PAPER_2}`, paper_id: PAPER_2 }),
    });
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_ESSAY, tasks: [] }] });
    await renderPage({ deepLinkPaper: PAPER_2 });
    await waitFor(() => expect(screen.getByRole("button", { name: "开始写作" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    await waitFor(() => expect(locText()).toContain("writingTaskId"));
    const second = parseWritingSearch(new URLSearchParams(locText().split("?")[1])).origin;
    expect(second).toMatchObject({ kind: "paper", paperId: PAPER_2, sheetId: PAPER_SHEET_B });
  });

  it("StrictMode（dev 双跑）：整卷 resume 一次性消费——零 openSheet、sealed 不退化新建", async () => {
    setupEssayMock({
      fetchSheets: {
        [RESUME_SEALED]: sheetRow({ id: RESUME_SEALED, paper_id: PAPER_1, scope_key: `paper:${PAPER_1}`, status: "sealed", sealed_at: "2026-09-19T01:00:00Z" }),
      },
    });
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_ESSAY, tasks: [] }] });

    await renderPage(
      { deepLinkPaper: PAPER_1, deepLinkQuestion: Q_ESSAY, deepLinkResumeSheet: RESUME_SEALED },
      { strict: true },
    );
    await waitFor(() => expect(screen.getByText("专项练习（不计入本次试卷作答）")).toBeTruthy());
    const posts = (apiFetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([p, i]) => String(p) === "/l3/sheets" && (i as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(0); // 双跑不得把 resume 二次消费后退化成 openSheet（sealed 会另建新卷）
    // Task C：卷面无输入框（双跑不得产生可编辑假象）
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("StrictMode（dev 双跑）：source 文件 resume 同样一次性消费（零 openSheet POST）", async () => {
    setupEssayMock({
      files: [essayFile()],
      detail: essaySourceDetail(),
      fetchSheets: {
        [RESUME_DRAFT]: sheetRow({ id: RESUME_DRAFT, scope: "file", scope_key: `file:${SOURCE_ID}:short_essay`, source_id: SOURCE_ID, question_type: "short_essay", paper_id: null }),
      },
    });
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_ESSAY, tasks: [] }] });

    await renderPage(
      { deepLinkVenue: "short_essay", deepLinkFile: SOURCE_ID, deepLinkQuestion: Q_ESSAY, deepLinkResumeSheet: RESUME_DRAFT },
      { strict: true },
    );
    await waitFor(() => expect(screen.getByText("专项练习（不计入本次试卷作答）")).toBeTruthy());
    const posts = (apiFetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([p, i]) => String(p) === "/l3/sheets" && (i as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(0);
    // Task C：卷面无输入框（作答与可编辑性在作文空间，双跑同样零输入框）
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("R1：创建在途再次输入——二次 flush 落库后才导航（空档闭合）", async () => {
    setupEssayMock();
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_ESSAY, tasks: [] }] });
    let resolveCreate!: (value: unknown) => void;
    const createPending = new Promise((resolve) => { resolveCreate = resolve; });
    createTaskMock().mockImplementation(() => createPending);

    await renderPage({ deepLinkPaper: PAPER_1 });
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: "开始写作" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /甲/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    // 等 gate① 完成（createTask 进入挂起）——此后产生的新输入就落在「创建在途」空档里
    await waitFor(() => expect(createTaskMock()).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(patchCalls()).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /乙/ })); // 创建在途：原卷又产生新输入
    resolveCreate({ task: { id: TASK_W }, draft: { id: SHEET_W }, created: true });

    // 导航前二次确认：乙必须落库（PATCH#2）之后才导航
    await waitFor(() => expect(patchCalls()).toHaveLength(2));
    await waitFor(() => expect(locText()).toContain(`writingTaskId=${TASK_W}`));
    const bodies = patchCalls().map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies[0].answers[Q_CHOICE]).toMatchObject({ choice: "A" });
    expect(bodies[1].answers[Q_CHOICE]).toMatchObject({ choice: "B" });
    expect(createTaskMock()).toHaveBeenCalledTimes(1);
  });

  it("R2：resume 同 owner 错误组合（来源不符/题型不符/卷不符）→ 拒绝恢复、停留列表、零新增", async () => {
    const otherUuid = "00000000-0000-4000-8000-0000000009f9";
    const resumePosts = () => (apiFetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([p, i]) => String(p) === "/l3/sheets" && (i as RequestInit | undefined)?.method === "POST");

    // ① file：来源不符（同 owner，sheet.source_id 对不上文件）
    setupEssayMock({
      files: [essayFile()],
      detail: essaySourceDetail(),
      fetchSheets: {
        [RESUME_DRAFT]: sheetRow({ id: RESUME_DRAFT, scope: "file", scope_key: "x", source_id: otherUuid, question_type: "short_essay", paper_id: null }),
      },
    });
    await renderPage({ deepLinkVenue: "short_essay", deepLinkFile: SOURCE_ID, deepLinkQuestion: Q_ESSAY, deepLinkResumeSheet: RESUME_DRAFT });
    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("error", expect.stringMatching(/不可用|不匹配/)));
    expect(screen.queryByText("专项练习（不计入本次试卷作答）")).toBeNull();
    expect(resumePosts()).toHaveLength(0);
    act(() => { for (const root of mountedRoots.splice(0)) root.unmount(); });
    document.body.innerHTML = "";
    addToastMock.mockReset();

    // ② file：题型不符（sheet 记为大作文）
    setupEssayMock({
      files: [essayFile()],
      detail: essaySourceDetail(),
      fetchSheets: {
        [RESUME_DRAFT]: sheetRow({ id: RESUME_DRAFT, scope: "file", scope_key: "x", source_id: SOURCE_ID, question_type: "long_essay", paper_id: null }),
      },
    });
    await renderPage({ deepLinkVenue: "short_essay", deepLinkFile: SOURCE_ID, deepLinkQuestion: Q_ESSAY, deepLinkResumeSheet: RESUME_DRAFT });
    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("error", expect.stringMatching(/不可用|不匹配/)));
    expect(screen.queryByText("专项练习（不计入本次试卷作答）")).toBeNull();
    expect(resumePosts()).toHaveLength(0);
    act(() => { for (const root of mountedRoots.splice(0)) root.unmount(); });
    document.body.innerHTML = "";
    addToastMock.mockReset();

    // ③ paper：卷不符（sheet.paper_id 对不上深链试卷）
    setupEssayMock({
      fetchSheets: {
        [RESUME_SEALED]: sheetRow({ id: RESUME_SEALED, paper_id: otherUuid, scope_key: `paper:${otherUuid}`, status: "sealed", sealed_at: "2026-09-19T01:00:00Z" }),
      },
    });
    await renderPage({ deepLinkPaper: PAPER_1, deepLinkQuestion: Q_ESSAY, deepLinkResumeSheet: RESUME_SEALED });
    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("error", expect.stringMatching(/不可用|不匹配/)));
    expect(screen.queryByText("专项练习（不计入本次试卷作答）")).toBeNull();
    expect(resumePosts()).toHaveLength(0);
  });

  it("R1：二次确认失败留页→重试复用任务（不重复创建）后导航", async () => {
    setupEssayMock();
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_ESSAY, tasks: [] }] });
    let resolveCreate!: (value: unknown) => void;
    const createPending = new Promise((resolve) => { resolveCreate = resolve; });
    createTaskMock().mockImplementation(() => createPending);

    await renderPage({ deepLinkPaper: PAPER_1 });
    await waitFor(() => expect(screen.getByText("题纸")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("button", { name: "开始写作" })).toBeTruthy());

    // PATCH：第 1 次成功（甲·gate①）、第 2 次失败（gate② 乙拒收）、其后成功
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    const base = apiFetchMock.getMockImplementation()!;
    let patchCount = 0;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (String(path).startsWith("/l3/sheets/") && init?.method === "PATCH") {
        patchCount += 1;
        // 整合后语义：无 status 的错误会被自动重试自愈本用例的「二次确认失败」；以 422
        // （不可重试）固定失败路径，验证留页 → 显式重试复用任务 → 导航的完整链路。
        if (patchCount === 2) throw Object.assign(new Error("save failed"), { status: 422 });
        return { sheet: sheetRow({ answers: {} }) };
      }
      return base(path, init);
    });

    fireEvent.click(screen.getByRole("button", { name: /甲/ }));
    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    await waitFor(() => expect(createTaskMock()).toHaveBeenCalledTimes(1)); // gate① 完成、任务挂起
    fireEvent.click(screen.getByRole("button", { name: /乙/ }));
    resolveCreate({ task: { id: TASK_W }, draft: { id: SHEET_W }, created: true });

    // gate② 失败：留页保留正文 + 显式提示；不导航
    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("error", expect.stringMatching(/暂不能离开|尚未保存成功/)));
    expect(locText()).not.toContain("writingTaskId=");

    // 重试：复用已创建任务（createTask 恰一次）→ 确认通过 → 导航
    fireEvent.click(screen.getByRole("button", { name: /重试进入写作/ }));
    await waitFor(() => expect(locText()).toContain(`writingTaskId=${TASK_W}`));
    expect(createTaskMock()).toHaveBeenCalledTimes(1);
  });
});

// ── R3：回看方向精确读取（不依赖前 100 条列表；读失败不得冒充「通用」） ──

describe("R3 回看方向精确读取", () => {
  const SRC2 = "00000000-0000-4000-8000-0000000000d2";
  const Q_E2 = "00000000-0000-4000-8000-0000000001d1";
  const REPLAY_SHEET = "00000000-0000-4000-8000-0000000008e1";
  const TASK_R3 = "00000000-0000-4000-8000-0000000007e1";

  const replaySheet = () => ({
    id: REPLAY_SHEET, user_id: "00000000-0000-4000-8000-000000000001", scope: "file",
    scope_key: `file:${SRC2}:short_essay`, source_id: SRC2, question_type: "short_essay", paper_id: null,
    status: "sealed", answers: {}, seal_mode: "full", summary: null, sealed_at: "2026-09-19T02:00:00Z",
    created_at: "2026-09-19T00:00:00Z", updated_at: "2026-09-19T02:00:00Z",
  });
  const replayDetail = () => ({
    question_type: "short_essay",
    source: { id: SRC2, title: "精确来源文件" },
    source_content: null, file_key: null,
    questions: [{ id: Q_E2, ordinal: 0, stem: "47. R3 小作文题干", options: [], answer: { sample: "范文" }, explanation: null, evidence: [] }],
  });
  const hundredWithoutTarget = () => Array.from({ length: 100 }, (_, index) => ({
    question_type: "short_essay",
    source_id: `00000000-0000-4000-8000-0000000009${String(index).padStart(2, "0")}`,
    file_key: null, title: `占位 ${index}`, direction: "通用", question_count: 1, latest_created_at: "2026-09-19T00:00:00Z",
  }));

  function setupReplayMock(options: {
    metaFailFirst?: boolean;
    metaDirection?: "通用" | "考研" | "雅思" | null;
  } = {}) {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    let metaFailuresLeft = options.metaFailFirst ? 1 : 0;
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path.includes("/grading")) return { results: [] };
      if (path === `/l3/sheets/${REPLAY_SHEET}` && method === "GET") return { sheet: replaySheet(), attempts: [] };
      if (path.startsWith("/l3/practice-files/detail?")) return replayDetail();
      if (path.startsWith("/l3/practice-files?")) {
        if (path.includes(`sourceId=${SRC2}`)) {
          // 精确读面（R3 目标路径）：失败注入仅作用于它
          if (metaFailuresLeft > 0) { metaFailuresLeft -= 1; throw new Error("meta read failed"); }
          return {
            items: [{
              question_type: "short_essay", source_id: SRC2, file_key: null, title: "精确来源文件",
              direction: options.metaDirection ?? null, question_count: 1, latest_created_at: "2026-09-19T00:00:00Z",
            }],
          };
        }
        // 旧式全量列表（R3 明确不再依赖；此处 100 条不含目标，模拟「第 101 个文件」）
        return { items: hundredWithoutTarget() };
      }
      if (path.startsWith("/l3/attempts")) return { items: [] };
      if (path.startsWith("/l3/question-annotations")) return { items: [] };
      if (path === "/l3/annotation-tags") return { entry: [], option: [] };
      throw new Error(`unmocked: ${path}`);
    });
    return apiFetchMock;
  }
  const summariesMock = () => writingClient.questionSummaries as ReturnType<typeof vi.fn>;
  const createTaskMock = () => writingClient.createTask as ReturnType<typeof vi.fn>;

  it("#101：方向经精确读面（sourceId 过滤 + limit=1）取得——旧列表不含目标也不冒充通用", async () => {
    const apiFetchMock = setupReplayMock({ metaDirection: "考研" });
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_E2, tasks: [] }] });
    createTaskMock().mockResolvedValue({ task: { id: TASK_R3 }, draft: null, created: true });

    await renderPage({ deepLinkSheet: REPLAY_SHEET });
    await waitFor(() => expect(screen.getByRole("button", { name: "开始写作" })).toBeTruthy());

    const calls = apiFetchMock.mock.calls.map(([p]) => String(p));
    const precise = calls.filter((p) => p.startsWith("/l3/practice-files?") && p.includes(`sourceId=${SRC2}`));
    expect(precise.length).toBeGreaterThanOrEqual(1);
    expect(precise[0]).toContain("limit=1");

    fireEvent.click(screen.getByRole("button", { name: "开始写作" }));
    await waitFor(() => expect(locText()).toContain(`writingTaskId=${TASK_R3}`));
    expect(createTaskMock()).toHaveBeenCalledWith(expect.objectContaining({ direction: "考研" }));
  });

  it("方向读面失败：回看原卷可见、入口重试、不请求摘要不创建；重试后恢复（权威 null→通用）", async () => {
    setupReplayMock({ metaFailFirst: true, metaDirection: null });
    summariesMock().mockResolvedValue({ items: [{ questionId: Q_E2, tasks: [] }] });
    createTaskMock().mockResolvedValue({ task: { id: TASK_R3 }, draft: null, created: true });

    await renderPage({ deepLinkSheet: REPLAY_SHEET });
    await waitFor(() => expect(screen.getByText("题纸", { exact: true })).toBeTruthy()); // 回看原卷可见
    await waitFor(() => expect(screen.getByText(/进度读取失败/)).toBeTruthy());
    expect(summariesMock()).not.toHaveBeenCalled(); // 读失败不得冒充方向去请求摘要
    expect(createTaskMock()).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "开始写作" })).toBeTruthy());
    await waitFor(() => expect(summariesMock()).toHaveBeenCalledTimes(1));
    expect(summariesMock().mock.calls[0]![1]).toEqual({ kind: "whole", direction: "通用" });
  });
});
