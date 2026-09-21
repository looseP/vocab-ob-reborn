/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * Task 09B · 侧栏关闭/切换屏障与题型筛选测试（先红后绿）。
 *
 * 语义（任务书 §1.3/§1.4/§1.8 + §3 不变量 4/6）：
 *  - **干净笔记**关闭：零写、直接卸载；
 *  - **脏笔记**关闭：保存成功后才卸载；失败/冲突期间**保留编辑器与本地输入**（不卸载）；
 *  - 切换笔记 A→B：同样先确认 A；A 保存失败**不换身份**（不丢 A 的本地输入）；
 *  - 题型筛选：只改列表查询，**不写回任何笔记归属**（不给现有笔记新增/移除归属）。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { L3_QUESTION_TYPES } from "@/domain/l3-question-types";
import type { StudyNoteSummary } from "@/domain/l3-study-notes";
import type { StudyNotesClient } from "@/frontend/api/studyNotesClient";
import { StudyNoteList } from "@/frontend/components/studyNotes/StudyNoteList";
import { StudyNoteSidePanel } from "@/frontend/components/studyNotes/StudyNoteSidePanel";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_A = "00000000-0000-4000-8000-000000000701";
const NOTE_B = "00000000-0000-4000-8000-000000000702";

function makeDto(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `标题-${id.slice(-3)}`,
    bodyMd: "正文",
    venues: ["cloze"] as const,
    pinned: false,
    status: "active" as const,
    version: 1,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    references: [],
    ...overrides,
  };
}

function makeClient() {
  return {
    list: vi.fn(async () => ({
      items: [
        { id: NOTE_A, title: "笔记A", venues: ["cloze"], status: "active", pinned: false, updatedAt: "2026-09-20T00:00:00.000Z" },
        { id: NOTE_B, title: "笔记B", venues: ["cloze"], status: "active", pinned: false, updatedAt: "2026-09-20T00:00:00.000Z" },
      ],
      nextCursor: null,
    })),
    get: vi.fn(async (id: string) => ({ item: makeDto(id) })),
    save: vi.fn(async (id: string, input: { bodyMd: string }) => ({
      item: makeDto(id, { version: 2, bodyMd: input.bodyMd }),
    })),
    create: vi.fn(async () => ({ item: makeDto("00000000-0000-4000-8000-000000000799") })),
    preview: vi.fn(),
    searchTargets: vi.fn(async () => ({ items: [], nextCursor: null })),
  } as unknown as StudyNotesClient & {
    save: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

describe("StudyNoteSidePanel · 关闭/切换屏障与筛选", () => {
  it("干净笔记关闭：零写、请求关闭", async () => {
    const client = makeClient();
    const onRequestClose = vi.fn();

    await render(
      createElement(StudyNoteSidePanel, {
        client,
        onRequestClose,
        initialNoteId: NOTE_A,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("study-note-panel-close"));
    });

    await waitFor(() => expect(onRequestClose).toHaveBeenCalledTimes(1));
    expect(client.save).not.toHaveBeenCalled(); // 干净笔记关闭零写
  });

  it("脏笔记关闭：保存成功后才请求关闭", async () => {
    const client = makeClient();
    const onRequestClose = vi.fn();

    await render(
      createElement(StudyNoteSidePanel, {
        client,
        onRequestClose,
        initialNoteId: NOTE_A,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());

    await act(async () => {
      fireEvent.change(screen.getByTestId("note-body"), {
        target: { value: "改动后的正文" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("study-note-panel-close"));
    });

    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(1));
    // 保存载荷必须是改动后的内容（不丢字）
    expect(client.save.mock.calls[0][1].bodyMd).toContain("改动后的正文");
    await waitFor(() => expect(onRequestClose).toHaveBeenCalledTimes(1));
  });

  it("脏笔记关闭且保存失败：不请求关闭（编辑器与本地输入保留）", async () => {
    const client = makeClient();
    client.save.mockRejectedValue(
      Object.assign(new Error("保存被拒绝"), { status: 422 }),
    );
    const onRequestClose = vi.fn();

    await render(
      createElement(StudyNoteSidePanel, {
        client,
        onRequestClose,
        initialNoteId: NOTE_A,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());

    await act(async () => {
      fireEvent.change(screen.getByTestId("note-body"), {
        target: { value: "无法保存的内容" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("study-note-panel-close"));
    });

    await waitFor(() => expect(client.save).toHaveBeenCalled());
    expect(onRequestClose).not.toHaveBeenCalled();
    // 本地输入保留（不丢字、不卸载编辑器）
    const body = screen.getByTestId("note-body") as HTMLTextAreaElement;
    expect(body.value).toContain("无法保存的内容");
  });

  it("切笔记 A→B 但 A 保存失败：不换身份，A 的编辑保留（不丢字）", async () => {
    const client = makeClient();
    client.save.mockRejectedValue(
      Object.assign(new Error("冲突"), { status: 409 }),
    );

    await render(
      createElement(StudyNoteSidePanel, {
        client,
        onRequestClose: () => {},
        initialNoteId: NOTE_A,
      }),
    );
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-body"), {
        target: { value: "A 的未保存改动" },
      });
    });

    // 试图返回列表（等价于换身份的第一步）
    await act(async () => {
      fireEvent.click(screen.getByTestId("study-note-panel-back"));
    });

    await waitFor(() => expect(client.save).toHaveBeenCalled());
    // 仍停在 A 的编辑器：列表没有出现，编辑内容保留
    expect(screen.queryByTestId("study-note-list")).toBeNull();
    const body = screen.getByTestId("note-body") as HTMLTextAreaElement;
    expect(body.value).toContain("A 的未保存改动");
  });

  it("题型筛选：只改列表查询，不写回任何笔记归属（零 PUT）", async () => {
    const client = makeClient();

    await render(
      createElement(StudyNoteSidePanel, {
        client,
        onRequestClose: () => {},
        venue: "cloze",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("study-note-panel-venue")).toBeTruthy());

    const before = client.list.mock.calls.length;
    await act(async () => {
      fireEvent.change(screen.getByTestId("study-note-panel-venue"), {
        target: { value: "reading_choice" },
      });
    });

    // 列表以新题型重新查询
    await waitFor(() => expect(client.list.mock.calls.length).toBeGreaterThan(before));
    const lastQuery = client.list.mock.calls[client.list.mock.calls.length - 1][0];
    expect(lastQuery.venue).toBe("reading_choice");
    // 零归属写入：筛选不是保存动作
    expect(client.save).not.toHaveBeenCalled();
  });

  it("整卷混合题型：可按筛选题型创建（创建用所选题型）", async () => {
    const client = makeClient();

    await render(
      createElement(StudyNoteSidePanel, { client, onRequestClose: () => {}, venue: "cloze" }),
    );
    await waitFor(() => expect(screen.getByTestId("study-note-panel-venue")).toBeTruthy());

    await act(async () => {
      fireEvent.change(screen.getByTestId("study-note-panel-venue"), {
        target: { value: "long_essay" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("study-note-panel-create"));
    });

    await waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    expect(client.create.mock.calls[0][0].venue).toBe("long_essay");
  });

  // ── 审查整改 F1（先红后绿）：题型筛选不得包含无后端语义的「全部题型」空值选项 ──
  // 契约：列表查询要求 venue 必填（l3StudyNoteListQuerySchema）；空值会落入
  // 「永不取数」路径并显示假空态（"还没有学习笔记"）。
  it("F1 回归：题型筛选不含空值选项（选项必须全部是真实题型）", async () => {
    const client = makeClient();

    await render(
      createElement(StudyNoteSidePanel, { client, onRequestClose: () => {}, venue: "cloze" }),
    );
    await waitFor(() => expect(screen.getByTestId("study-note-panel-venue")).toBeTruthy());

    const select = screen.getByTestId("study-note-panel-venue") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).not.toContain("");
    expect(values.every((value) => (L3_QUESTION_TYPES as readonly string[]).includes(value))).toBe(true);
  });

  it("F1 回归：每个筛选项都必须取数（不允许存在选择后不产生任何请求的选项）", async () => {
    const client = makeClient();
    await render(
      createElement(StudyNoteSidePanel, { client, onRequestClose: () => {}, venue: "cloze" }),
    );
    await waitFor(() => expect(screen.getAllByTestId("study-note-row").length).toBe(2));

    const select = screen.getByTestId("study-note-panel-venue") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values.length).toBeGreaterThan(0);

    for (const value of values) {
      if (value === select.value) continue; // 选择当前值属于幂等，不产生新请求
      const before = client.list.mock.calls.length;
      await act(async () => {
        fireEvent.change(select, { target: { value } });
      });
      await waitFor(() => expect(client.list.mock.calls.length).toBeGreaterThan(before));
      const lastQuery = client.list.mock.calls.at(-1)?.[0] as { venue?: unknown };
      expect(lastQuery.venue).toBe(value);
      await waitFor(() => expect(screen.getAllByTestId("study-note-row").length).toBe(2));
    }
  });
});

// ── 审查整改 F2（先红后绿）：未接入归档生命周期的宿主不得渲染归档/恢复控件 ──
describe("StudyNoteList · 归档入口按 handler 存在性渲染（审查整改 F2）", () => {
  const summaryRow: StudyNoteSummary = {
    id: NOTE_A,
    title: "笔记A",
    venues: ["cloze"],
    status: "active",
    pinned: false,
    updatedAt: "2026-09-20T00:00:00.000Z",
  };

  it("F2 回归：侧栏列表不渲染归档/恢复入口（无行为控件不得出现）", async () => {
    const client = makeClient();
    await render(createElement(StudyNoteSidePanel, { client, onRequestClose: () => {} }));
    await waitFor(() => expect(screen.getAllByTestId("study-note-row").length).toBe(2));

    expect(screen.queryAllByTestId("row-archive")).toHaveLength(0);
    expect(screen.queryAllByTestId("row-restore")).toHaveLength(0);
  });

  it("F2 回归（列表组件合同）：无 onArchiveToggle 时隐藏归档控件；提供时才渲染", async () => {
    const baseProps = {
      items: [summaryRow],
      total: 1,
      state: "ready" as const,
      error: null,
      loadingMore: false,
      nextCursor: null,
      activeNoteId: null,
      onOpen: vi.fn(),
      onLoadMore: vi.fn(),
      onRetry: vi.fn(),
      rowBusyId: null,
      rowError: null,
    };

    // 未提供 handler：不得渲染归档控件（无行为入口）
    await render(createElement(StudyNoteList, baseProps));
    await waitFor(() => expect(screen.getAllByTestId("study-note-row").length).toBe(1));
    expect(screen.queryAllByTestId("row-archive")).toHaveLength(0);

    // 提供 handler（笔记子空间等页面宿主）：恢复既有渲染
    await render(createElement(StudyNoteList, { ...baseProps, onArchiveToggle: vi.fn() }));
    await waitFor(() => expect(screen.getAllByTestId("row-archive").length).toBe(1));
  });
});
