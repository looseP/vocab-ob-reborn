/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * 复习卡卡背「显示释义」区：走 `SenseList`（结构化）而非 `definition_md`（markdown 平铺）。
 *
 * 动机（2026-09-29，用户实机反馈）：卡背义项区原本每个义项 4 行
 * （`义项` / `- en:` / `- priority:` / `- tags:`），过于松散。
 *
 * ## 两处测试设计约束（都不是产品缺陷，是测量限制）
 *
 * 1. **用 `preview: true` 而非点按翻卡**：`ReviewCardView` 用
 *    `AnimatePresence mode="wait"` 切正/背面，要等旧子元素退出动画完成才挂新的。
 *    jsdom 与 headless 浏览器里 rAF 不推进 ⇒ 翻卡后 DOM 停在正面
 *    （`aria-pressed` 已 `true` 但内容未换）。`preview` 时
 *    `showDefinition = preview || revealed` 直接为真，不经切换。
 * 2. **每例用不同 slug**：`useWordDetail` 有**模块级缓存**（`setCache(slug, data)`），
 *    同 slug 会命中前一例的数据，断言互相污染。
 *
 * 组件级行为（行数、徽章、priority 省略规则）由 `sense-list.test.tsx` 锁；
 * 本文件只锁**分支选择**（哪条数据走哪条渲染路径）。
 */
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewCardView } from "@/frontend/components/review/ReviewCardView";
import type { ReviewCard } from "@/frontend/hooks/useReview";

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/frontend/api/client", () => ({ apiFetch: apiFetchMock }));
vi.mock("@/frontend/components/ui/Toast", () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock("@/frontend/components/ui/Markdown", () => ({
  Markdown: (props: { content: string }) =>
    createElement("div", { "data-testid": "fallback-markdown" }, props.content),
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
afterEach(() => {
  act(() => {
    for (const m of mounted.splice(0)) m.root.unmount();
  });
  document.body.innerHTML = "";
});
beforeEach(() => apiFetchMock.mockReset());

/** 与库中 `core_definitions` 同形（实测：priority 恒 [1,2,3]，6767/6767 词都有）。 */
const CORES = [
  { sense: "忍受；容忍", en: "to tolerate or put up with something", priority: 1, tags: ["A"] },
  { sense: "遵守；坚持", en: "to act in accordance with a rule", priority: 2, tags: ["B"] },
  { sense: "停留；持续", en: "to remain or continue", priority: 3, tags: ["B"] },
];

const MD =
  "1. 忍受；容忍\n   - en: to tolerate or put up with something\n   - priority: 1\n   - tags: A\n" +
  "2. 遵守；坚持\n   - en: to act in accordance with a rule\n   - priority: 2\n   - tags: B\n";

/** 每例传不同 slug，避开 `useWordDetail` 的模块级缓存。 */
let slugSeq = 0;
async function renderCardBack(detail: Record<string, unknown>) {
  const slug = `probe-${(slugSeq += 1)}`;
  apiFetchMock.mockImplementation(() => Promise.resolve({ ...detail, slug }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const card = {
    progressId: `p${slugSeq}`,
    word: {
      id: `w${slugSeq}`,
      slug,
      title: slug,
      lemma: slug,
      short_definition: "忍受；遵守；停留",
      ipa: "/əˈbaɪd/",
      pos: "v.",
      cefr: "C1",
      examples: [{ text: "Both sides are supposed to abide by it." }],
    },
    state: "review",
    dueAt: null,
    lastRating: "good",
    reviewCount: 3,
  } as unknown as ReviewCard;

  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        // preview: true ⇒ showDefinition 直接为真，绕过 AnimatePresence 切换
        createElement(ReviewCardView, {
          card,
          loading: false,
          error: null,
          preview: true,
          onAnswer: vi.fn(),
          onSkip: vi.fn(),
          hintLadderHidden: false,
        } as never),
      ),
    );
  });
  // 详情请求的 Promise.then(setWord) 必须 await 一次微任务队列才落地
  await act(async () => {});
  mounted.push({ root, container });
  return container;
}

const senseList = (c: HTMLElement) => c.querySelector('[data-testid="sense-list"]');
const mdFallback = (c: HTMLElement) => c.querySelector('[data-testid="fallback-markdown"]');

const BASE_DETAIL = {
  short_definition: "忍受；遵守；停留",
  ipa: "/əˈbaɪd/",
  pos: "v.",
  cefr: "C1",
  examples: [{ text: "Both sides are supposed to abide by it." }],
  prototype_text: null,
  metadata: null,
};

describe("复习卡卡背 · 义项区分支选择", () => {
  it("有 core_definitions → SenseList（结构化），不渲染 markdown 降级", async () => {
    const c = await renderCardBack({ ...BASE_DETAIL, core_definitions: CORES, definition_md: MD });
    const list = senseList(c);
    expect(list, "卡背应渲染 SenseList").toBeTruthy();
    expect(mdFallback(c), "有结构化义项时不应走 markdown 降级").toBeNull();

    expect(list!.querySelectorAll("li")).toHaveLength(3);
    expect(list!.textContent).toContain("忍受；容忍");
    expect(list!.textContent).toContain("to tolerate or put up with something");
    // markdown 投影的字段前缀不得出现在 DOM
    expect(list!.textContent).not.toMatch(/priority:/);
    expect(list!.textContent).not.toMatch(/tags:/);
    // tags 不渲染（冗余于 priority，详见 SenseList 文件头）
    expect(list!.querySelectorAll("span.rounded-full")).toHaveLength(0);
    // 但英文释义必须都在
    for (const en of ["to tolerate or put up with something", "to act in accordance with a rule", "to remain or continue"]) {
      expect(list!.textContent).toContain(en);
    }
  });

  it("无 core_definitions → 降级 definition_md（不空白）", async () => {
    const c = await renderCardBack({ ...BASE_DETAIL, definition_md: MD });
    expect(senseList(c)).toBeNull();
    expect(mdFallback(c), "应降级到 markdown").toBeTruthy();
    expect(mdFallback(c)!.textContent).toContain("忍受；容忍");
  });

  it("core_definitions 为空数组 → 同样降级（空数组不是有效义项表）", async () => {
    const c = await renderCardBack({ ...BASE_DETAIL, core_definitions: [], definition_md: MD });
    expect(senseList(c)).toBeNull();
    expect(mdFallback(c), "空数组应走降级").toBeTruthy();
  });

  it("stub 词条（既无 core_definitions 也无 definition_md）→ 义项区整体缺席", async () => {
    const c = await renderCardBack({ ...BASE_DETAIL, core_definitions: undefined, definition_md: "" });
    expect(senseList(c)).toBeNull();
    expect(mdFallback(c)).toBeNull();
  });

  it("单义项不显示序号（无兄弟可比），但仍走 SenseList", async () => {
    const c = await renderCardBack({
      ...BASE_DETAIL,
      core_definitions: [{ sense: "唯一义项", en: "only sense", priority: 1, tags: ["A"] }],
      definition_md: MD,
    });
    const list = senseList(c);
    expect(list).toBeTruthy();
    const rows = list!.querySelectorAll("li");
    expect(rows).toHaveLength(1);
    // 序号列在单义项时不渲染（没有兄弟可比，序号是纯噪音）
    expect(rows[0]!.querySelector("span.tabular-nums")).toBeNull();
    // 结构断言而非整串比对：tags 不渲染，DOM 只有「义项行 + en 行」
    const paras = rows[0]!.querySelectorAll("p");
    expect(paras[0]!.textContent).toBe("唯一义项");
    expect(paras[1]!.textContent).toBe("only sense");
    expect(rows[0]!.querySelectorAll("span.rounded-full")).toHaveLength(0);
  });
});
