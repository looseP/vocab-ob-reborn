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
import type { StudyNotesClient } from "@/frontend/api/studyNotesClient";
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
});
