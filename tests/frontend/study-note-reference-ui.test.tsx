/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * Task 09A · 引用闭环组件测试（先红后绿）——真实编辑器 + 注入 fake client。
 *
 * 覆盖：picker 搜索（kind 切换/防抖）→ 预览 → 插入（marker + capture write + 计数）→
 * 卡片状态（current/changed/unavailable）→ 移除 → 转普通摘录 → 保存载荷含 references
 * → 重试载荷逐字节相同 → 重开（reload）一致。
 */
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudyNotesClient } from "@/frontend/api/studyNotesClient";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { StudyNoteEditor } from "@/frontend/components/studyNotes/StudyNoteEditor";
import type { StudyNoteDto } from "@/domain/l3-study-notes";
import { parseReferenceIds } from "@/domain/l3-study-notes";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_ID = "00000000-0000-4000-8000-000000000701";
const REF_ID = "00000000-0000-4000-8000-000000000801";
const SOURCE_ID = "00000000-0000-4000-8000-000000000901";
const QUESTION_ID = "00000000-0000-4000-8000-000000000902";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 打开时：1 current source 引用（marker 与集合一致）。 */
function makeDto(overrides: Partial<StudyNoteDto> = {}): StudyNoteDto {
  const bodyMd = `正文一\n\n[[ref:${REF_ID}]]\n\n正文二`;
  return {
    id: NOTE_ID,
    title: "初始标题",
    bodyMd,
    venues: ["cloze"],
    pinned: false,
    status: "active",
    version: 3,
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:30:00.000Z",
    references: [
      {
        id: REF_ID,
        target: { kind: "source", sourceId: SOURCE_ID },
        status: "current",
        capturedAt: "2026-09-20T00:10:00.000Z",
        displaySnapshot: { kind: "source", title: "来源A", excerpt: "摘录A" },
        liveTitle: "来源A",
      },
    ],
    ...overrides,
  };
}

interface ClientMocks {
  client: StudyNotesClient;
  get: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  searchTargets: ReturnType<typeof vi.fn>;
  preview: ReturnType<typeof vi.fn>;
}

function makeClient(): ClientMocks {
  const get = vi.fn();
  const save = vi.fn();
  const searchTargets = vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null });
  const preview = vi.fn();
  const client = { get, save, searchTargets, preview } as unknown as StudyNotesClient;
  return { client, get, save, searchTargets, preview };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

async function renderEditor(client: StudyNotesClient, options: { strict?: boolean } = {}): Promise<void> {
  await act(async () => {
    const editor = createElement(StudyNoteEditor, { noteId: NOTE_ID, client });
    root.render(options.strict ? createElement(StrictMode, null, editor) : editor);
  });
  await waitFor(() => expect(screen.queryByTestId("note-body")).not.toBeNull());
}

async function openPicker(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId("insert-reference-button"));
  });
  await waitFor(() => expect(screen.queryByTestId("reference-picker")).not.toBeNull());
}

function bodyValue(): string {
  return (screen.getByTestId("note-body") as HTMLTextAreaElement).value;
}

describe("StudyReferencePicker · 搜索与插入闭环", () => {
  it("打开 picker：发出 source 首页搜索（无 cursor）", async () => {
    const { client, get, searchTargets } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    await renderEditor(client);
    await openPicker();
    await waitFor(() => expect(searchTargets).toHaveBeenCalled());
    expect(searchTargets.mock.calls[0]![0]).toMatchObject({ kind: "source" });
    expect((searchTargets.mock.calls[0]![0] as { cursor?: string }).cursor).toBeUndefined();
  });

  it("切 kind 请求 question（清 cursor）；q 防抖后请求且无 cursor", async () => {
    const { client, get, searchTargets } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    searchTargets
      .mockResolvedValueOnce({ items: [{ id: SOURCE_ID, title: "来源A", createdAt: "x" }], total: 1, nextCursor: "c1" })
      .mockResolvedValue({ items: [], total: 0, nextCursor: null });
    await renderEditor(client);
    await openPicker();

    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-kind-question"));
    });
    await waitFor(() => expect(searchTargets.mock.calls.length).toBeGreaterThanOrEqual(2));
    const kindCall = searchTargets.mock.calls.at(-1)![0] as { kind: string; cursor?: string };
    expect(kindCall.kind).toBe("question");
    expect(kindCall.cursor).toBeUndefined(); // 切 kind 清 cursor

    await act(async () => {
      fireEvent.change(screen.getByTestId("ref-picker-q"), { target: { value: "原" } });
      fireEvent.change(screen.getByTestId("ref-picker-q"), { target: { value: "原文" } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350)); // 防抖窗口
    });
    await waitFor(() => {
      const last = searchTargets.mock.calls.at(-1)![0] as { q?: string; cursor?: string };
      expect(last.q).toBe("原文");
      expect(last.cursor).toBeUndefined();
    });
  });

  it("预览 → 插入：marker 进入正文、引用计数 +1、capture write 随保存提交", async () => {
    const { client, get, save, searchTargets, preview } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    searchTargets.mockResolvedValue({
      items: [{ id: SOURCE_ID, title: "来源A", createdAt: "2026-09-20T00:00:00.000Z" }],
      total: 1,
      nextCursor: null,
    });
    preview.mockResolvedValue({
      target: { kind: "source", sourceId: SOURCE_ID },
      displaySnapshot: { kind: "source", title: "来源A", excerpt: "摘录A" },
      liveTitle: "来源A",
    });
    save.mockResolvedValue({ item: makeDto() });

    await renderEditor(client);
    await openPicker();

    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-item"));
    });
    await waitFor(() => expect(screen.queryByTestId("ref-preview-card")).not.toBeNull());
    expect(preview).toHaveBeenCalledWith({ kind: "source", sourceId: SOURCE_ID });

    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-insert"));
    });

    const body = bodyValue();
    const ids = parseReferenceIds(body);
    expect(ids).toHaveLength(2); // 原 1 + 新 1
    expect(body).toContain("[[ref:");
    expect(screen.getByText(/引用 2 条/)).toBeTruthy();

    // 保存载荷：新增引用为 capture、原引用 keep；body 与新 marker 一致
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900)); // 800ms 防抖
    });
    await waitFor(() => expect(save).toHaveBeenCalled());
    const [savedId, payload] = save.mock.calls.at(-1) as [string, { bodyMd: string; references: Array<{ id: string; action: string }> }];
    expect(savedId).toBe(NOTE_ID);
    expect(payload.bodyMd).toBe(body);
    const captures = payload.references.filter((write) => write.action === "capture");
    expect(captures).toHaveLength(1);
    expect(captures[0]!.id).toBe(ids.find((id) => id !== REF_ID));
    expect(payload.references.find((write) => write.id === REF_ID)?.action).toBe("keep");
    expect(new Set(payload.references.map((write) => write.id))).toEqual(new Set(ids));
  });

  it("插入后保存失败重试：两次载荷逐字节相同（含 references，不丢引用）", async () => {
    const { client, get, save, searchTargets, preview } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    searchTargets.mockResolvedValue({
      items: [{ id: SOURCE_ID, title: "来源A", createdAt: "2026-09-20T00:00:00.000Z" }],
      total: 1,
      nextCursor: null,
    });
    preview.mockResolvedValue({
      target: { kind: "source", sourceId: SOURCE_ID },
      displaySnapshot: { kind: "source", title: "来源A", excerpt: "摘录A" },
      liveTitle: "来源A",
    });
    save.mockRejectedValueOnce(new Error("network down")).mockResolvedValue({ item: makeDto() });

    await renderEditor(client);
    await openPicker();
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-item"));
    });
    await waitFor(() => expect(screen.queryByTestId("ref-preview-card")).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-insert"));
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // 重试（网络类错误自动重试 1s）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1400));
    });
    await waitFor(() => expect(save.mock.calls.length).toBeGreaterThanOrEqual(2));
    const first = JSON.stringify(save.mock.calls[0]![1]);
    const second = JSON.stringify(save.mock.calls[1]![1]);
    expect(second).toBe(first); // 逐字节相同（含 references）
  });
});

describe("StudyReferenceCard · 状态与操作", () => {
  it("changed 引用显示 liveTitle 对照；unavailable 显示已失效且保留摘录", async () => {
    const { client, get } = makeClient();
    const dto = makeDto();
    get.mockResolvedValue({
      item: makeDto({
        bodyMd: `前\n\n[[ref:${REF_ID}]]\n\n中\n\n[[ref:00000000-0000-4000-8000-000000000802]]\n\n后`,
        references: [
          {
            ...dto.references[0]!,
            status: "changed",
            liveTitle: "来源A（已改名）",
          },
          {
            id: "00000000-0000-4000-8000-000000000802",
            target: { kind: "question", questionId: QUESTION_ID },
            status: "unavailable",
            capturedAt: "2026-09-20T00:11:00.000Z",
            displaySnapshot: { kind: "question", stem: "题干B", options: [], questionType: "cloze", sourceTitle: null },
            liveTitle: null,
          },
        ],
      }),
    });

    await renderEditor(client);
    await act(async () => {
      fireEvent.click(screen.getByText("预览"));
    });
    const cards = screen.getAllByTestId("reference-placeholder");
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("内容已变化");
    expect(cards[0]!.textContent).toContain("来源A（已改名）");
    expect(cards[1]!.textContent).toContain("引用已失效");
    expect(cards[1]!.textContent).toContain("题干B"); // 旧摘录保留
  });

  it("移除引用：marker 从正文删除、计数 -1、保存载荷不再包含该引用", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockResolvedValue({ item: makeDto() });

    await renderEditor(client);
    await act(async () => {
      fireEvent.click(screen.getByText("预览"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-card-remove"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("返回编辑"));
    });

    expect(bodyValue().includes(`[[ref:${REF_ID}]]`)).toBe(false);
    expect(screen.getByText(/引用 0 条/)).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    await waitFor(() => expect(save).toHaveBeenCalled());
    const payload = save.mock.calls.at(-1)![1] as { bodyMd: string; references: Array<{ id: string }> };
    expect(payload.references).toHaveLength(0);
    expect(parseReferenceIds(payload.bodyMd)).toHaveLength(0);
  });

  it("转普通摘录：marker 替换为引用块文本（保留独立摘录）、引用移除", async () => {
    const { client, get, save } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    save.mockResolvedValue({ item: makeDto() });

    await renderEditor(client);
    await act(async () => {
      fireEvent.click(screen.getByText("预览"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-card-convert"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("返回编辑"));
    });

    const body = bodyValue();
    expect(body).not.toContain("[[ref:");
    expect(body).toContain("> 「来源A」"); // 摘录保留（source 快照 title）
    expect(body).toContain("> —— 来源");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    await waitFor(() => expect(save).toHaveBeenCalled());
    const payload = save.mock.calls.at(-1)![1] as { references: unknown[] };
    expect(payload.references).toHaveLength(0);
  });

  it("重开一致：以保存后的 DTO 重新挂载，marker/卡片/计数一致", async () => {
    const { client, get } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    await renderEditor(client);
    expect(bodyValue()).toContain(`[[ref:${REF_ID}]]`);
    expect(screen.getByText(/引用 1 条/)).toBeTruthy();

    // 模拟重开（全新渲染 → get 返回同一 DTO）
    await act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await renderEditor(client);
    expect(bodyValue()).toContain(`[[ref:${REF_ID}]]`);
    expect(screen.getByText(/引用 1 条/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("预览"));
    });
    expect(screen.getAllByTestId("reference-placeholder")).toHaveLength(1);
  });
});

describe("StudyNoteEditor · 409 与引用保留（09A 验收）", () => {
  it("插入引用后 409：冲突面板出现、本地 marker 保留、复制本地内容含新引用、不自动重试", async () => {
    const { client, get, save, searchTargets, preview } = makeClient();
    get.mockResolvedValue({ item: makeDto() });
    searchTargets.mockResolvedValue({
      items: [{ id: SOURCE_ID, title: "来源A", createdAt: "2026-09-20T00:00:00.000Z" }],
      total: 1,
      nextCursor: null,
    });
    preview.mockResolvedValue({
      target: { kind: "source", sourceId: SOURCE_ID },
      displaySnapshot: { kind: "source", title: "来源A", excerpt: "摘录A" },
      liveTitle: "来源A",
    });
    save.mockRejectedValueOnce(
      new BrowserApiError(409, { error: "conflict", code: "CONFLICT", details: { noteId: NOTE_ID, currentVersion: 9 } }),
    );
    const clipboardWrite = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboardWrite }, configurable: true });

    await renderEditor(client);
    await openPicker();
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-item"));
    });
    await waitFor(() => expect(screen.queryByTestId("ref-preview-card")).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-insert"));
    });

    // 冲突面板出现；本地 marker（含新引用）保留
    await waitFor(() => expect(screen.getByTestId("conflict-panel")).toBeTruthy(), { timeout: 3000 });
    const body = bodyValue();
    const ids = parseReferenceIds(body);
    expect(ids).toHaveLength(2); // 原 1 + 新 1 均未丢
    expect(screen.getByText(/引用 2 条/)).toBeTruthy();

    // 复制本地内容：含新引用的引用清单
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制本地内容" }));
    });
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    const copied = clipboardWrite.mock.calls[0]![0] as string;
    expect(copied).toContain("引用清单（2 条）");
    const newRefId = ids.find((id) => id !== REF_ID)!;
    expect(copied).toContain(`[[ref:${newRefId}]]`);
    expect(copied).toContain(`[[ref:${REF_ID}]]`);

    // 冲突态不自动重试：等待超过自动重试窗口，save 仍只调用过一次
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1400));
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("复核补修 · StrictMode / 预览时效 / 插入光标", () => {
  function withSourceSearch() {
    const mocks = makeClient();
    mocks.get.mockResolvedValue({ item: makeDto() });
    mocks.searchTargets.mockResolvedValue({
      items: [{ id: SOURCE_ID, title: "来源A", createdAt: "2026-09-20T00:00:00.000Z" }],
      total: 1,
      nextCursor: null,
    });
    mocks.preview.mockResolvedValue({
      target: { kind: "source", sourceId: SOURCE_ID },
      displaySnapshot: { kind: "source", title: "来源A", excerpt: "摘录A" },
      liveTitle: "来源A",
    });
    mocks.save.mockResolvedValue({ item: makeDto() });
    return mocks;
  }

  it("StrictMode 双挂载：picker 仍可用（搜索发出、候选可见、可插入）", async () => {
    const { client } = withSourceSearch();
    await renderEditor(client, { strict: true });
    await openPicker();

    // 候选可见（复核缺陷：cleanup dispose 后不重建 → 永远停在“正在搜索…”，此断言即红）
    await waitFor(() => expect(screen.getAllByTestId("ref-picker-item").length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-item"));
    });
    await waitFor(() => expect(screen.queryByTestId("ref-preview-card")).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-insert"));
    });
    expect(parseReferenceIds(bodyValue())).toHaveLength(2); // 插入成功（双挂载下未被锁死）
  });

  it("筛选变化清除已就绪预览：切 kind 与改 q 后不可插入过期预览", async () => {
    const { client } = withSourceSearch();
    await renderEditor(client);
    await openPicker();
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-item"));
    });
    await waitFor(() => expect(screen.queryByTestId("ref-preview-card")).not.toBeNull());

    // 切 kind → 预览清除
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-kind-question"));
    });
    expect(screen.queryByTestId("ref-preview-card")).toBeNull();

    // 回 source、重新预览 → 改 q → 预览清除
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-kind-source"));
    });
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("ref-picker-item")[0]!);
    });
    await waitFor(() => expect(screen.queryByTestId("ref-preview-card")).not.toBeNull());
    await act(async () => {
      fireEvent.change(screen.getByTestId("ref-picker-q"), { target: { value: "新词" } });
    });
    expect(screen.queryByTestId("ref-preview-card")).toBeNull();
  });

  it("picker 打开后移动光标：插入位置以插入时选区为准（非打开时快照）", async () => {
    const { client } = withSourceSearch();
    await renderEditor(client);
    await openPicker();

    // 用户在面板打开期间回到正文移动光标（选区前移到位置 2）
    const textarea = screen.getByTestId("note-body") as HTMLTextAreaElement;
    await act(async () => {
      textarea.setSelectionRange(2, 2);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-item"));
    });
    await waitFor(() => expect(screen.queryByTestId("ref-preview-card")).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId("ref-picker-insert"));
    });

    const body = bodyValue();
    expect(parseReferenceIds(body)).toHaveLength(2);
    expect(body.startsWith("正文\n\n[[ref:")).toBe(true); // 位置 2 插入（打开时快照为 0 会插到文首）
    expect(body).toContain("一\n\n[[ref:");
  });
});
