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
 * 「录题」页签（执行文档 B2 / 缺口 A / 护栏 G-A1..G-A3）。
 *
 * 断言重点在**提交体**而不是 UI 出现 —— 题目录错的代价是「判卷时永远判错」，
 * 而那种错在 UI 上看不出来。G-A2（空值不提交）尤其只能断请求体。
 */

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));

import { apiFetch } from "@/frontend/api/client";

const SOURCE_ID = "00000000-0000-4000-8000-000000000002";
const QUESTION_ID = "00000000-0000-4000-8000-000000000101";

class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] { return []; }
}
(globalThis as Record<string, unknown>).IntersectionObserver ??= IntersectionObserverStub;

const roots: Root[] = [];

function setupMock(options: { sources?: unknown[]; failCreate?: boolean } = {}) {
  const mock = apiFetch as ReturnType<typeof vi.fn>;
  mock.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (String(path).startsWith("/l3/sources?")) {
      return { items: options.sources ?? [{ id: SOURCE_ID, title: "2023 英一 Text 1" }] };
    }
    if (String(path) === "/l3/questions" && init?.method === "POST") {
      if (options.failCreate) throw Object.assign(new Error("boom"), { status: 500 });
      return {
        question: {
          id: QUESTION_ID,
          source_id: SOURCE_ID,
          file_key: null,
          space: "阅读",
          question_type: "reading_choice",
          status: "active",
          created_by: "owner",
        },
      };
    }
    if (String(path).startsWith("/l3/papers?")) return { items: [] };
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
    root.render(createElement(
      MemoryRouter,
      { initialEntries: ["/l3"] },
      createElement(L3PapersPage, {} as never),
    ) as ReactElement);
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("tab", { name: "录题" }));
  });
  await waitFor(() => expect(screen.getByTestId("record-question-type")).toBeTruthy());
}

function createdBody(mock: ReturnType<typeof vi.fn>): Record<string, unknown> | null {
  const call = mock.mock.calls.find(([path, init]) =>
    String(path) === "/l3/questions" && (init as { method?: string } | undefined)?.method === "POST");
  if (!call) return null;
  return JSON.parse((call[1] as { body: string }).body as string) as Record<string, unknown>;
}

/** 填一道完整的选择题（题干 + 两选项 + 答案键）。 */
async function fillChoiceQuestion(answerKey: "A" | "B" = "A"): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByPlaceholderText(/题干/), { target: { value: "21. 题干" } });
    fireEvent.change(screen.getByPlaceholderText("选项 A"), { target: { value: "选项 A 内容" } });
    fireEvent.change(screen.getByPlaceholderText("选项 B"), { target: { value: "选项 B 内容" } });
    fireEvent.click(screen.getByDisplayValue(answerKey));
  });
}

async function pickSource(): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId("record-source"), { target: { value: SOURCE_ID } });
  });
}

async function clickRecord(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId("record-submit"));
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

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

describe("录题页签 · 提交体形状（执行文档 §七 1–8）", () => {
  it("选择题：提交 stem + 已填选项 + 答案键 + questionType + sourceId", async () => {
    const mock = setupMock();
    await renderPage();
    await pickSource();
    await fillChoiceQuestion("B");
    await clickRecord();

    const body = createdBody(mock);
    expect(body).not.toBeNull();
    expect(body!.stem).toBe("21. 题干");
    expect(body!.questionType).toBe("reading_choice");
    expect(body!.sourceId).toBe(SOURCE_ID);
    expect(body!.options).toEqual([
      { key: "A", text: "选项 A 内容" },
      { key: "B", text: "选项 B 内容" },
    ]);
    expect(body!.answer).toEqual({ choice: "B" });
  });

  it("**不传** status/created_by（服务端从 Principal 认定；带这两个键会被 strict 拒）", async () => {
    const mock = setupMock();
    await renderPage();
    await pickSource();
    await fillChoiceQuestion();
    await clickRecord();

    const body = createdBody(mock)!;
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("createdBy");
    expect(body).not.toHaveProperty("created_by");
  });

  it("G-A2：解析空串不进 body（提交空串 = 把「没有解析」写成「解析是空的」）", async () => {
    const mock = setupMock();
    await renderPage();
    await pickSource();
    await fillChoiceQuestion();
    await act(async () => {
      fireEvent.change(screen.getByTestId("record-explanation"), { target: { value: "   " } });
    });
    await clickRecord();

    expect(createdBody(mock)).not.toHaveProperty("explanation");
  });

  it("G-A2 反向：解析有内容时进 body", async () => {
    const mock = setupMock();
    await renderPage();
    await pickSource();
    await fillChoiceQuestion();
    await act(async () => {
      fireEvent.change(screen.getByTestId("record-explanation"), { target: { value: "题干问主旨" } });
    });
    await clickRecord();

    expect(createdBody(mock)!.explanation).toBe("题干问主旨");
  });

  it("成功 → 提示「已生效」且不进「待录」（ADR-0037 owner 直写 active）", async () => {
    setupMock();
    await renderPage();
    await pickSource();
    await fillChoiceQuestion();
    await clickRecord();

    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("success", expect.stringContaining("已录题")));
    expect(addToastMock.mock.calls.some(([kind, msg]) =>
      kind === "success" && String(msg).includes("已生效"))).toBe(true);
  });

  it("录完清空题干但**保留题型与来源**（连续录同一文件是常见节奏）", async () => {
    const mock = setupMock();
    await renderPage();
    await pickSource();
    await fillChoiceQuestion();
    await clickRecord();
    await waitFor(() => expect(addToastMock).toHaveBeenCalledWith("success", expect.any(String)));

    expect((screen.getByPlaceholderText(/题干/) as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByTestId("record-source") as HTMLSelectElement).value).toBe(SOURCE_ID);
    expect((screen.getByTestId("record-question-type") as HTMLSelectElement).value).toBe("reading_choice");
    expect(mock.mock.calls.filter(([p, i]) =>
      String(p) === "/l3/questions" && (i as { method?: string } | undefined)?.method === "POST")).toHaveLength(1);
  });

  it("翻译题：提交 answer.text，不提交 options（照矩阵，不靠隐藏）", async () => {
    const mock = setupMock();
    await renderPage();
    await act(async () => {
      fireEvent.change(screen.getByTestId("record-question-type"), { target: { value: "sentence_translation" } });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("record-file-key"), { target: { value: "translation-2023" } });
      fireEvent.change(screen.getByPlaceholderText(/题干/), { target: { value: "46. 翻译这句" } });
      fireEvent.change(screen.getByPlaceholderText(/参考译文 \/ 范文与评分要点/), { target: { value: "参考译文" } });
    });
    await clickRecord();

    const body = createdBody(mock)!;
    expect(body.answer).toEqual({ text: "参考译文" });
    expect(body).not.toHaveProperty("options");
    expect(body.fileKey).toBe("translation-2023");
    expect(body).not.toHaveProperty("sourceId");
  });
});

describe("录题页签 · 护栏 G-A1 / G-A3（就地拦住，不发请求）", () => {
  it("G-A3：空题干不提交", async () => {
    const mock = setupMock();
    await renderPage();
    await pickSource();
    await clickRecord();

    expect(createdBody(mock)).toBeNull();
    expect(screen.getByTestId("record-problem").textContent).toContain("题干不能为空");
  });

  it("G-A3：未选来源不提交（source 与 fileKey 至少居其一）", async () => {
    const mock = setupMock();
    await renderPage();
    await fillChoiceQuestion();
    await clickRecord();

    expect(createdBody(mock)).toBeNull();
    expect(screen.getByTestId("record-problem").textContent).toContain("请选择阅读材料");
  });

  it("G-A1：答案键为空 → 不提交 + 就地说明（服务端 schema 只会说「choice 是字符串」）", async () => {
    const mock = setupMock();
    await renderPage();
    await pickSource();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/题干/), { target: { value: "21. 题干" } });
      fireEvent.change(screen.getByPlaceholderText("选项 A"), { target: { value: "A 内容" } });
      fireEvent.change(screen.getByPlaceholderText("选项 B"), { target: { value: "B 内容" } });
    });
    await clickRecord();

    expect(createdBody(mock)).toBeNull();
    expect(screen.getByTestId("record-answer-hint").textContent).toContain("请指定正确答案");
  });

  it("G-A1：只填一个选项 → 提示（两个选项以下无法判错）", async () => {
    const mock = setupMock();
    await renderPage();
    await pickSource();
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/题干/), { target: { value: "21. 题干" } });
      fireEvent.change(screen.getByPlaceholderText("选项 A"), { target: { value: "A 内容" } });
      fireEvent.click(screen.getByDisplayValue("A"));
    });
    await clickRecord();

    expect(createdBody(mock)).toBeNull();
    expect(screen.getByTestId("record-answer-hint").textContent).toContain("至少要填两个选项");
  });

  it("G-A1：切换题型会清空答案键（选择题答案键对翻译题无意义）", async () => {
    setupMock();
    await renderPage();
    await pickSource();
    await fillChoiceQuestion("B");
    await act(async () => {
      fireEvent.change(screen.getByTestId("record-question-type"), { target: { value: "sentence_translation" } });
    });
    expect((screen.getByPlaceholderText(/题干/) as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByPlaceholderText("选项 A")).toBeNull();
  });

  it("提交失败 → 保留输入（用户在题上花的时间不能白花）", async () => {
    setupMock({ failCreate: true });
    await renderPage();
    await pickSource();
    await fillChoiceQuestion();
    await clickRecord();

    await waitFor(() => expect(screen.getByTestId("record-problem")).toBeTruthy());
    expect((screen.getByPlaceholderText(/题干/) as HTMLTextAreaElement).value).toBe("21. 题干");
    expect(screen.getByTestId("record-problem").textContent).toContain("已保留");
  });
});
