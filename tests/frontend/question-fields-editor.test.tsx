/// <reference lib="dom" />
// @vitest-environment jsdom

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { L3QuestionType } from "@/domain";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));
const { addToastMock } = vi.hoisted(() => ({ addToastMock: vi.fn() }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: addToastMock }) }));

import { apiFetch } from "@/frontend/api/client";
import {
  emptyQuestion,
  QuestionFieldsEditor,
  type DraftQuestion,
} from "@/frontend/components/l3/QuestionFieldsEditor";

/**
 * 题目字段矩阵（执行文档 `l3-question-authoring-ui-execution-2026-09-27.md` §三 / §七.16）。
 *
 * 存在的理由是**防漂移**：这份字段定义现在被「录题」与「粘贴建卷」共用，但题型分支一旦
 * 只在一处改，另一处就会静默录错题 —— 而答案键的题型分支错了**不会报错**，只会让
 * 评卷拿到错误的键。故用一张表逐格断言，且断言的是**渲染了什么**（不是「没渲染什么」）
 * —— 隐藏的输入框仍会被填进去，断言「不渲染」才是有效的。
 */
const MATRIX: Array<{
  questionType: L3QuestionType;
  label: string;
  /** 该题型下必须存在的输入 */
  present: RegExp[];
  /** 该题型下必须**不存在**的输入（防「全渲染再隐藏」） */
  absent: RegExp[];
}> = [
  {
    questionType: "reading_choice",
    label: "选择题：题干 + A–D 选项 + 单选答案键，不渲染文本答案",
    present: [/题干/, /选项 A/, /选项 D/, /官方解析/],
    absent: [/参考译文 \/ 范文与评分要点/],
  },
  {
    questionType: "cloze",
    label: "完形（同选择题分支）",
    present: [/选项 A/, /官方解析/],
    absent: [/参考译文 \/ 范文与评分要点/],
  },
  {
    questionType: "sentence_translation",
    label: "翻译：文本答案，不渲染选项与单选",
    present: [/题干/, /参考译文 \/ 范文与评分要点/, /官方解析/],
    absent: [/选项 A/],
  },
  {
    questionType: "short_essay",
    label: "作文：文本答案（范文与评分要点），不渲染选项",
    present: [/题干/, /参考译文 \/ 范文与评分要点/],
    absent: [/选项 D/],
  },
];

const roots: Root[] = [];

async function renderEditor(props: {
  value?: DraftQuestion;
  questionType: L3QuestionType;
  radioName?: string;
  explanationTestId?: string;
}): { lastPatch: () => Partial<DraftQuestion> | null } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const patches: Partial<DraftQuestion>[] = [];
  await act(async () => {
    root.render(createElement(QuestionFieldsEditor, {
      value: props.value ?? emptyQuestion(),
      onChange: (patch: Partial<DraftQuestion>) => { patches.push(patch); },
      questionType: props.questionType,
      sourceId: null,
      fileKey: null,
      radioName: props.radioName ?? "answer-0-0",
      explanationTestId: props.explanationTestId ?? "build-explanation-0-0",
      onError: (message: string) => { addToastMock("error", message); },
    }));
    await Promise.resolve();
  });
  return { lastPatch: () => patches[patches.length - 1] ?? null };
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

describe("QuestionFieldsEditor · 字段矩阵（表驱动）", () => {
  it.each(MATRIX)("$label", async ({ questionType, present, absent }) => {
    await renderEditor({ questionType });
    for (const pattern of present) {
      expect(screen.queryByPlaceholderText(pattern), `应渲染 ${pattern}`).toBeTruthy();
    }
    for (const pattern of absent) {
      expect(screen.queryByPlaceholderText(pattern), `不应渲染 ${pattern}`).toBeNull();
    }
  });

  it("受控：每次输入只报 patch，组件自己不持有题目状态", async () => {
    const { lastPatch } = await renderEditor({ questionType: "reading_choice" });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(/题干/), { target: { value: "21. 题干" } });
    });
    expect(lastPatch()).toEqual({ stem: "21. 题干" });
  });

  it("选答案键报单键 patch（不是整题回传）—— 宿主才看得见「答案键被清空」这类整体变更", async () => {
    const { lastPatch } = await renderEditor({
      questionType: "reading_choice",
      value: { ...emptyQuestion(), answer: "A" },
    });
    await act(async () => {
      fireEvent.click(screen.getByDisplayValue("B"));
    });
    expect(lastPatch()).toEqual({ answer: "B" });
  });

  it("同一页两题时 radio 分组互不干扰（`name` 相同会把两题的答案键绑成一组）", async () => {
    await renderEditor({ questionType: "reading_choice", radioName: "answer-0-0" });
    await renderEditor({ questionType: "reading_choice", radioName: "answer-0-1" });
    // 断 `name` 而不是断 `checked`：组件是受控的，点一下不会自己变 `checked`
    // （要父层回填），而同名 radio 的真正后果是浏览器的**原生分组**把两题绑成一组。
    const names = screen.getAllByRole("radio").map((el) => (el as HTMLInputElement).name);
    expect(new Set(names).size).toBe(2);
    // 一题之内 A–D 必须同组（否则四个选项可以同时选中）
    const firstQuestion = screen.getAllByRole("radio").slice(0, 4);
    expect(new Set(firstQuestion.map((el) => (el as HTMLInputElement).name)).size).toBe(1);
  });

  it("解析框用宿主给的完整 testid（不拼前缀 —— 拼接会静默改掉既有断言的 id）", async () => {
    await renderEditor({ questionType: "cloze", explanationTestId: "build-explanation-3-7" });
    expect(screen.getByTestId("build-explanation-3-7")).toBeTruthy();
  });

  it("空草稿的全部字段都是空串/空数组（不是 undefined）—— 提交体的「空值不提交」靠这个", () => {
    const draft = emptyQuestion();
    expect(draft).toEqual({ stem: "", options: {}, answer: "", answerText: "", explanation: "", evidence: [] });
  });
});
