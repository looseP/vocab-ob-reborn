/// <reference lib="dom" />
// @vitest-environment jsdom

/**
 * Task 10 · 前端导出（StudyNoteEditor ⇄ 09B 侧栏同一实现）。
 *
 * 断言目标（逐条对应任务书 §3.1 A15–A17 / §3.2 B2–B4 与简报 4/5/6）：
 *  - 顺序恰恰是 `flush → receipt.version → GET export → Blob 下载`（含「flush 未结算前
 *    不发 GET」的中间态）；
 *  - **persist reject / 409 / 网络错误 / 响应非法 → 导出未被调用或未下载任何旧文**；
 *  - `expectedVersion` 只用**保存成功后**的回执版本；
 *  - 双击、切笔记、侧栏关闭、IME 组合中都不触发错误下载；
 *  - 下载名取自服务端 `Content-Disposition`（本层用注入的下载器观察真实参数）。
 *
 * 注：组件测试用注入 fake client；真实 HTTP/DB 证据见 tests/http 与服务层用例。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import type { StudyNoteExportResult, StudyNotesClient } from "@/frontend/api/studyNotesClient";
import { StudyNoteEditor } from "@/frontend/components/studyNotes/StudyNoteEditor";
import { StudyNoteSidePanel } from "@/frontend/components/studyNotes/StudyNoteSidePanel";
import type { StudyNoteDto } from "@/domain/l3-study-notes";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const NOTE_ID = "00000000-0000-4000-8000-000000000701";
const OTHER_NOTE_ID = "00000000-0000-4000-8000-000000000702";
const REF_ID = "00000000-0000-4000-8000-000000000801";
const SOURCE_ID = "00000000-0000-4000-8000-000000000901";
const SERVER_FILENAME = `study-note-${NOTE_ID}.md`;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDto(overrides: Partial<StudyNoteDto> = {}): StudyNoteDto {
  return {
    id: NOTE_ID,
    title: "初始标题",
    bodyMd: `正文一\n\n[[ref:${REF_ID}]]\n\n正文二`,
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

function exportDto(): StudyNoteExportResult {
  return {
    markdown: "# 学习笔记档案（study-note v1）\n",
    filename: SERVER_FILENAME,
    sha256: "c".repeat(64),
    schemaVersion: 1,
  };
}

interface Harness {
  client: StudyNotesClient;
  get: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  exportNote: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  downloads: StudyNoteExportResult[];
  timeline: string[];
}

function makeHarness(options: { noteId?: string } = {}): Harness {
  const noteId = options.noteId ?? NOTE_ID;
  const timeline: string[] = [];
  const downloads: StudyNoteExportResult[] = [];
  const get = vi.fn(async () => ({ item: makeDto({ id: noteId }) }));
  const save = vi.fn(async (id: string, input: { expectedVersion: number }) => {
    timeline.push(`save:${id}:${input.expectedVersion}`);
    return { item: makeDto({ id, version: input.expectedVersion + 1, updatedAt: "2026-09-20T01:00:00.000Z" }) };
  });
  const exportNote = vi.fn(async (id: string, expectedVersion: number) => {
    timeline.push(`export:${id}:${expectedVersion}`);
    return exportDto();
  });
  const list = vi.fn(async () => ({ items: [], total: 0, nextCursor: null }));
  const client = { get, save, exportNote, list } as unknown as StudyNotesClient;
  return { client, get, save, exportNote, list, downloads, timeline };
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

/** 与两侧宿主一致：把下载效果注入编辑器（观察真实下载参数；不落真实文件）。 */
function downloadSpy(harness: Harness) {
  return (result: StudyNoteExportResult): void => {
    harness.timeline.push("download");
    harness.downloads.push(result);
  };
}

async function renderEditor(harness: Harness, options: { noteId?: string; leaveAction?: unknown } = {}): Promise<void> {
  const noteId = options.noteId ?? NOTE_ID;
  await act(async () => {
    root.render(
      createElement(StudyNoteEditor, {
        noteId,
        client: harness.client,
        downloadExport: downloadSpy(harness),
      }),
    );
  });
  await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());
}

describe("Task 10 · 编辑器页导出", () => {
  it("awaits flush before issuing the export GET（顺序：flush → GET(回执版本) → 下载）", async () => {
    const h = makeHarness();
    await renderEditor(h);

    await act(async () => {
      fireEvent.click(screen.getByTestId("export-note-button"));
    });
    await waitFor(() => expect(h.downloads).toHaveLength(1));

    // 干净笔记：flush 立即 resolve（回执版本 = 当前版本 3）→ GET 携带 3 → 下载
    expect(h.timeline).toEqual(["export:" + NOTE_ID + ":3", "download"]);
    expect(h.exportNote).toHaveBeenCalledTimes(1);
    expect(h.exportNote.mock.calls[0]![1]).toBe(3);
    // 下载用的文件名 = 服务端安全文件名（不是客户端自造）
    expect(h.downloads[0]!.filename).toBe(SERVER_FILENAME);
    expect(screen.getByTestId("export-notice").textContent).toContain(SERVER_FILENAME);
  });

  it("flushes dirty edits before exporting（脏内容先保存，导出用**保存后**的版本）", async () => {
    const h = makeHarness();
    await renderEditor(h);

    const pendingSave = defer<{ item: StudyNoteDto }>();
    h.save.mockReturnValueOnce(pendingSave.promise);

    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "导出前的新标题" } });
    });
    // 立即点导出：保存仍在防抖/在途 → 必须先 flush 才能 GET
    let clicked: Promise<unknown>;
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-note-button"));
      clicked = Promise.resolve();
    });
    expect(h.exportNote).not.toHaveBeenCalled(); // flush 未完成：零导出请求

    await act(async () => {
      pendingSave.resolve({ item: makeDto({ version: 4, updatedAt: "2026-09-20T02:00:00.000Z" }) });
    });
    await waitFor(() => expect(h.downloads).toHaveLength(1));
    await clicked!;

    const [, expected] = h.exportNote.mock.calls[0] as [string, number];
    expect(expected).toBe(4); // 保存确认后的版本，而不是初始 3
    expect(h.exportNote.mock.calls[0]![0]).toBe(NOTE_ID);
  });

  it("does not call export when persist rejects（保存失败 → 导出 0 次、无下载、有可见提示）", async () => {
    const h = makeHarness();
    await renderEditor(h);

    h.save.mockRejectedValueOnce(new BrowserApiError(422, { error: "Invalid", code: "VALIDATION_ERROR" }));
    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "会被拒绝" } });
    });
    await waitFor(() => expect(screen.getByTestId("error-panel")).toBeTruthy(), { timeout: 3000 });

    await act(async () => {
      fireEvent.click(screen.getByTestId("export-note-button"));
    });
    await waitFor(() => expect(screen.getByTestId("export-error")).toBeTruthy());

    expect(h.exportNote).toHaveBeenCalledTimes(0); // 核心断言：persist reject → 导出未被调用
    expect(h.downloads).toHaveLength(0);
    expect(screen.getByTestId("export-error").textContent).toContain("保存未完成");
  });

  it("surfaces 409 without downloading（服务端版本冲突 → 不下载，提示重新载入）", async () => {
    const h = makeHarness();
    await renderEditor(h);
    h.exportNote.mockRejectedValueOnce(
      new BrowserApiError(409, { code: "CONFLICT", details: { noteId: NOTE_ID, currentVersion: 9 } }),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("export-note-button"));
    });
    await waitFor(() => expect(screen.getByTestId("export-error")).toBeTruthy());

    expect(h.downloads).toHaveLength(0);
    expect(screen.getByTestId("export-error").textContent).toContain("已在其他地方更新");
  });

  it("does not download on network error or invalid response（网络/非法响应 → 不下载）", async () => {
    const network = makeHarness();
    await renderEditor(network);
    network.exportNote.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-note-button"));
    });
    await waitFor(() => expect(screen.getByTestId("export-error")).toBeTruthy());
    expect(network.downloads).toHaveLength(0);
    expect(screen.getByTestId("export-error").textContent).toContain("网络或服务异常");

    act(() => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const invalid = makeHarness();
    await renderEditor(invalid);
    invalid.exportNote.mockRejectedValueOnce(
      new BrowserApiError(200, { code: "INVALID_RESPONSE", message: "导出响应缺少合法的文件名" }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("export-note-button"));
    });
    await waitFor(() => expect(screen.getByTestId("export-error")).toBeTruthy());
    expect(invalid.downloads).toHaveLength(0);
    expect(screen.getByTestId("export-error").textContent).toContain("不符合合同");
  });

  it("ignores a double click while the export is in flight（双击 → 一次 flush、一次 GET、一次下载）", async () => {
    const h = makeHarness();
    await renderEditor(h);
    const pending = defer<StudyNoteExportResult>();
    h.exportNote.mockReturnValueOnce(pending.promise);

    const button = screen.getByTestId("export-note-button");
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button); // 双击第二下
      fireEvent.click(button);
    });
    expect(h.exportNote).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(exportDto());
    });
    await waitFor(() => expect(h.downloads).toHaveLength(1));
    expect(h.exportNote).toHaveBeenCalledTimes(1);
  });

  it("does not export during IME composition（组合输入中点击不触发导出，也不报错）", async () => {
    const h = makeHarness();
    await renderEditor(h);
    const body = screen.getByTestId("note-body");

    await act(async () => {
      fireEvent.compositionStart(body);
    });
    // 组合中的输入不完整：保存控制器会挂起；导出必须被拦在按钮层
    const pendingSave = defer<{ item: StudyNoteDto }>();
    h.save.mockReturnValueOnce(pendingSave.promise);
    await act(async () => {
      fireEvent.change(body, { target: { value: `正文一拼\n\n[[ref:${REF_ID}]]\n\n正文二` } });
      fireEvent.click(screen.getByTestId("export-note-button"));
    });
    expect(h.exportNote).toHaveBeenCalledTimes(0);
    expect(h.downloads).toHaveLength(0);
    expect(screen.queryByTestId("export-error")).toBeNull(); // 组合中被忽略 ≠ 失败

    await act(async () => {
      fireEvent.compositionEnd(body);
      pendingSave.resolve({ item: makeDto({ version: 4, updatedAt: "t" }) });
    });
  });

  it("does not download when the note is switched while the export is in flight（切笔记 → 丢弃结果）", async () => {
    const h = makeHarness();
    await renderEditor(h);
    const pending = defer<StudyNoteExportResult>();
    h.exportNote.mockReturnValueOnce(pending.promise);

    await act(async () => {
      fireEvent.click(screen.getByTestId("export-note-button"));
    });
    // 切到另一篇笔记（宿主换 noteId → 编辑器实例换代）
    h.get.mockResolvedValue({ item: makeDto({ id: OTHER_NOTE_ID }) });
    await act(async () => {
      root.render(
        createElement(StudyNoteEditor, {
          noteId: OTHER_NOTE_ID,
          client: h.client,
          downloadExport: downloadSpy(h),
        }),
      );
    });
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());

    await act(async () => {
      pending.resolve(exportDto());
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.downloads).toHaveLength(0); // 旧笔记的结果绝不下载
  });

  it("导出在途时锁编辑入口（action lock：不支持边导出边改内容）", async () => {
    const h = makeHarness();
    await renderEditor(h);
    const pending = defer<StudyNoteExportResult>();
    h.exportNote.mockReturnValueOnce(pending.promise);

    await act(async () => {
      fireEvent.click(screen.getByTestId("export-note-button"));
    });
    expect((screen.getByTestId("export-note-button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("export-note-button") as HTMLButtonElement).textContent).toContain("导出中");

    await act(async () => {
      pending.resolve(exportDto());
    });
    await waitFor(() =>
      expect((screen.getByTestId("export-note-button") as HTMLButtonElement).disabled).toBe(false),
    );
  });
});

describe("Task 10 · 09B 侧栏与编辑器页共用同一导出实现", () => {
  async function renderPanel(h: Harness): Promise<void> {
    await act(async () => {
      root.render(
        createElement(StudyNoteSidePanel, {
          client: h.client,
          venue: "cloze",
          onRequestClose: () => {},
          initialNoteId: NOTE_ID,
          downloadExport: downloadSpy(h),
        }),
      );
    });
    await waitFor(() => expect(screen.getByTestId("note-title")).toBeTruthy());
  }

  it("侧栏导出走同一条流水线（编辑器的 exportNote → flush → GET → 下载）", async () => {
    const h = makeHarness();
    await renderPanel(h);

    await act(async () => {
      fireEvent.click(screen.getByTestId("study-note-panel-export"));
    });
    await waitFor(() => expect(h.exportNote).toHaveBeenCalledTimes(1));

    expect(h.exportNote.mock.calls[0]![0]).toBe(NOTE_ID);
    expect(h.exportNote.mock.calls[0]![1]).toBe(3); // 保存确认后的权威版本
    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0]!.filename).toBe(SERVER_FILENAME);
  });

  it("侧栏导出同样在 persist reject 时不调用导出（共用失败分支）", async () => {
    const h = makeHarness();
    /**
     * 用**服务端确定拒绝**（422，控制器分类为 rejected：不自动重试）——500 属 unknown，
     * 会进入 1/2/4s 退避重试，错误面板数秒后才出现（那不是导出语义，只是测试时序）。
     */
    h.save.mockImplementation(async () => {
      throw new BrowserApiError(422, { error: "Invalid", code: "VALIDATION_ERROR" });
    });
    await renderPanel(h);

    await act(async () => {
      fireEvent.change(screen.getByTestId("note-title"), { target: { value: "会失败" } });
    });
    await waitFor(() => expect(screen.getByTestId("error-panel")).toBeTruthy(), { timeout: 4000 });

    await act(async () => {
      fireEvent.click(screen.getByTestId("study-note-panel-export"));
    });
    await waitFor(() => expect(screen.getByTestId("export-error")).toBeTruthy());
    expect(h.exportNote).toHaveBeenCalledTimes(0); // 共用同一失败分支：persist reject → 导出 0 次
    expect(h.downloads).toHaveLength(0);
  });

  it("返回列表（编辑器卸载）后导出动作解除注册：按钮禁用、点击零导出", async () => {
    const h = makeHarness();
    await renderPanel(h);
    const exportButton = screen.getByTestId("study-note-panel-export") as HTMLButtonElement;
    expect(exportButton.disabled).toBe(false); // 打开笔记时可用（真实入口，不是死按钮）

    // 返回列表 → 编辑器卸载 → 导出动作解除注册
    await act(async () => {
      fireEvent.click(screen.getByTestId("study-note-panel-back"));
    });
    await waitFor(() => expect(screen.queryByTestId("note-title")).toBeNull());
    await waitFor(() =>
      expect((screen.getByTestId("study-note-panel-export") as HTMLButtonElement).disabled).toBe(true),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("study-note-panel-export"));
    });
    expect(h.exportNote).toHaveBeenCalledTimes(0);
    expect(h.downloads).toHaveLength(0);
  });
});
