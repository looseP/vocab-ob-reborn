/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * T11 错题库（ADR-0019 §1/§3）：派生列表 + 两轴筛选 + 服务端聚合展示
 * （原句 / 目标词 / 最近作答 / 错误次数，跨分页窗口由服务端保证）+ cursor 分页。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3ErrorBookPage } from "@/frontend/pages/L3ErrorBookPage";
import { normalizeL3Error, type L3FrontendClient } from "@/l3/frontend/contract";
import type { L3PracticeErrorBookItem, L3PracticeErrorBookPage } from "@/domain";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

function errorBookItem(overrides: Partial<L3PracticeErrorBookItem>): L3PracticeErrorBookItem {
  return {
    id: "attempt-1",
    user_id: "u1",
    context_id: "ctx-1",
    occurrence_id: null,
    session_id: null,
    practice_type: "essay_dictation",
    outcome: "wrong",
    payload: {},
    created_at: "2026-09-12T01:00:00.000Z",
    wrongCount: 1,
    latestOutcome: "wrong",
    latestAt: "2026-09-12T01:00:00.000Z",
    ...overrides,
  };
}

function page(
  items: L3PracticeErrorBookItem[],
  overrides: Partial<L3PracticeErrorBookPage> = {},
): L3PracticeErrorBookPage {
  return { items, total: items.length, limit: 20, offset: 0, nextCursor: null, ...overrides };
}

const WRONG_LATEST = errorBookItem({
  id: "a2",
  context_id: "ctx-1",
  created_at: "2026-09-12T02:00:00.000Z",
  wrongCount: 2,
  latestOutcome: "correct",
  latestAt: "2026-09-12T03:00:00.000Z",
  payload: { taskId: "essay_dictation:abc", text: "The vivid sunset faded.", target: "vivid" },
});
const WRONG_OLDER = errorBookItem({
  id: "a1",
  context_id: "ctx-1",
  created_at: "2026-09-12T01:00:00.000Z",
  wrongCount: 2,
  latestOutcome: "correct",
  latestAt: "2026-09-12T03:00:00.000Z",
});

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function makeClient(overrides: Partial<L3FrontendClient> = {}): L3FrontendClient {
  return {
    listErrorBook: vi.fn(async () => page([WRONG_LATEST, WRONG_OLDER])),
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
    root.render(createElement(L3ErrorBookPage, { client, onNavigate: vi.fn() }) as ReactElement);
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

describe("L3ErrorBookPage", () => {
  it("renders one row per context with server-aggregated wrong count and latest outcome", async () => {
    const client = makeClient();
    await mount(client);

    await waitFor(() => expect(screen.getByText("The vivid sunset faded.")).toBeTruthy());
    expect(screen.getByText(/目标词：vivid · 错误 2 次/)).toBeTruthy();
    expect(screen.getByText(/最近作答：正确/)).toBeTruthy();
    // 两个 wrong 行聚合为一行（同一语境）；聚合来自服务端，不再拉 attempts 回看窗口。
    expect(screen.getAllByText(/The vivid sunset faded\./).length).toBe(1);
    expect(client.listAttempts).not.toHaveBeenCalled();
    expect(screen.queryByText(/按本页可见记录计数/)).toBeNull();
  });

  it("re-queries when the space filter changes", async () => {
    const client = makeClient();
    await mount(client);
    await waitFor(() => expect(client.listErrorBook).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.listErrorBook).mock.calls[0][0]).toMatchObject({ space: null, direction: null });

    const spaceSelect = document.querySelectorAll("select")[0];
    await act(async () => {
      fireEvent.change(spaceSelect, { target: { value: "阅读" } });
      await Promise.resolve();
    });

    await waitFor(() => expect(client.listErrorBook).toHaveBeenCalledTimes(2));
    expect(vi.mocked(client.listErrorBook).mock.calls[1][0]).toMatchObject({ space: "阅读" });
  });

  it("renders the empty state for an empty error book", async () => {
    const client = makeClient({
      listErrorBook: vi.fn(async () => page([], { total: 0 })),
    });
    await mount(client);
    await waitFor(() => expect(screen.getByText(/错题库为空/)).toBeTruthy());
  });

  it("surfaces a normalized error when the query fails", async () => {
    const failure = normalizeL3Error(422, { error: "Invalid space filter", code: "VALIDATION_ERROR" });
    const client = makeClient({
      listErrorBook: vi.fn(async () => { throw failure; }),
    });
    await mount(client);
    await waitFor(() => expect(screen.getByText(/HTTP 422/)).toBeTruthy());
    expect(screen.getByText(/Invalid space filter/)).toBeTruthy();
  });

  it("loads more rows with the cursor from nextCursor and hides the button at the end", async () => {
    const page1 = page([WRONG_LATEST, WRONG_OLDER], { total: 40, nextCursor: "cursor-2" });
    const page2 = page(
      [
        errorBookItem({
          id: "a9",
          context_id: "ctx-9",
          created_at: "2026-09-12T00:30:00.000Z",
          payload: { text: "Second page sentence.", target: "page" },
        }),
      ],
      { total: 40 },
    );
    const listErrorBook = vi.fn(async (params?: { cursor?: string | null }) =>
      params?.cursor === "cursor-2" ? page2 : page1,
    );
    const client = makeClient({ listErrorBook });
    await mount(client);
    await waitFor(() => expect(screen.getByText("加载更多")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("加载更多"));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(listErrorBook).toHaveBeenCalledTimes(2));
    expect(listErrorBook.mock.calls[1][0]).toMatchObject({ cursor: "cursor-2" });
    await waitFor(() => expect(screen.getByText("Second page sentence.")).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/已加载 3 \/ 共 40 条/)).toBeTruthy());
    // nextCursor=null → 「加载更多」消失（已到末页）。
    await waitFor(() => expect(screen.queryByText("加载更多")).toBeNull());
  });
});
