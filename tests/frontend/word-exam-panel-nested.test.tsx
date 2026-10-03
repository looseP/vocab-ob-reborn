/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 词条详情页的 exam 切分渲染（`WordExamPanel`）。
 *
 * 修复前这里直接渲染 `{b.text}` **原文** ⇒ `[]` 与 `｜定` 两种编码标记
 * 一起漏给读者（真库实测 154 个片段含 `[`、153 个含 `｜`）。
 * 复习卡那边只剥了方括号、`｜` 仍进正文；两个面各漏一半，现已共用
 * `ExamSplitText`，编码只在契约层解析一次。
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { WordExamPanel } from "@/frontend/components/words/WordExamPanel";
import { parseWordExam } from "@/domain/word-exam";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
afterEach(() => {
  act(() => {
    for (const m of mounted.splice(0)) m.root.unmount();
  });
  document.body.innerHTML = "";
});

function mount(node: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  mounted.push({ root, container });
  return container;
}

const EXAM = {
  reading: {
    split: [
      "Levitt wore a [brown suède｜定] coat and gloves;",
      "seated [in the second row｜状],",
    ],
    structure: "主句 + 分词状语",
    split_roles: [
      ["主句 · 主谓宾", "main"],
      ["状语", "mod"],
    ],
  },
  translation: { model: "参考译文", key_points: [] },
  writing: { pattern: "[对象] wore a [材质] coat", function: "说明文" },
};

const body = (c: HTMLElement) => c.querySelector('[data-testid="word-exam-body"]')!;
/**
 * 只取「精读 · 逐块与语法角色」那一段。
 * 不能对整个面板断言"不含 `[`"——**仿写骨架里的 `[对象] [材质]` 是合法占位符**，
 * 不是 `reading.split` 的编码标记。
 */
const reading = (c: HTMLElement) => c.querySelector('[data-testid="word-exam-reading"]')!;

describe("WordExamPanel 嵌套编码渲染", () => {
  it("精读块里 `[]` 与 `｜` 都不出现（原文直接渲染的回归防线）", () => {
    const c = mount(createElement(WordExamPanel, { exam: parseWordExam(EXAM), defaultOpen: true }));
    const text = reading(c).textContent ?? "";
    expect(text).toContain("brown suède");
    expect(text).not.toContain("｜");
    expect(text).not.toContain("[");
    expect(text).not.toContain("]");
  });

  it("分类渲染成 `.nest-type` 角标，两块各一个", () => {
    const c = mount(createElement(WordExamPanel, { exam: parseWordExam(EXAM), defaultOpen: true }));
    const badges = Array.from(reading(c).querySelectorAll('[data-testid="nest-type"]'));
    expect(badges.map((b) => b.textContent)).toEqual(["定", "状"]);
  });

  it("仿写骨架的 `[对象]` 占位符不受影响（别把合法方括号也剥掉）", () => {
    const c = mount(createElement(WordExamPanel, { exam: parseWordExam(EXAM), defaultOpen: true }));
    expect(body(c).textContent).toContain("[对象]");
  });

  it("尾随标点不丢（形态③ `[片段]｜状,` 的逗号回到正文）", () => {
    const c = mount(createElement(WordExamPanel, { exam: parseWordExam(EXAM), defaultOpen: true }));
    expect(reading(c).textContent).toContain("gloves;");
    expect(reading(c).textContent).toContain("second row");
  });

  it("无 exam 形状 → 面板不渲染空壳", () => {
    const c = mount(createElement(WordExamPanel, { exam: null }));
    expect(c.innerHTML).toBe("");
  });
});
