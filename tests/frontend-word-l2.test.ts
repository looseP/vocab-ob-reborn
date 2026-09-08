/// <reference lib="dom" />
// @vitest-environment jsdom

import { createElement, type ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WordL2Content } from "@/frontend/components/words/WordL2Content";
import { WordL2Composer } from "@/frontend/components/words/WordL2Composer";
import { WordL2Manager } from "@/frontend/components/words/WordL2Manager";
import { RevealMarkdown } from "@/frontend/components/ui/Reveal";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import type { WordDetailL2Content } from "@/frontend/hooks/useWordDetail";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));

// RevealMarkdown 的单元测试只关注事件委托逻辑，不测 marked/dompurify 集成
// （jsdom 下懒加载超时不稳定）：用最小 strong 转换替身。
vi.mock("@/frontend/components/ui/Markdown", () => ({
  Markdown: (props: { content: string }) =>
    createElement("div", {
      className: "prose-obsidian",
      dangerouslySetInnerHTML: {
        __html: props.content.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"),
      },
    }),
}));

import { apiFetch } from "@/frontend/api/client";
const apiFetchMock = vi.mocked(apiFetch);

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  act(() => {
    for (const mounted of mountedRoots.splice(0)) {
      mounted.root.unmount();
    }
  });
  document.body.innerHTML = "";
});

function render(element: ReactElement): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  mountedRoots.push({ root, container });
  return container;
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

const L2_FIXTURE: WordDetailL2Content = {
  collocations: [
    {
      phrase: "abound in/with",
      gloss: "充满",
      tone: "neutral",
      example: "The region abounds in coal.",
      exampleTranslation: "该地区盛产煤炭。",
      provenance: { source: "dictionary", dictionaryName: "Datamuse" },
    },
  ],
  corpus_items: [],
  synonym_items: [],
  antonym_items: [],
};

describe("WordL2Content", () => {
  it("renders nothing when l2 is null or all arrays are empty", () => {
    expect(render(createElement(WordL2Content, { l2: null })).innerHTML).toBe("");
    expect(
      render(
        createElement(WordL2Content, {
          l2: { collocations: [], corpus_items: [], synonym_items: [], antonym_items: [] },
        }),
      ).innerHTML,
    ).toBe("");
  });

  it("renders sections with items and provenance label", () => {
    const container = render(createElement(WordL2Content, { l2: L2_FIXTURE }));
    expect(container.querySelector("[data-testid='word-l2-content']")).not.toBeNull();
    expect(container.textContent).toContain("搭配");
    expect(container.textContent).toContain("abound in/with");
    // v1 provenance 徽标：词典来源 + 词典名
    expect(container.textContent).toContain("词典 · Datamuse");
  });

  it("exclude 剔除对应区块：仅剩 corpus 时整块消失（例句统一池场景）", () => {
    expect(
      render(createElement(WordL2Content, { l2: L2_FIXTURE, exclude: ["collocations"] })).innerHTML,
    ).toBe("");
    // 多区块存在时只剔除指定区块
    const partial = render(
      createElement(WordL2Content, {
        l2: { ...L2_FIXTURE, corpus_items: [{ text: "Abound in coal.", translation: "盛产煤炭。", source: "generated" }] },
        exclude: ["collocations"],
      }),
    );
    expect(partial.textContent).not.toContain("搭配");
    expect(partial.textContent).toContain("语料例句");
  });

  it("quizMode 默认关闭：答案字段直接展示，无揭示组件", () => {
    const container = render(createElement(WordL2Content, { l2: L2_FIXTURE }));
    expect(container.querySelectorAll("[data-testid='reveal']")).toHaveLength(0);
    expect(container.textContent).toContain("充满");
  });

  it("quizMode 开启：答案字段（释义/例句翻译）模糊化，点击揭示", async () => {
    const container = render(createElement(WordL2Content, { l2: L2_FIXTURE, quizMode: true }));
    const reveals = Array.from(container.querySelectorAll("[data-testid='reveal']"));
    // gloss + exampleTranslation 两个答案字段被 Reveal 包裹
    expect(reveals).toHaveLength(2);
    // 词面（phrase）与例句本体不属于答案，保持可见
    expect(container.textContent).toContain("abound in/with");
    expect(container.textContent).toContain("The region abounds in coal.");

    // 初始隐藏：data-shown=false
    expect(reveals.every((el) => el.getAttribute("data-shown") === "false")).toBe(true);
    // 点击第一个 Reveal → 揭示该字段
    await act(async () => {
      fireEvent.click(reveals[0]);
    });
    const after = Array.from(container.querySelectorAll("[data-testid='reveal']"));
    expect(after[0].getAttribute("data-shown")).toBe("true");
    expect(after[1].getAttribute("data-shown")).toBe("false");
    // 再点一次 → 重新隐藏
    await act(async () => {
      fireEvent.click(after[0]);
    });
    expect(
      Array.from(container.querySelectorAll("[data-testid='reveal']"))[0].getAttribute("data-shown"),
    ).toBe("false");
  });
});

describe("RevealMarkdown", () => {
  it("仅模糊加粗片段：点击揭示单个 strong，再点恢复模糊，非加粗点击无副作用", async () => {
    const container = render(
      createElement(
        RevealMarkdown,
        { content: "1. **口音，腔调** （发音特征） speak with an accent" },
      ),
    );
    // Markdown 替身同步渲染 strong
    const strong = container.querySelector("strong") as HTMLElement;
    expect(strong).not.toBeNull();
    // 初始：无 inline style（模糊由 CSS 类提供）
    expect(strong.style.filter).toBe("");
    // 点击加粗 → 揭示（inline filter:none 覆盖 CSS blur）
    await act(async () => {
      fireEvent.click(strong);
    });
    expect(strong.style.filter).toBe("none");
    expect(strong.style.opacity).toBe("1");
    // 再点 → 恢复模糊
    await act(async () => {
      fireEvent.click(strong);
    });
    expect(strong.style.filter).toBe("");
    expect(strong.style.opacity).toBe("");
    // 点击非加粗文字不改变状态
    await act(async () => {
      fireEvent.click(container.querySelector("[data-testid='reveal-markdown']") as HTMLElement);
    });
    expect(strong.style.filter).toBe("");
  });
});

describe("WordL2Composer", () => {
  it("renders collapsed by default and expands on click", () => {
    const container = render(
      createElement(WordL2Composer, { slug: "abound", onConfirmed: vi.fn() }),
    );
    expect(container.textContent).toContain("扩展内容");
    expect(container.textContent).not.toContain("AI 生成草稿");
    const toggle = container.querySelector("button");
    expect(toggle).not.toBeNull();
    act(() => {
      fireEvent.click(toggle as HTMLButtonElement);
    });
    expect(container.textContent).toContain("AI 生成草稿");
    expect(container.textContent).toContain("外部生成（不耗预算）");
  });

  it("generates a draft, keeps v1 provenance, and confirms only selected items", async () => {
    const draftResponse = {
      draft: {
        schemaVersion: "l2-content-v1",
        field: "collocation",
        items: [
          { phrase: "abound in", gloss: "充满", tone: "neutral", example: "e1", exampleTranslation: "t1" },
          { phrase: "abound with", gloss: "满是", tone: "informal", example: "e2", exampleTranslation: "t2" },
        ],
      },
      sourceMode: "dictionary_llm_refined",
    };
    // 展开面板会先拉取 Agent 候选（Phase G），随后才是草稿与确认。
    apiFetchMock.mockResolvedValueOnce({ items: [] });
    apiFetchMock.mockResolvedValueOnce(draftResponse);
    apiFetchMock.mockResolvedValueOnce({ ok: true, itemCount: 1 });
    const onConfirmed = vi.fn();

    const container = render(
      createElement(WordL2Composer, { slug: "abound", onConfirmed }),
    );
    await act(async () => {
      fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    });

    // 展开 → 生成
    const genButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("AI 生成草稿"),
    );
    expect(genButton).toBeDefined();
    await act(async () => {
      fireEvent.click(genButton as HTMLButtonElement);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(apiFetchMock.mock.calls[0][0]).toBe("/l2/abound/candidates");
    expect(apiFetchMock.mock.calls[1][0]).toBe("/l2/abound/draft");
    // v1 wrapper 的 items 被提取展示
    expect(container.textContent).toContain("abound in");
    expect(container.textContent).toContain("abound with");
    expect(container.textContent).toContain("dictionary_llm_refined");

    // 取消勾选第一条 → confirm 只携带第二条
    const checkboxes = Array.from(container.querySelectorAll("input[type='checkbox']"));
    expect(checkboxes).toHaveLength(2);
    act(() => {
      fireEvent.click(checkboxes[0]);
    });

    const confirmButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("保存选中项"),
    );
    await act(async () => {
      fireEvent.click(confirmButton as HTMLButtonElement);
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(3);
    const [confirmPath, confirmInit] = apiFetchMock.mock.calls[2];
    expect(confirmPath).toBe("/l2/abound/confirm");
    const body = JSON.parse(String(confirmInit?.body ?? "{}")) as {
      field: string;
      items: Array<{ phrase: string }>;
      source: string;
    };
    expect(body.field).toBe("collocation");
    expect(body.source).toBe("manual");
    expect(body.items).toHaveLength(1);
    expect(body.items[0].phrase).toBe("abound with");
    // 确认成功 → 通知父级刷新详情缓存
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it("surfaces a readable message when the LLM budget is exhausted", async () => {
    apiFetchMock.mockResolvedValueOnce({ items: [] }); // 展开时拉取候选
    apiFetchMock.mockRejectedValueOnce(
      new BrowserApiError(503, { code: "OVER_BUDGET", message: "LLM usage budget exceeded" }),
    );
    const container = render(
      createElement(WordL2Composer, { slug: "abound", onConfirmed: vi.fn() }),
    );
    await act(async () => {
      fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    });
    const genButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("AI 生成草稿"),
    );
    await act(async () => {
      fireEvent.click(genButton as HTMLButtonElement);
    });
    expect(container.textContent).toContain("今日 LLM 预算已用尽");
    expect(container.textContent).toContain("外部生成");
  });

  it("shows Agent candidates and accepts the picked subset", async () => {
    // 展开时拉取候选 → 返回一条 2 条目的搭配候选
    apiFetchMock.mockResolvedValueOnce({
      items: [
        {
          id: "cand-1",
          field: "collocation",
          itemCount: 2,
          items: [
            { phrase: "abound in", gloss: "充满", tone: "neutral", example: "e1", exampleTranslation: "t1" },
            { phrase: "abound with", gloss: "满是", tone: "informal", example: "e2", exampleTranslation: "t2" },
          ],
          source: "external_chat",
          createdAt: "2026-09-05T00:00:00.000Z",
        },
      ],
    });
    // 切到 Agent 候选 tab → 同面板的管理区拉取生效内容行
    apiFetchMock.mockResolvedValueOnce({ active: [], retired: [] });
    apiFetchMock.mockResolvedValueOnce({ ok: true, itemCount: 1 }); // 保存
    apiFetchMock.mockResolvedValueOnce({ items: [] }); // 保存后刷新候选
    apiFetchMock.mockResolvedValueOnce({ active: [], retired: [] }); // 管理区刷新
    const onConfirmed = vi.fn();

    const container = render(
      createElement(WordL2Composer, { slug: "abound", onConfirmed }),
    );
    await act(async () => {
      fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    });

    // Agent 候选是独立顶层视图：默认生成视图下不渲染候选条目
    expect(container.textContent).toContain("Agent 候选");
    expect(container.querySelectorAll("input[type='checkbox']")).toHaveLength(0);
    // 切到 Agent 候选 tab → 候选区渲染 + 默认全选 + 管理区同屏
    const agentTab = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Agent 候选") && !b.textContent?.includes("扩展内容"),
    );
    await act(async () => {
      fireEvent.click(agentTab as HTMLButtonElement);
    });
    expect(container.textContent).toContain("external_chat");
    expect(container.textContent).toContain("管理生效内容");
    const checkboxes = Array.from(container.querySelectorAll("input[type='checkbox']"));
    expect(checkboxes).toHaveLength(2);

    // 取消勾选第一条 → 只保存第二条（itemIndexes=[1]）
    act(() => {
      fireEvent.click(checkboxes[0]);
    });
    const acceptButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("保存（1）"),
    );
    expect(acceptButton).toBeDefined();
    await act(async () => {
      fireEvent.click(acceptButton as HTMLButtonElement);
    });

    const [acceptPath, acceptInit] = apiFetchMock.mock.calls[2];
    expect(acceptPath).toBe("/l2/abound/candidates/cand-1/accept");
    expect(JSON.parse(String(acceptInit?.body ?? "{}"))).toEqual({ itemIndexes: [1] });
    // 保存成功 → 通知父级刷新详情 + 重拉候选 + 管理区刷新
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[3][0]).toBe("/l2/abound/candidates");
    expect(apiFetchMock.mock.calls[4][0]).toBe("/l2/abound/l2-rows");
  });

  it("管理区按存储字段过滤：已保存的例句行（corpus）在「例句」字段下可见", async () => {
    // 展开时拉取候选 → 空（例句候选已全部保存）
    apiFetchMock.mockResolvedValueOnce({ items: [] });
    // 切到 Agent 候选 tab → 管理区拉取生效内容行：一条已保存的例句（存储名 corpus）
    apiFetchMock.mockResolvedValueOnce({
      active: [
        {
          id: "row-corpus-1",
          field: "corpus",
          itemCount: 2,
          items: [
            { text: "She speaks English with a noticeable French accent.", translation: "她说英语时带着明显的法国口音。" },
          ],
          hiddenItems: [],
          hiddenCount: 0,
          source: "external_chat",
          sourceRef: null,
          approvedBy: "owner",
          approvedAt: "2026-09-05T00:00:00.000Z",
          createdAt: "2026-09-05T00:00:00.000Z",
        },
      ],
      retired: [],
    });

    const container = render(
      createElement(WordL2Composer, { slug: "abound", onConfirmed: vi.fn() }),
    );
    await act(async () => {
      fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    });
    const agentTab = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Agent 候选") && !b.textContent?.includes("扩展内容"),
    );
    await act(async () => {
      fireEvent.click(agentTab as HTMLButtonElement);
    });

    // 默认字段是「搭配」→ corpus 行被过滤，显示空态
    expect(container.textContent).toContain("「搭配」暂无生效内容行");

    // 切到「例句」字段 → fieldFilter 归一化为存储名 corpus → 行可见
    const exampleTab = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "例句",
    );
    await act(async () => {
      fireEvent.click(exampleTab as HTMLButtonElement);
    });
    expect(container.textContent).toContain("She speaks English with a noticeable French accent.");
    expect(container.textContent).toContain("例句");
    expect(container.textContent).toContain("生效 1 条");
    expect(container.textContent).not.toContain("暂无生效内容行");

    // 切回「搭配」→ 再次被过滤
    const collocationTab = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "搭配",
    );
    await act(async () => {
      fireEvent.click(collocationTab as HTMLButtonElement);
    });
    expect(container.textContent).not.toContain("She speaks English with a noticeable French accent.");
    expect(container.textContent).toContain("「搭配」暂无生效内容行");
  });

  it("rejects an Agent candidate via the ignore button", async () => {
    apiFetchMock.mockResolvedValueOnce({
      items: [
        {
          id: "cand-2",
          field: "synonym",
          itemCount: 1,
          items: [{ word: "teem", semanticDiff: "充满", tone: "formal", usage: "通用", delta: "近义", object: "物" }],
          source: "external_chat",
          createdAt: "2026-09-05T00:00:00.000Z",
        },
      ],
    });
    apiFetchMock.mockResolvedValueOnce({ active: [], retired: [] }); // 切 agent tab → 管理区拉取
    apiFetchMock.mockResolvedValueOnce({ ok: true }); // 驳回
    apiFetchMock.mockResolvedValueOnce({ items: [] }); // 驳回后刷新候选
    const onConfirmed = vi.fn();

    const container = render(
      createElement(WordL2Composer, { slug: "abound", onConfirmed }),
    );
    await act(async () => {
      fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    });
    // 候选是 synonym 字段 → 先切到「同义辨析」字段 tab（收件箱按字段筛选）
    const synonymTab = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "同义辨析",
    );
    await act(async () => {
      fireEvent.click(synonymTab as HTMLButtonElement);
    });
    // 再切到 Agent 候选收件箱（动作行子 tab）
    const agentTab = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Agent 候选") && !b.textContent?.includes("扩展内容"),
    );
    await act(async () => {
      fireEvent.click(agentTab as HTMLButtonElement);
    });

    const rejectButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("驳回"),
    );
    expect(rejectButton).toBeDefined();
    await act(async () => {
      fireEvent.click(rejectButton as HTMLButtonElement);
    });

    expect(apiFetchMock.mock.calls[2][0]).toBe("/l2/abound/candidates/cand-2/reject");
    // 驳回不触发详情刷新（管理区也不刷新——行未变）
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("shows an empty inbox hint when no Agent candidates exist", async () => {
    apiFetchMock.mockResolvedValueOnce({ items: [] });
    apiFetchMock.mockResolvedValueOnce({ active: [], retired: [] }); // 管理区拉取
    const container = render(
      createElement(WordL2Composer, { slug: "abound", onConfirmed: vi.fn() }),
    );
    await act(async () => {
      fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    });
    const agentTab = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Agent 候选") && !b.textContent?.includes("扩展内容"),
    );
    await act(async () => {
      fireEvent.click(agentTab as HTMLButtonElement);
    });
    expect(container.textContent).toContain("暂无 Agent 候选");
  });
});

describe("WordL2Manager（行级内容管理面板）", () => {
  const ROWS_RESPONSE = {
    active: [
      {
        id: "row-1",
        field: "corpus",
        itemCount: 2,
        items: [
          { text: "She speaks with an accent.", translation: "她说英语时带着明显的法国口音。", provenance: { source: "external_chat" } },
          { text: "In the word \"record\", the accent falls on the first syllable.", translation: "在 record 一词中，重音落在第一个音节。", provenance: { source: "external_chat" } },
        ],
        hiddenItems: [],
        hiddenCount: 0,
        source: "external_chat",
        sourceRef: "agent-demo-001",
        approvedBy: "user",
        approvedAt: "2026-09-05T09:40:00.000Z",
        createdAt: "2026-09-05T08:50:03.295Z",
      },
    ],
    retired: [],
  };

  it("条目化管理：完整详情展示，隐藏/恢复按条目精简保留（不删数据）", async () => {
    apiFetchMock.mockResolvedValueOnce(ROWS_RESPONSE); // 展开 → GET l2-rows
    apiFetchMock.mockResolvedValueOnce({ ok: true, remaining: 1, hiddenCount: 1 }); // 隐藏条目 0
    apiFetchMock.mockResolvedValueOnce({
      active: [
        {
          ...ROWS_RESPONSE.active[0],
          itemCount: 1,
          items: [ROWS_RESPONSE.active[0].items[1]],
          hiddenItems: [ROWS_RESPONSE.active[0].items[0]],
          hiddenCount: 1,
        },
      ],
      retired: [],
    }); // 重载

    const onChanged = vi.fn();
    const container = render(createElement(WordL2Manager, { slug: "accent", onChanged }));
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("管理生效内容"),
    );
    await act(async () => {
      fireEvent.click(toggle as HTMLButtonElement);
    });

    // 两条生成单元各自有独立的隐藏按钮（完整详情视图）
    const hideButtons = Array.from(container.querySelectorAll("[data-testid^='hide-item-']"));
    expect(hideButtons).toHaveLength(2);
    expect(container.textContent).toContain("She speaks with an accent.");
    expect(container.textContent).toContain("她说英语时带着明显的法国口音。");

    // 隐藏第一条 → POST items/0/hide → 父级刷新 + 重载
    await act(async () => {
      fireEvent.click(hideButtons[0]);
    });
    expect(apiFetchMock.mock.calls[1][0]).toBe("/l2/accent/l2-rows/row-1/items/0/hide");
    expect(apiFetchMock.mock.calls[1][1]?.method).toBe("POST");
    expect(onChanged).toHaveBeenCalledTimes(1);
    await act(async () => {});
    // 重载后：生效区只剩第二条，已隐藏区渲染第一条并带恢复按钮
    const hidesAfter = Array.from(container.querySelectorAll("[data-testid^='hide-item-']"));
    expect(hidesAfter).toHaveLength(1);
    expect(container.textContent).toContain("已隐藏 1 条");
    const restoreButton = container.querySelector("[data-testid='restore-item-0']");
    expect(restoreButton).not.toBeNull();
    expect(container.textContent).toContain("She speaks with an accent.");

    // 恢复 → POST hidden/0/restore
    apiFetchMock.mockResolvedValueOnce({ ok: true, remaining: 2, hiddenCount: 0 });
    apiFetchMock.mockResolvedValueOnce(ROWS_RESPONSE);
    await act(async () => {
      fireEvent.click(restoreButton as HTMLElement);
    });
    expect(apiFetchMock.mock.calls[3][0]).toBe("/l2/accent/l2-rows/row-1/hidden/0/restore");
    expect(apiFetchMock.mock.calls[3][1]?.method).toBe("POST");
  });

  it("expands, lists active rows with deactivate, and reloads after mutating", async () => {
    apiFetchMock.mockResolvedValueOnce(ROWS_RESPONSE); // 展开 → GET l2-rows
    apiFetchMock.mockResolvedValueOnce({ ok: true }); // 停用
    apiFetchMock.mockResolvedValueOnce({ active: [], retired: [ROWS_RESPONSE.active[0]] }); // 停用后重载

    const onChanged = vi.fn();
    const container = render(createElement(WordL2Manager, { slug: "accent", onChanged }));

    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("管理生效内容"),
    );
    expect(toggle).toBeDefined();
    await act(async () => {
      fireEvent.click(toggle as HTMLButtonElement);
    });

    expect(apiFetchMock.mock.calls[0][0]).toBe("/l2/accent/l2-rows");
    expect(container.textContent).toContain("例句");
    expect(container.textContent).toContain("生效 1 条");

    const deactivateButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("停用"),
    );
    await act(async () => {
      fireEvent.click(deactivateButton as HTMLButtonElement);
    });

    expect(apiFetchMock.mock.calls[1][0]).toBe("/l2/accent/l2-rows/row-1/deactivate");
    expect(apiFetchMock.mock.calls[1][1]?.method).toBe("POST");
    // 停用触发父级刷新（缓存已在服务端重算）
    expect(onChanged).toHaveBeenCalledTimes(1);
    // 重载后行进存档
    await act(async () => {});
    expect(container.textContent).toContain("存档 1 条");
  });

  it("hard delete requires window.confirm", async () => {
    apiFetchMock.mockResolvedValueOnce(ROWS_RESPONSE);
    apiFetchMock.mockResolvedValueOnce({ ok: true }); // 删除
    apiFetchMock.mockResolvedValueOnce({ active: [], retired: [] });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    const container = render(createElement(WordL2Manager, { slug: "accent", onChanged: vi.fn() }));
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("管理生效内容"),
    );
    await act(async () => {
      fireEvent.click(toggle as HTMLButtonElement);
    });

    const deleteButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("删除"),
    );
    await act(async () => {
      fireEvent.click(deleteButton as HTMLButtonElement);
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[1][0]).toBe("/l2/accent/l2-rows/row-1");
    expect(apiFetchMock.mock.calls[1][1]?.method).toBe("DELETE");
    confirmSpy.mockRestore();
  });

  it("shows a readable error when loading rows fails", async () => {
    apiFetchMock.mockRejectedValueOnce(
      new BrowserApiError(500, { code: "INTERNAL", message: "Internal server error" }),
    );
    const container = render(createElement(WordL2Manager, { slug: "accent", onChanged: vi.fn() }));
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("管理生效内容"),
    );
    await act(async () => {
      fireEvent.click(toggle as HTMLButtonElement);
    });
    expect(container.textContent).toContain("Internal server error");
  });

  it("does not call DELETE when the user cancels the confirm dialog", async () => {
    apiFetchMock.mockResolvedValueOnce(ROWS_RESPONSE);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const container = render(createElement(WordL2Manager, { slug: "accent", onChanged: vi.fn() }));
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("管理生效内容"),
    );
    await act(async () => {
      fireEvent.click(toggle as HTMLButtonElement);
    });
    const deleteButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("删除"),
    );
    await act(async () => {
      fireEvent.click(deleteButton as HTMLButtonElement);
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toHaveLength(0);
    confirmSpy.mockRestore();
  });
});
