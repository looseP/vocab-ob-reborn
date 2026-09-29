/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * `SenseList` —— 核心释义义项的结构化紧凑渲染。
 *
 * 动机（2026-09-29，用户实机反馈）：复习卡「显示释义」区原本用
 * `<Markdown content={definition_md} />` 平铺，每个义项 4 行
 * （`义项` / `- en:` / `- priority:` / `- tags:`），过于松散。
 * 根因是 `definition_md` 本就是 `core_definitions` 的**有损 markdown 投影**
 * （`collection-parser.ts:183` `renderDefinitionMd`），而 `priority` / `tags`
 * 是结构化元数据，不该各占一整行。
 *
 * 本文件锁住三条设计约定：
 * 1. 每个义项**两行**（中文义项 + en），tags 提到义项行右端；
 * 2. `priority` **默认不显示**（列表顺序已由 `sortByPriority` 表达优先级），
 *    仅在实际权重与序号不一致时出「权重 N」徽章（不静默丢信息）；
 * 3. tags **不按值映射颜色** —— 那会暗示数据里不存在的语义顺序。
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SenseList, type CoreSense } from "@/frontend/components/words/SenseList";

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

/** 与库中 `core_definitions` 同形（`jsonb_array_elements` 实测：priority 恒 [1,2,3]）。 */
const BEAR: CoreSense[] = [
  { sense: "忍受；容忍", en: "to tolerate or put up with something", priority: 1, tags: ["A"] },
  { sense: "遵守；坚持", en: "to act in accordance with a rule or decision", priority: 2, tags: ["B"] },
  { sense: "停留；持续", en: "to remain or continue (archaic or literary)", priority: 3, tags: ["B"] },
];

const items = (c: HTMLElement) => Array.from(c.querySelectorAll("li"));
const badges = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("li span.rounded-full")).map((b) => b.textContent?.trim() ?? "");

describe("SenseList · 紧凑度与信息完整性", () => {
  it("每个义项 2 行：中文义项 + en，tags 不再各占一行", () => {
    const c = mount(createElement(SenseList, { senses: BEAR }));
    const rows = items(c);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const paras = row.querySelectorAll("p");
      // 行 1 = 中文义项（可能并排徽章），行 2 = en。绝不该有第三行。
      expect(paras.length, "义项不得多于两行").toBeLessThanOrEqual(2);
      // 旧式 markdown 投影的字段前缀都不该出现在 DOM 里
      expect(row.textContent).not.toMatch(/en:/);
      expect(row.textContent).not.toMatch(/priority:/);
      expect(row.textContent).not.toMatch(/tags:/);
    }
    expect(c.textContent).toContain("to tolerate or put up with something");
    expect(c.textContent).toContain("停留；持续");
  });

  it("tags 不渲染（冗余于 priority：实测 prio=1 恒为 A）", () => {
    const c = mount(createElement(SenseList, { senses: BEAR }));
    // 源数据 10+ 类语义 tag 导入时被压成「含 core → A，否则 B/C」，
    // A 与「第一个义项」完全等价，屏上徽章零学习价值。
    expect(badges(c)).toEqual([]);
    expect(c.textContent).not.toContain("tags:");
    // tags 仍可从入参传入（接口保留），只是不落到 DOM
    expect(BEAR[0]!.tags).toEqual(["A"]);
  });

  it("priority 正常时不显示（顺序已由 sortByPriority 表达）", () => {
    const c = mount(createElement(SenseList, { senses: BEAR }));
    expect(c.textContent).not.toContain("权重");
  });

  it("priority 与序号不一致时才出「权重 N」徽章（不静默丢信息）", () => {
    const odd: CoreSense[] = [
      { sense: "甲", en: "A", priority: 1, tags: [] },
      { sense: "乙", en: "B", priority: 5, tags: [] },
    ];
    expect(badges(mount(createElement(SenseList, { senses: odd })))).toEqual(["权重 5"]);
  });

  it("priority 缺失（null）不出徽章，也不当成异常", () => {
    const noPri: CoreSense[] = [
      { sense: "甲", en: null, priority: null, tags: [] },
      { sense: "乙", en: null, priority: null, tags: [] },
    ];
    const c = mount(createElement(SenseList, { senses: noPri }));
    expect(c.textContent).not.toContain("权重");
    expect(badges(c)).toEqual([]);
  });

  it("多义项显示序号（主义项强调）；单义项不显示序号", () => {
    const multi = mount(createElement(SenseList, { senses: BEAR }));
    expect(multi.textContent).toContain("1");
    expect(multi.textContent).toContain("3");

    const single = mount(
      createElement(SenseList, { senses: [{ sense: "唯一义项", en: "only", priority: 1, tags: [] }] }),
    );
    // 单义项时 "1" 是噪音（没有兄弟可比）
    expect(single.textContent).toBe("唯一义项only");
  });

  it("主义项（首个）加粗，序号用强调色", () => {
    const c = mount(createElement(SenseList, { senses: BEAR }));
    const firstSenseP = items(c)[0]!.querySelector("p")!;
    expect(firstSenseP.className).toContain("font-medium");
    const secondSenseP = items(c)[1]!.querySelector("p")!;
    expect(secondSenseP.className).not.toContain("font-medium");
    expect(items(c)[0]!.querySelector("span.tabular-nums")!.className).toContain("color-accent");
  });

  it("空 / 缺省 / 空数组 → 整体缺席（不渲染空壳）", () => {
    expect(mount(createElement(SenseList, { senses: [] })).innerHTML).toBe("");
    expect(mount(createElement(SenseList, { senses: null })).innerHTML).toBe("");
    expect(mount(createElement(SenseList, {})).innerHTML).toBe("");
  });

  it("en 缺失时不留空行", () => {
    const sparse: CoreSense[] = [
      { sense: "无英文", en: null, priority: 1, tags: ["A"] },
      { sense: "有英文", en: "has en", priority: 2, tags: ["B"] },
    ];
    const c = mount(createElement(SenseList, { senses: sparse }));
    expect(items(c)[0]!.querySelectorAll("p")).toHaveLength(1);
    expect(items(c)[1]!.querySelectorAll("p")).toHaveLength(2);
    // tags 与 weightMismatch 都不出现时，义项行不留空徽章位
    expect(badges(c)).toEqual([]);
  });

  it("stable key：同义项文本重复时仍全部渲染", () => {
    const dup: CoreSense[] = [
      { sense: "重复", en: "dup", priority: 1, tags: [] },
      { sense: "重复", en: "dup2", priority: 2, tags: [] },
    ];
    const c = mount(createElement(SenseList, { senses: dup }));
    expect(items(c)).toHaveLength(2);
    expect(c.textContent).toContain("dup2");
  });
});
