/// <reference lib="dom" />
// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WordL2Content } from "@/frontend/components/words/WordL2Content";
import { WordL2Composer } from "@/frontend/components/words/WordL2Composer";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import type { WordDetailL2Content } from "@/frontend/hooks/useWordDetail";

vi.mock("@/frontend/api/client", () => ({ apiFetch: vi.fn() }));

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
    apiFetchMock.mockResolvedValueOnce(draftResponse);
    apiFetchMock.mockResolvedValueOnce({ ok: true });
    const onConfirmed = vi.fn();

    const container = render(
      createElement(WordL2Composer, { slug: "abound", onConfirmed }),
    );
    act(() => {
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
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0][0]).toBe("/l2/abound/draft");
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
      (b) => b.textContent?.includes("采纳选中项"),
    );
    await act(async () => {
      fireEvent.click(confirmButton as HTMLButtonElement);
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    const [confirmPath, confirmInit] = apiFetchMock.mock.calls[1];
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
    apiFetchMock.mockRejectedValueOnce(
      new BrowserApiError(503, { code: "OVER_BUDGET", message: "LLM usage budget exceeded" }),
    );
    const container = render(
      createElement(WordL2Composer, { slug: "abound", onConfirmed: vi.fn() }),
    );
    act(() => {
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
});
