/// <reference lib="dom" />
// @vitest-environment jsdom
/**
 * T11 会话壳边界（ADR-0019 §2 / ADR-0028）：
 * ① 引用实体已被删除 → 「已删除」占位（不白屏）；
 * ② 未知 plan version（422 BUSINESS_RULE）→ 「会话计划版本已过期，请重建」；
 * ③ 创建 → 现拉现渲染 → 结束的完整链路。
 */
import { act } from "react";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3SessionPage } from "@/frontend/pages/L3SessionPage";
import { normalizeL3Error, type L3FrontendClient } from "@/l3/frontend/contract";
import type { L3SessionRenderDescription } from "@/domain";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

function makeClient(overrides: Partial<L3FrontendClient> = {}): L3FrontendClient {
  return {
    createSession: vi.fn(),
    getSession: vi.fn(),
    endSession: vi.fn(),
    ...overrides,
  } as unknown as L3FrontendClient;
}

function sessionRow() {
  return {
    id: "sess-1",
    user_id: "u1",
    type: "cram_pack" as const,
    title: "考前攻坚",
    plan: {
      version: 1,
      days: 2,
      seed: "seed-1",
      items: [
        { day: 1, contextIds: ["ctx-1", "ctx-2"] },
        { day: 2, contextIds: ["ctx-3"] },
      ],
    },
    version: 1,
    status: "active" as const,
    started_at: "2026-09-12T01:00:00.000Z",
    ended_at: null,
    created_at: "2026-09-12T01:00:00.000Z",
  };
}

function renderDescription(): L3SessionRenderDescription {
  return {
    session: sessionRow(),
    items: [
      {
        day: 1,
        contexts: [{
          id: "ctx-1",
          text: "A vivid sentence survives.",
          context_type: "sentence",
          source_id: "src-1",
          source_title: "来源 A",
        }],
      },
      { day: 2, contexts: [] },
    ],
  };
}

async function mount(client: L3FrontendClient): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container });
  await act(async () => {
    root.render(createElement(L3SessionPage, { client, onNavigate: vi.fn() }) as ReactElement);
    await Promise.resolve();
  });
}

async function clickCreate(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByText("创建攻坚包"));
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

describe("L3SessionPage", () => {
  it("renders the plan reference with a deleted placeholder for missing contexts", async () => {
    const client = makeClient({
      createSession: vi.fn(async () => sessionRow()),
      getSession: vi.fn(async () => renderDescription()),
    });
    await mount(client);
    await clickCreate();

    await waitFor(() => expect(screen.getByText(/A vivid sentence survives\./)).toBeTruthy());
    expect(screen.getByText(/来源 A/)).toBeTruthy();
    // ctx-2（第 1 天）与 ctx-3（第 2 天）在渲染结果中缺失 → 已删除占位
    await waitFor(() => expect(screen.getAllByText(/已删除/).length).toBe(2));
    expect(screen.getByText(/ctx-2/)).toBeTruthy();
    expect(screen.getByText(/ctx-3/)).toBeTruthy();
  });

  it("surfaces an expired plan version instead of silently degrading", async () => {
    const expired = normalizeL3Error(422, {
      error: "Unsupported L3 session plan version: 9",
      code: "BUSINESS_RULE",
    });
    const client = makeClient({
      createSession: vi.fn(async () => sessionRow()),
      getSession: vi.fn(async () => { throw expired; }),
    });
    await mount(client);
    await clickCreate();

    await waitFor(() => expect(screen.getByText("会话计划版本已过期，请重建")).toBeTruthy());
    expect(screen.getByText(/Unsupported L3 session plan version: 9/)).toBeTruthy();
  });

  it("never white-screens when the plan payload is malformed", async () => {
    const malformed = renderDescription();
    const client = makeClient({
      createSession: vi.fn(async () => sessionRow()),
      getSession: vi.fn(async () => ({
        ...malformed,
        session: { ...malformed.session, plan: "not-an-object" as never },
      })),
    });
    await mount(client);
    await clickCreate();

    // 渲染结果仍展示：plan 解析失败不阻断（容错为空引用，不抛错、不白屏）
    await waitFor(() => expect(screen.getByText(/A vivid sentence survives\./)).toBeTruthy());
  });

  it("creates, renders, and ends a cram session", async () => {
    const ended = { ...sessionRow(), status: "completed" as const, ended_at: "2026-09-12T02:00:00.000Z" };
    const client = makeClient({
      createSession: vi.fn(async () => sessionRow()),
      getSession: vi.fn(async () => renderDescription()),
      endSession: vi.fn(async () => ended),
    });
    await mount(client);
    await clickCreate();

    await waitFor(() => expect(screen.getByText("完成")).toBeTruthy());
    expect(client.createSession).toHaveBeenCalledWith({
      type: "cram_pack",
      title: null,
      space: null,
      direction: null,
      contextCount: 20,
      days: 7,
    });

    await act(async () => {
      fireEvent.click(screen.getByText("完成"));
      await Promise.resolve();
    });
    expect(client.endSession).toHaveBeenCalledWith("sess-1", "completed");
    await waitFor(() => expect(screen.getByText(/已完成/)).toBeTruthy());
  });

  it("rejects a malformed count with a local note before any request", async () => {
    const client = makeClient({ createSession: vi.fn(async () => sessionRow()) });
    await mount(client);
    const countInput = document.querySelectorAll('input[type="number"]')[0];
    await act(async () => {
      fireEvent.change(countInput, { target: { value: "0" } });
    });
    await clickCreate();

    await waitFor(() => expect(screen.getByText("题量必须是正整数。")).toBeTruthy());
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it("resets to the create form after an expired plan version", async () => {
    const expired = normalizeL3Error(422, {
      error: "Unsupported L3 session plan version: 9",
      code: "BUSINESS_RULE",
    });
    const client = makeClient({
      createSession: vi.fn(async () => sessionRow()),
      getSession: vi.fn(async () => { throw expired; }),
    });
    await mount(client);
    await clickCreate();

    await waitFor(() => expect(screen.getByText("会话计划版本已过期，请重建")).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByText("重建会话"));
      await Promise.resolve();
    });
    expect(screen.queryByText("会话计划版本已过期，请重建")).toBeNull();
  });

  it("re-renders on demand via the refresh action", async () => {
    const client = makeClient({
      createSession: vi.fn(async () => sessionRow()),
      getSession: vi.fn(async () => renderDescription()),
    });
    await mount(client);
    await clickCreate();
    await waitFor(() => expect(screen.getByText("刷新渲染")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText("刷新渲染"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.getSession).toHaveBeenCalledTimes(2);
  });

  it("abandons a session after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const abandoned = { ...sessionRow(), status: "abandoned" as const, ended_at: "2026-09-12T03:00:00.000Z" };
      const client = makeClient({
        createSession: vi.fn(async () => sessionRow()),
        getSession: vi.fn(async () => renderDescription()),
        endSession: vi.fn(async () => abandoned),
      });
      await mount(client);
      await clickCreate();
      await waitFor(() => expect(screen.getByText("放弃")).toBeTruthy());

      await act(async () => {
        fireEvent.click(screen.getByText("放弃"));
        await Promise.resolve();
      });
      expect(confirmSpy).toHaveBeenCalled();
      expect(client.endSession).toHaveBeenCalledWith("sess-1", "abandoned");
      await waitFor(() => expect(screen.getByText(/已放弃/)).toBeTruthy());
    } finally {
      confirmSpy.mockRestore();
    }
  });
});
