/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * Task 09B 补批 · M14：IME 组合输入期间的关闭 / 切换笔记 / 离页（先红后绿）。
 *
 * 任务书 M14：「IME 组合中触发导航 → 组合期间无写；拒答导航；compositionend 后
 * 发送完整内容」。
 *
 * 关键区分（既有 09A 覆盖的是**控制器/编辑器**级 IME 语义；本文件补的是**宿主**级）：
 *  - 组合未结束时点「关闭侧栏」→ **不得**卸载编辑器、**不得**丢输入、不得请求关闭；
 *  - 组合未结束时切换笔记 → **不得**换身份（不丢 A 的未完成输入）；
 *  - 组合未结束时经宿主屏障离页 → **不得**执行真实导航；
 *  - compositionend 后保存的是**完整**文本，且此时再关闭/离页按正常屏障放行。
 *
 * 纪律：不依赖固定 sleep 模拟组合结束；组合状态由真实 compositionstart/end 驱动。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudyNotesClient } from "@/frontend/api/studyNotesClient";
import { StudyNoteSidePanel } from "@/frontend/components/studyNotes/StudyNoteSidePanel";
import type { NoteLeaveBarrier } from "@/frontend/state/sheetLeaveBarrier";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_A = "00000000-0000-4000-8000-000000000701";
const NOTE_B = "00000000-0000-4000-8000-000000000702";

function makeDto(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `标题-${id.slice(-3)}`,
    bodyMd: "原始正文",
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
    get: ReturnType<typeof vi.fn>;
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

/** 进入组合并写入未完成文本（真实 composition 事件）。 */
async function beginComposition(text: string): Promise<void> {
  const body = screen.getByTestId("note-body") as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.compositionStart(body);
    fireEvent.change(body, { target: { value: text } });
  });
}

describe("StudyNoteSidePanel · M14 IME 组合期间的关闭/切换/离页", () => {
  it("组合中关闭侧栏：不请求关闭、编辑器保持挂载、未完成输入保留", async () => {
    const client = makeClient();
    const onRequestClose = vi.fn();

    await render(
      createElement(StudyNoteSidePanel, { client, onRequestClose, initialNoteId: NOTE_A }),
    );
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());

    await beginComposition("组合中的未完成文本");
    await act(async () => {
      fireEvent.click(screen.getByTestId("study-note-panel-close"));
    });

    // 拒答：不请求关闭、编辑器仍在、未完成输入原样保留
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("study-note-editor")).toBeTruthy();
    expect((screen.getByTestId("note-body") as HTMLTextAreaElement).value).toBe("组合中的未完成文本");
    // 组合期间不发送
    expect(client.save).not.toHaveBeenCalled();
  });

  it("组合中切换笔记：不换身份，A 的未完成输入保留且不保存半成品", async () => {
    const client = makeClient();

    await render(
      createElement(StudyNoteSidePanel, { client, onRequestClose: () => {}, initialNoteId: NOTE_A }),
    );
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());

    await beginComposition("A 的组合输入");
    // 试图经「返回列表」换身份
    await act(async () => {
      fireEvent.click(screen.getByTestId("study-note-panel-back"));
    });

    // 仍在 A 的编辑器；输入未丢；未发送半成品
    expect(screen.getByTestId("study-note-editor")).toBeTruthy();
    expect((screen.getByTestId("note-body") as HTMLTextAreaElement).value).toBe("A 的组合输入");
    expect(client.save).not.toHaveBeenCalled();
  });

  it("组合中经宿主屏障离页：不执行真实导航", async () => {
    const client = makeClient();
    let barrier: NoteLeaveBarrier | null = null;

    await render(
      createElement(StudyNoteSidePanel, {
        client,
        onRequestClose: () => {},
        initialNoteId: NOTE_A,
        onRegisterNoteBarrier: (next: NoteLeaveBarrier | null) => {
          barrier = next;
        },
      }),
    );
    await waitFor(() => expect(barrier).not.toBeNull());

    await beginComposition("组合中的离页输入");
    const navigated = vi.fn();
    let outcome: { ok: boolean; reason?: string } | null = null;
    await act(async () => {
      outcome = (await barrier!(() => {
        navigated();
      })) as { ok: boolean; reason?: string };
    });

    expect(navigated).not.toHaveBeenCalled(); // 拒答
    expect(outcome!.ok).toBe(false);
    expect(outcome!.reason).toContain("输入法");
  });

  it("compositionend 后保存完整文本；此后关闭按正常屏障放行", async () => {
    const client = makeClient();
    const onRequestClose = vi.fn();

    await render(
      createElement(StudyNoteSidePanel, { client, onRequestClose, initialNoteId: NOTE_A }),
    );
    await waitFor(() => expect(screen.getByTestId("note-body")).toBeTruthy());

    await beginComposition("完整的中文输入");
    const body = screen.getByTestId("note-body");
    await act(async () => {
      fireEvent.compositionEnd(body);
    });

    // compositionend 后：完整文本落库（不截断半成品）
    await waitFor(() => expect(client.save).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(client.save.mock.calls[0][1].bodyMd).toContain("完整的中文输入");

    // 此时关闭：按正常屏障执行（保存已确认 → 放行）
    await act(async () => {
      fireEvent.click(screen.getByTestId("study-note-panel-close"));
    });
    await waitFor(() => expect(onRequestClose).toHaveBeenCalledTimes(1));
  });
});
