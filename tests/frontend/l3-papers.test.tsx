/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3PapersPage } from "@/frontend/components/l3/L3PapersPage";

// 与 l3-bookshelf.test.tsx 同款手动挂载（仓库无 @testing-library/react）。

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));
import { apiFetch } from "@/frontend/api/client";

const SOURCE_ID = "00000000-0000-4000-8000-000000000002";
const QUESTION_ID = "00000000-0000-4000-8000-000000000101";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
async function renderPage(props: Record<string, unknown> = {}): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(createElement(L3PapersPage, props as never) as ReactElement);
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
});

describe("L3PapersPage 题型空间", () => {
  it("全景 → 单专题文件列表 → 文件题组详情", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    apiFetchMock
      .mockResolvedValueOnce({ items: [] }) // 初始「我的试卷」列表
      .mockResolvedValueOnce({
        // 题型空间全景：只收录一个阅读文件
        items: [{
          question_type: "reading_choice",
          source_id: SOURCE_ID,
          file_key: null,
          title: "2025 英语二 · Text 1 小费文化",
          direction: "考研",
          question_count: 5,
          latest_created_at: "2026-09-16T00:00:00Z",
        }],
      })
      .mockResolvedValueOnce({
        question_type: "reading_choice",
        source: { id: SOURCE_ID, title: "2025 英语二 · Text 1 小费文化" },
        file_key: null,
        questions: [{
          id: QUESTION_ID, ordinal: 0, stem: "21. 题干",
          options: [{ key: "A", text: "选项 A" }], answer: { choice: "A" },
          explanation: null, evidence: [],
        }],
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
    const filesCall = apiFetchMock.mock.calls[1][0] as string;
    expect(filesCall).toContain("/l3/practice-files?limit=100");

    await act(async () => {
      fireEvent.click(screen.getByText(/2025 英语二 · Text 1 小费文化/));
    });
    await waitFor(() => expect(screen.getByText("21. 题干")).toBeTruthy());
    const detailCall = apiFetchMock.mock.calls[2][0] as string;
    expect(detailCall).toContain("/l3/practice-files/detail?");
    expect(detailCall).toContain("questionType=reading_choice");
    expect(detailCall).toContain(`sourceId=${SOURCE_ID}`);
  });
});

describe("L3PapersPage 粘贴建卷", () => {
  it("提交 section × 题 × 选项/答案的结构化包并切回试卷列表", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    apiFetchMock
      // 初始题型空间列表（默认 tab=files；BuildTab 未挂载，不拉来源）
      .mockResolvedValueOnce({ items: [] })
      // 切到建卷 tab 后拉来源列表
      .mockResolvedValueOnce({ items: [{ id: SOURCE_ID, title: "2023 英一 Text 1" }] })
      // POST /l3/papers
      .mockResolvedValueOnce({ paper: { id: "paper-1" }, questions: [], questionCount: 1 })
      // 切到「我的试卷」后列表
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
  it("?venue=&file= 直达题型空间并自动打开目标文件", async () => {
    const apiFetchMock = apiFetch as ReturnType<typeof vi.fn>;
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/l3/practice-files?")) {
        return {
          items: [{
            question_type: "reading_choice",
            source_id: SOURCE_ID,
            file_key: null,
            title: "2025 英语二 · Text 1 小费文化",
            direction: "考研",
            question_count: 5,
            latest_created_at: "2026-09-16T00:00:00Z",
          }],
        };
      }
      if (path.startsWith("/l3/practice-files/detail?")) {
        return {
          questions: [{
            id: QUESTION_ID, ordinal: 0, stem: "21. 深链题干",
            options: [{ key: "A", text: "选项 A" }], answer: { choice: "A" },
            explanation: null, evidence: [],
          }],
        };
      }
      return {};
    });

    await renderPage({ deepLinkVenue: "reading_choice", deepLinkFile: SOURCE_ID });
    // 深链直达文件题组详情（无需手动切 tab / 点空间 / 点文件）
    await waitFor(() => expect(screen.getByText("21. 深链题干")).toBeTruthy());
    const detailCall = apiFetchMock.mock.calls.find(([path]) => String(path).includes("/l3/practice-files/detail?"));
    expect(String(detailCall![0])).toContain(`sourceId=${SOURCE_ID}`);
    expect(String(detailCall![0])).toContain("questionType=reading_choice");
  });
});
