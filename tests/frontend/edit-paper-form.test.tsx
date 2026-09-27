/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { L3PapersPage } from "@/frontend/components/l3/L3PapersPage";

/**
 * 改卷（执行文档 B4 / 缺口 C / D-5 / G-C1 / G-C2）。
 *
 * 改卷与建卷**形状不同**（§1.6b）：改卷引用 `questionIds`，不定义题面。所以断言重点是
 * ① 提交体的 shape（不带题体、只带 id）② 题集变更前的告知 ③ 两种 409/422 各归各因。
 */

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));

import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";

const PAPER_ID = "00000000-0000-4000-8000-000000000301";
const SOURCE_ID = "00000000-0000-4000-8000-000000000002";
const Q1 = "00000000-0000-4000-8000-000000000101";
const Q2 = "00000000-0000-4000-8000-000000000102";
const Q3 = "00000000-0000-4000-8000-000000000103";

const roots: Root[] = [];

function question(id: string, stem: string) {
  return {
    id, user_id: "00000000-0000-4000-8000-000000000001", source_id: SOURCE_ID, file_key: null,
    space: "阅读", question_type: "reading_choice", ordinal: 0, stem,
    options: [{ key: "A", text: "A" }], answer: { choice: "A" },
    explanation: null, evidence: [], status: "active", created_by: "owner",
    input_hash: null, created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-27T00:00:00Z",
    editable: true,
  };
}

function paperDetail() {
  return {
    id: PAPER_ID,
    title: "2023 英语一真题",
    direction: "考研",
    metadata: {},
    sections: [{
      key: "s1",
      title: "Text 1",
      questionType: "reading_choice",
      sourceId: SOURCE_ID,
      fileKey: null,
      source_title: "2023 Text 1",
      source_content: "The passage.",
      questionIds: [Q1, Q2],
      missing: false,
      questions: [question(Q1, "21. 题干一"), question(Q2, "22. 题干二")],
    }],
  };
}

function setupMock(options: {
  patchStatus?: number;
  patchMessage?: string;
  patchOk?: boolean;
} = {}) {
  const mock = apiFetch as ReturnType<typeof vi.fn>;
  mock.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (String(path).startsWith("/l3/papers?") && init?.method !== "PATCH") {
      return { items: [{ id: PAPER_ID, title: "2023 英语一真题", section_count: 1, question_count: 2 }] };
    }
    if (String(path) === `/l3/papers/${PAPER_ID}` && init?.method === "PATCH") {
      if (options.patchStatus) {
        // 抛真的 BrowserApiError：归因靠类型与 message，抛普通 Error 会假绿
        throw new BrowserApiError(options.patchStatus, { message: options.patchMessage ?? "patch failed" });
      }
      if (options.patchOk === false) return {};
      return { paper: { id: PAPER_ID }, questionCount: 2 };
    }
    if (String(path) === `/l3/papers/${PAPER_ID}`) return paperDetail();
    if (String(path).includes("/l3/practice-files/detail")) {
      return { questions: [question(Q1, "21. 题干一"), question(Q2, "22. 题干二"), question(Q3, "23. 题干三")] };
    }
    if (String(path).startsWith("/l3/sources?")) return { items: [] };
    return {};
  });
  return mock;
}

async function renderPage(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: ["/l3"] },
      createElement(L3PapersPage, {} as never)) as ReactElement);
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: "我的试卷" }));
  });
}

async function openEditor(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId(`papers-edit-${PAPER_ID}`)).toBeTruthy());
  await act(async () => {
    fireEvent.click(screen.getByTestId(`papers-edit-${PAPER_ID}`));
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByTestId("edit-paper-title")).toBeTruthy());
}

async function clickSave(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId("edit-paper-submit"));
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

const patchBody = (mock: ReturnType<typeof vi.fn>): Record<string, unknown> | null => {
  const call = mock.mock.calls.find(([p, i]) =>
    String(p) === `/l3/papers/${PAPER_ID}` && (i as { method?: string } | undefined)?.method === "PATCH");
  if (!call) return null;
  return JSON.parse((call[1] as { body: string }).body as string) as Record<string, unknown>;
};

beforeEach(() => {
  (apiFetch as ReturnType<typeof vi.fn>).mockReset();
  addToastMock.mockReset();
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("改卷（B4 / 缺口 C）", () => {
  it("入口在「我的试卷」每行「改」上（就近入口，不新造页签）", async () => {
    setupMock();
    await renderPage();
    expect(screen.getByTestId(`papers-edit-${PAPER_ID}`)).toBeTruthy();
  });

  it("表单预填现状：标题 / 方向 / 每节题集", async () => {
    setupMock();
    await renderPage();
    await openEditor();

    expect((screen.getByTestId("edit-paper-title") as HTMLInputElement).value).toBe("2023 英语一真题");
    expect((screen.getByTestId("edit-paper-direction") as HTMLSelectElement).value).toBe("考研");
    expect(screen.getByText("本节已选 2 题")).toBeTruthy();
    // 归属只读展示：换归属等于换文件身份（ADR-0030）
    expect(screen.getByText(/归属不可改/)).toBeTruthy();
  });

  it("提交体只带 questionIds，**不带**题体（改卷引用，不定义题）", async () => {
    const mock = setupMock();
    await renderPage();
    await openEditor();
    await clickSave();

    const body = patchBody(mock)!;
    expect(body.title).toBe("2023 英语一真题");
    expect(body.direction).toBe("考研");
    const section = (body.sections as Array<Record<string, unknown>>)[0]!;
    expect(section.questionIds).toEqual([Q1, Q2]);
    expect(section.key).toBe("s1");
    expect(section).not.toHaveProperty("questions");
  });

  it("未改题集时不出现题集提示（G-C1 只在真的动了时告知）", async () => {
    setupMock();
    await renderPage();
    await openEditor();
    expect(screen.queryByTestId("edit-paper-questionset-warning")).toBeNull();
  });

  it("G-C1：改题集后出现提示「已开过的题纸不受影响」（题单冻结是既有口径）", async () => {
    setupMock();
    await renderPage();
    await openEditor();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`edit-paper-pick-${Q3}`));
    });

    const warning = screen.getByTestId("edit-paper-questionset-warning");
    expect(warning.textContent).toContain("已经开过的题纸不受影响");
    expect(warning.textContent).toContain("冻结");
  });

  it("取消勾选同样算改题集（题集是集合，不是只增不减）", async () => {
    setupMock();
    await renderPage();
    await openEditor();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`edit-paper-pick-${Q1}`));
    });
    expect(screen.getByTestId("edit-paper-questionset-warning").textContent).toContain("不受影响");
  });

  it("空节不提交（空节会让整卷少一段可做的内容）", async () => {
    const mock = setupMock();
    await renderPage();
    await openEditor();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`edit-paper-pick-${Q1}`));
      fireEvent.click(screen.getByTestId(`edit-paper-pick-${Q2}`));
    });
    await clickSave();

    expect(patchBody(mock)).toBeNull();
    expect(screen.getByTestId("edit-paper-problem").textContent).toContain("没有选题");
  });

  it("改卷**不提供加节**（加一节 = 换一个文件身份，该走新建卷而不是改卷）", async () => {
    // 诚实说明：组件里那条「跨节重复引用」检查当前**不可达** —— 因为 UI 加不了节。
    // 它是留给「将来若加节」的前置护栏（那时 payload 校验会拒，但那条错误不可读）。
    // 所以这里断的是可达的事实：没有加节入口。
    const mock = setupMock();
    await renderPage();
    await openEditor();
    expect(screen.queryByRole("button", { name: "+ 加一节" })).toBeNull();
    expect(screen.queryByTestId("edit-paper-section-1")).toBeNull();
    // 仍可删到只剩一节（删节在 >1 节时才给）
    expect(screen.queryByRole("button", { name: "删节" })).toBeNull();
    expect(patchBody(mock)).toBeNull();
  });

  it("G-C2①：409「卷非 active」→ 归档卷不可编辑（不套用改题那套 409 文案）", async () => {
    setupMock({ patchStatus: 409, patchMessage: "Only active papers can be edited" });
    await renderPage();
    await openEditor();
    await clickSave();

    await waitFor(() => expect(screen.getByTestId("edit-paper-problem").textContent).toContain("active"));
    expect(screen.getByTestId("edit-paper-problem").textContent).toContain("归档");
  });

  it("G-C2②：422「引用的题不属主/非 active」→ 透传服务端说明", async () => {
    setupMock({ patchStatus: 422, patchMessage: "sections 里的题必须全部是属主且 active 的题目" });
    await renderPage();
    await openEditor();
    await clickSave();

    await waitFor(() => expect(screen.getByTestId("edit-paper-problem").textContent).toContain("属主"));
  });

  it("G-B3 同款：失败保留输入", async () => {
    setupMock({ patchStatus: 500, patchMessage: "boom" });
    await renderPage();
    await openEditor();
    await act(async () => {
      fireEvent.change(screen.getByTestId("edit-paper-title"), { target: { value: "改过的卷名" } });
    });
    await clickSave();

    await waitFor(() => expect(screen.getByTestId("edit-paper-problem")).toBeTruthy());
    expect((screen.getByTestId("edit-paper-title") as HTMLInputElement).value).toBe("改过的卷名");
  });

  it("成功 → 提示并回到列表（列表重读）", async () => {
    const mock = setupMock();
    await renderPage();
    await openEditor();
    await clickSave();

    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("success", expect.stringContaining("已保存改卷")));
    await waitFor(() => expect(screen.queryByTestId("edit-paper-title")).toBeNull());
    const listCalls = mock.mock.calls.filter(([p, i]) =>
      String(p).startsWith("/l3/papers?") && (i as { method?: string } | undefined)?.method !== "PATCH");
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("取消 → 回列表且不发 PATCH", async () => {
    const mock = setupMock();
    await renderPage();
    await openEditor();
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-paper-cancel"));
    });
    expect(patchBody(mock)).toBeNull();
    expect(screen.queryByTestId("edit-paper-title")).toBeNull();
  });
});
