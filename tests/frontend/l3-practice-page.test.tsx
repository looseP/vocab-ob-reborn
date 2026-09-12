/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * T11 练习台（ADR-0019 §1/§3）：
 * ① 默写：挖空 → 输入判定 → POST attempts（outcome 与 payload 快照）；
 * ② 记录版语境自测：复用 Reveal 交互，作答即记录；
 * ③ 幂等键 = T04 形状 taskId（Web Crypto 派生）；
 * ④ 文案红线：不出现 FSRS / 「复习排程」暗示。
 */
import { webcrypto } from "node:crypto";
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3PracticePage } from "@/frontend/pages/L3PracticePage";
import { normalizeL3Error, type L3FrontendClient } from "@/l3/frontend/contract";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom 不保证提供 crypto.subtle；练习台只在提交时惰性读取，这里补一个真实现。 */
function ensureWebCrypto(): void {
  const current = globalThis.crypto as (Crypto & { subtle?: SubtleCrypto }) | undefined;
  if (current && current.subtle) return;
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
    return;
  } catch {
    // 落到下一分支
  }
  if (current) {
    Object.defineProperty(current, "subtle", { configurable: true, value: webcrypto.subtle });
  }
}

const OCCURRENCE_ITEM = {
  occurrence: {
    id: "occ-1",
    context_id: "ctx-1",
    word_id: "w1",
    user_id: "u1",
    surface: "vivid",
    lemma: null,
    start_offset: null,
    end_offset: null,
    confidence: null,
    evidence: {},
    bound_sense: "生动鲜明的",
    created_at: "2026-09-12T00:00:00.000Z",
  },
  word: { id: "w1", slug: "vivid", title: "vivid" },
  context: {
    id: "ctx-1",
    source_id: "src-1",
    user_id: "u1",
    context_type: "sentence",
    text: "The vivid sunset faded.",
    normalized_text: null,
    language: "en",
    position: {},
    metadata: {},
    created_at: "2026-09-12T00:00:00.000Z",
    updated_at: "2026-09-12T00:00:00.000Z",
  },
  source: {
    id: "src-1",
    user_id: "u1",
    wordbook_id: "wb-1",
    source_type: "manual",
    title: "来源 A",
    author: null,
    url: null,
    language: "en",
    metadata: {},
    content_text: null,
    content_hash: null,
    created_at: "2026-09-12T00:00:00.000Z",
    updated_at: "2026-09-12T00:00:00.000Z",
  },
};

const PAGE = { items: [OCCURRENCE_ITEM], limit: 20, cursor: null, nextCursor: null };

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function makeClient(overrides: Partial<L3FrontendClient> = {}): L3FrontendClient {
  return {
    listOccurrences: vi.fn(async () => PAGE),
    recordAttempt: vi.fn(async () => ({ id: "attempt-1" })),
    ...overrides,
  } as unknown as L3FrontendClient;
}

async function mount(client: L3FrontendClient): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(createElement(L3PracticePage, { client, onNavigate: vi.fn() }) as ReactElement);
    await Promise.resolve();
  });
}

async function clickButton(text: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByText(text));
    await Promise.resolve();
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
  ensureWebCrypto();
});

describe("L3PracticePage", () => {
  it("dictation: blanks the target, judges the input, and records the outcome", async () => {
    const client = makeClient();
    await mount(client);
    await clickButton("开始练习");

    await waitFor(() => expect(screen.getByText(/The ____ sunset faded\./)).toBeTruthy());
    const input = screen.getByPlaceholderText("输入空位处的原文片段");
    await act(async () => {
      fireEvent.change(input, { target: { value: "bright" } });
    });
    await clickButton("提交判定");

    await waitFor(() => expect(client.recordAttempt).toHaveBeenCalledTimes(1));
    const called = vi.mocked(client.recordAttempt).mock.calls[0][0];
    expect(called).toMatchObject({
      contextId: "ctx-1",
      occurrenceId: "occ-1",
      sessionId: null,
      practiceType: "essay_dictation",
      outcome: "wrong",
    });
    expect(called.payload.taskId).toMatch(/^essay_dictation:[0-9a-f]{16}$/);
    expect(called.payload.input).toBe("bright");
    expect(called.payload.text).toBe("The vivid sunset faded.");
    expect(called.payload.expected).toBe("vivid");

    await waitFor(() => expect(screen.getByText(/本批完成/)).toBeTruthy());
    expect(screen.getByText(/已记录 1 题：正确 0 \/ 错误 1 \/ 跳过 0/)).toBeTruthy();
  });

  it("recorded context quiz: reveals the bound sense and records a self assessment", async () => {
    const client = makeClient();
    await mount(client);
    const typeSelect = document.querySelectorAll("select")[0];
    await act(async () => {
      fireEvent.change(typeSelect, { target: { value: "context_quiz" } });
    });
    await clickButton("开始练习");

    // 目标词以 <mark> 高亮，句子被多元素拆分 → 用 textContent 断言整句
    await waitFor(() => expect(document.body.textContent ?? "").toContain("The vivid sunset faded."));
    expect(screen.getAllByTestId("reveal").length).toBe(1);
    await clickButton("想起来了");

    await waitFor(() => expect(client.recordAttempt).toHaveBeenCalledTimes(1));
    const called = vi.mocked(client.recordAttempt).mock.calls[0][0];
    expect(called).toMatchObject({ practiceType: "context_quiz", outcome: "correct" });
    expect(called.payload.taskId).toMatch(/^context_quiz:[0-9a-f]{16}$/);
  });

  it("shows an empty-state when no material is available", async () => {
    const client = makeClient({
      listOccurrences: vi.fn(async () => ({ items: [], limit: 20, cursor: null, nextCursor: null })),
    });
    await mount(client);
    await clickButton("开始练习");

    await waitFor(() => expect(screen.getByText(/当前筛选下没有可练习的素材/)).toBeTruthy());
    expect(client.recordAttempt).not.toHaveBeenCalled();
  });

  it("keeps practice copy free of any scheduling implication", async () => {
    const client = makeClient();
    await mount(client);
    const text = document.body.textContent ?? "";
    expect(text).toContain("不改动任何其他学习数据");
    expect(text).not.toMatch(/FSRS/);
    expect(text).not.toMatch(/复习排程/);
    expect(text).not.toMatch(/间隔重复/);
  });

  it("records a skip outcome from the dictation card", async () => {
    const client = makeClient();
    await mount(client);
    await clickButton("开始练习");
    await waitFor(() => expect(screen.getByText(/The ____ sunset faded\./)).toBeTruthy());

    await clickButton("跳过");

    await waitFor(() => expect(client.recordAttempt).toHaveBeenCalledTimes(1));
    const called = vi.mocked(client.recordAttempt).mock.calls[0][0];
    expect(called).toMatchObject({ practiceType: "essay_dictation", outcome: "skip" });
    expect(called.payload.input).toBeNull();
    await waitFor(() => expect(screen.getByText(/已记录 1 题：正确 0 \/ 错误 0 \/ 跳过 1/)).toBeTruthy());
  });

  it("shows the normalized error when material loading fails", async () => {
    const failure = normalizeL3Error(500, { error: "boom", code: "INTERNAL" });
    const client = makeClient({
      listOccurrences: vi.fn(async () => { throw failure; }),
    });
    await mount(client);
    await clickButton("开始练习");

    await waitFor(() => expect(screen.getByText(/HTTP 500/)).toBeTruthy());
    expect(client.recordAttempt).not.toHaveBeenCalled();
  });
});
