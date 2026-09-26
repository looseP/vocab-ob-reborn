/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * 错题库枢纽（2026-09-26）—— 数据源换成统一投影（句级 + 题级两腿），按 kind
 * 分区，且每行必须给出一个**站内回流出口**（收错题的面能消费错题）。
 *
 * 相对旧版的口径变化（都是修缺陷，不是改需求）：
 *  - 旧：句级单腿 + cursor 分页 + 客户端按语境去重。cursor 走 attempts、显示按
 *    语境去重，两者口径不一致；同页两个数字会互相打架。
 *  - 新：两腿合并 + offset 分页（合并后生效）+ 服务端聚合（一条 target 一行）。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3ErrorBookPage } from "@/frontend/pages/L3ErrorBookPage";
import { normalizeL3Error, type L3FrontendClient } from "@/l3/frontend/contract";
import type { L3ErrorBookKind, L3ErrorBookPage as ErrorBookPage, L3UnifiedErrorBookItem } from "@/domain";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const SENTENCE_TARGET = "00000000-0000-4000-8000-000000000501";
const QUESTION_TARGET = "00000000-0000-4000-8000-000000000101";
const SOURCE = "00000000-0000-4000-8000-000000000302";
const SHEET = "00000000-0000-4000-8000-000000000401";

function item(kind: L3ErrorBookKind, overrides: Partial<L3UnifiedErrorBookItem> = {}): L3UnifiedErrorBookItem {
  const base = kind === "sentence"
    ? {
        kind: "sentence" as const,
        id: "attempt-1",
        target_id: SENTENCE_TARGET,
        target_label: "The vivid sunset faded.",
        target_secondary: null,
        source_id: SOURCE,
        source_title: "2023 Text2",
        question_type: null,
        space: "阅读",
        direction: "考研",
        sheet_id: null,
        practice_type: "essay_dictation",
        wrong_count: 2,
        latest_outcome: "wrong",
        latest_at: "2026-09-12T03:00:00.000Z",
      }
    : {
        kind: "question" as const,
        id: "grading-1",
        target_id: QUESTION_TARGET,
        target_label: "The author implies that the trend will continue.",
        target_secondary: "reading_choice",
        source_id: SOURCE,
        source_title: "2023 Text2",
        question_type: "reading_choice",
        space: "阅读",
        direction: "考研",
        sheet_id: SHEET,
        practice_type: null,
        wrong_count: 1,
        latest_outcome: "partial",
        latest_at: "2026-09-13T03:00:00.000Z",
      };
  return { ...base, ...overrides } as L3UnifiedErrorBookItem;
}

function page(
  items: L3UnifiedErrorBookItem[],
  overrides: Partial<ErrorBookPage> = {},
): ErrorBookPage {
  return { items, total: items.length, limit: 20, offset: 0, ...overrides };
}

const QUESTION_WRONG = item("question");
const SENTENCE_WRONG = item("sentence");

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function makeClient(overrides: Partial<L3FrontendClient> = {}): L3FrontendClient {
  return {
    listUnifiedErrorBook: vi.fn(async () => page([QUESTION_WRONG, SENTENCE_WRONG])),
    listAttempts: vi.fn(async () => ({ items: [], total: 0, limit: 100, offset: 0 })),
    ...overrides,
  } as unknown as L3FrontendClient;
}

async function mount(client: L3FrontendClient): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(L3ErrorBookPage, { client, onNavigate: vi.fn() }) as ReactElement,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => {
    for (const { root } of mountedRoots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("L3ErrorBookPage · 两腿分区", () => {
  it("题级与句级各自成区，标题带本页计数", async () => {
    await mount(makeClient());
    await waitFor(() => expect(screen.getByTestId("error-book-section-question")).toBeTruthy());
    expect(screen.getByTestId("error-book-section-sentence")).toBeTruthy();
    const heading = (kind: string) =>
      screen.getByTestId(`error-book-section-${kind}`).querySelector("h3")?.textContent ?? "";
    expect(heading("question")).toContain("题级");
    expect(heading("question")).toContain("本页 1 条");
    expect(heading("sentence")).toContain("句级");
    expect(heading("sentence")).toContain("本页 1 条");
  });

  it("题级行展示题型与最近判定（partial 如实显示「部分对」，不映射成句级词表）", async () => {
    await mount(makeClient());
    await waitFor(() => expect(screen.getByText(/题型：reading_choice/)).toBeTruthy());
    expect(screen.getByText(/最近判定：部分对 · 错误 1 次/)).toBeTruthy();
  });

  it("句级行展示练习类型与错误次数", async () => {
    await mount(makeClient());
    await waitFor(() => expect(screen.getByText(/练习类型：essay_dictation/)).toBeTruthy());
    expect(screen.getByText(/最近判定：错 · 错误 2 次/)).toBeTruthy();
  });

  it("不再回拉 attempts 窗口做客户端聚合（服务端已给聚合值）", async () => {
    const client = makeClient();
    await mount(client);
    await waitFor(() => expect(screen.getByTestId("error-book-row-question")).toBeTruthy());
    expect(client.listAttempts).not.toHaveBeenCalled();
  });

  it("计数口径一致：已加载数按条目计，不再与去重后的行数打架", async () => {
    await mount(makeClient({ listUnifiedErrorBook: vi.fn(async () => page([SENTENCE_WRONG], { total: 40 })) }));
    await waitFor(() => expect(screen.getByTestId("error-book-counter")).toBeTruthy());
    expect(screen.getByText("已加载 1 / 共 40 条")).toBeTruthy();
  });
});

describe("L3ErrorBookPage · 回流出口（P1-2 的核心）", () => {
  it("句级行给「再练一次」，落练习页并带 context 锚点", async () => {
    await mount(makeClient());
    await waitFor(() => expect(screen.getByTestId("error-book-retry-sentence")).toBeTruthy());
    expect(screen.getByTestId("error-book-retry-sentence").textContent).toBe("再练一次");
  });

  it("句级行同时保留「查看语境」取证出口（两个出口不互相取代）", async () => {
    await mount(makeClient());
    await waitFor(() => expect(screen.getByText("查看语境")).toBeTruthy());
  });

  it("题级行给「回看原题」", async () => {
    await mount(makeClient());
    await waitFor(() => expect(screen.getByTestId("error-book-retry-question")).toBeTruthy());
    expect(screen.getByTestId("error-book-retry-question").textContent).toBe("回看原题");
  });

  it("题既无来源也无题纸 → 不给死按钮，如实说明原因", async () => {
    const orphan = item("question", { source_id: null, source_title: null, sheet_id: null });
    await mount(makeClient({ listUnifiedErrorBook: vi.fn(async () => page([orphan])) }));
    await waitFor(() => expect(screen.getByText(/既无来源文件也无题纸/)).toBeTruthy());
    expect(screen.queryByTestId("error-book-retry-question")).toBeNull();
  });

  it("来源已删除时不编造来源名", async () => {
    const gone = item("sentence", { source_title: null });
    await mount(makeClient({ listUnifiedErrorBook: vi.fn(async () => page([gone])) }));
    await waitFor(() => expect(screen.getByText(/来源已删除/)).toBeTruthy());
  });
});

describe("L3ErrorBookPage · 筛选与分页", () => {
  it("两轴筛选变化即重查（回到第一页）", async () => {
    const client = makeClient();
    await mount(client);
    await waitFor(() => expect(client.listUnifiedErrorBook).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.listUnifiedErrorBook).mock.calls[0][0]).toMatchObject({
      space: null, direction: null, offset: 0,
    });

    const spaceSelect = document.querySelectorAll("select")[0];
    await act(async () => {
      fireEvent.change(spaceSelect, { target: { value: "阅读" } });
      await Promise.resolve();
    });

    await waitFor(() => expect(client.listUnifiedErrorBook).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.listUnifiedErrorBook).mock.calls[1][0]).toMatchObject({ space: "阅读", offset: 0 });
  });

  it("分页走 offset（合并后生效），续页追加而不是替换", async () => {
    const page2 = page([item("sentence", { id: "attempt-9", target_id: "00000000-0000-4000-8000-000000000599", target_label: "Second page sentence." })], { total: 40, offset: 20 });
    const list = vi.fn(async (params?: { offset?: number | null }) =>
      (params?.offset ?? 0) === 0 ? page([SENTENCE_WRONG], { total: 40 }) : page2);
    await mount(makeClient({ listUnifiedErrorBook: list }));

    await waitFor(() => expect(screen.getByText("加载更多")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("加载更多"));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list.mock.calls[1][0]).toMatchObject({ offset: 20 });
    await waitFor(() => expect(screen.getByText("Second page sentence.")).toBeTruthy());
    // 首屏那条仍在（续页追加，不是替换）
    expect(screen.getByText("The vivid sunset faded.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/已加载 2 \/ 共 40 条/)).toBeTruthy());
  });

  it("已加载数达到 total 时隐藏「加载更多」", async () => {
    const list = vi.fn(async (params?: { offset?: number | null }) =>
      (params?.offset ?? 0) === 0
        ? page([SENTENCE_WRONG], { total: 1 })
        : page([], { total: 1, offset: 1 }));
    await mount(makeClient({ listUnifiedErrorBook: list }));
    await waitFor(() => expect(screen.queryByText("加载更多")).toBeNull());
  });

  it("空态覆盖两腿（不是只提语境）", async () => {
    await mount(makeClient({ listUnifiedErrorBook: vi.fn(async () => page([], { total: 0 })) }));
    await waitFor(() => expect(screen.getByText(/做题判错（题级）与练习答错（句级）/)).toBeTruthy());
  });

  it("查询失败时给出归一化错误（不静默空态）", async () => {
    const failure = normalizeL3Error(422, { error: "Invalid space filter", code: "VALIDATION_ERROR" });
    await mount(makeClient({ listUnifiedErrorBook: vi.fn(async () => { throw failure; }) }));
    await waitFor(() => expect(screen.getByText(/HTTP 422/)).toBeTruthy());
    expect(screen.getByText(/Invalid space filter/)).toBeTruthy();
  });
});
