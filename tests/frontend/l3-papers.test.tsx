/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
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

async function renderPage(props: Record<string, unknown> = {}): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    // W7：做题台组件现含 useNavigate（作文入口/深链）——统一包 Router 提供上下文。
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/l3"] },
        createElement(
          "div",
          null,
          createElement(LocationProbe),
          createElement(L3PapersPage, props as never),
        ),
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
