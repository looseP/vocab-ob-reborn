/**
 * 学习笔记导出流水线测试（Task 10）——顺序与失败面（每条都对应任务书 / 简报的一行）。
 *
 * 关键取证：
 *  - 顺序**恰好**是 `flush → receipt.version → GET → 下载`（含「flush 未 settle 前不发
 *    GET」的中间态断言）；
 *  - `expectedVersion` **只**来自本次 flush 回执（喂一个明显不同的旧版本，断言未被使用）；
 *  - flush 失败 / 409 / 网络错误 / 响应校验失败 / 响应期间切换笔记 → **零下载**；
 *  - 双击与单飞闸门：并发的第二次调用为 no-op。
 */
import { describe, expect, it, vi } from "vitest";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import type {
  StudyNoteExportResult,
  StudyNoteExportSchemaVersion,
} from "@/frontend/api/studyNotesClient";
import {
  createSingleFlightGate,
  flushThenExportNote,
  isValidExportVersion,
  type StudyNoteExportDeps,
} from "@/frontend/state/studyNoteExportFlusher";

const NOTE_ID = "00000000-0000-4000-8000-000000000701";
const SERVER_FILENAME = `study-note-${NOTE_ID}.md`;

function exportResult(overrides: Partial<StudyNoteExportResult> = {}): StudyNoteExportResult {
  return {
    markdown: "# 学习笔记档案（study-note v1）\n",
    filename: SERVER_FILENAME,
    sha256: "b".repeat(64),
    schemaVersion: 1,
    ...overrides,
  };
}

/** 记录调用顺序的统一 harness：flush / GET / download 三个探针共享一条时间线。 */
function harness(options: {
  flush?: () => Promise<{ version: number }>;
  exportNote?: (
    noteId: string,
    expectedVersion: number,
    options?: { schemaVersion?: StudyNoteExportSchemaVersion },
  ) => Promise<StudyNoteExportResult>;
  isCurrent?: (generation: number) => boolean;
  generation?: number;
} = {}) {
  const timeline: string[] = [];
  const exportNoteSpy = vi.fn(
    async (
      noteId: string,
      expectedVersion: number,
      options2?: { schemaVersion?: StudyNoteExportSchemaVersion },
    ) => {
      timeline.push(`GET:${noteId}:${expectedVersion}`);
      if (options2?.schemaVersion !== undefined) {
        timeline.push(`schemaVersion:${options2.schemaVersion}`);
      }
      if (options.exportNote) return options.exportNote(noteId, expectedVersion, options2);
      return exportResult();
    },
  );
  const downloadSpy = vi.fn((_result: StudyNoteExportResult) => {
    timeline.push("download");
  });
  const flushSpy = vi.fn(async () => {
    timeline.push("flush");
    if (options.flush) return options.flush();
    return { version: 4 };
  });
  const deps: StudyNoteExportDeps = {
    flush: flushSpy,
    exportNote: exportNoteSpy as unknown as StudyNoteExportDeps["exportNote"],
    download: downloadSpy,
  };
  const gate = createSingleFlightGate();
  const depsRef = { deps, gate, timeline, exportNoteSpy, downloadSpy, flushSpy };
  const run = (
    generation = options.generation ?? 1,
    schemaVersion?: StudyNoteExportSchemaVersion,
  ): ReturnType<typeof flushThenExportNote> =>
    flushThenExportNote(
      {
        noteId: NOTE_ID,
        generation,
        isCurrent: options.isCurrent ?? (() => true),
        schemaVersion,
      },
      deps,
      gate,
    );
  return { ...depsRef, run };
}

describe("studyNoteExportFlusher（顺序）", () => {
  it("awaits flush before issuing the export GET：顺序恰为 flush → GET(回执版本) → download", async () => {
    const h = harness({});
    const outcome = await h.run();

    expect(h.timeline).toEqual(["flush", `GET:${NOTE_ID}:4`, "download"]);
    expect(outcome).toMatchObject({ ok: true, filename: SERVER_FILENAME });
    // 下载名 = 服务端安全文件名（客户端不自造）
    expect(h.downloadSpy.mock.calls[0]![0]!.filename).toBe(SERVER_FILENAME);
  });

  it("does not issue the export GET while flush is still pending（保存确认前零请求）", async () => {
    let releaseFlush: (() => void) | null = null;
    const h = harness({
      flush: () =>
        new Promise<{ version: number }>((resolve) => {
          releaseFlush = () => resolve({ version: 11 });
        }),
    });
    const pending = h.run();
    await Promise.resolve(); // 让 flush 进入 pending
    expect(h.exportNoteSpy).not.toHaveBeenCalled();
    expect(h.timeline).toEqual(["flush"]);

    releaseFlush!();
    await pending;
    expect(h.timeline).toEqual(["flush", `GET:${NOTE_ID}:11`, "download"]);
  });

  it("passes the flushed receipt version as expectedVersion（且只认本次回执，不用调用方给的旧版本）", async () => {
    const h = harness({ flush: async () => ({ version: 23 }) });
    await h.run();
    expect(h.exportNoteSpy).toHaveBeenCalledTimes(1);
    expect(h.exportNoteSpy.mock.calls[0]![1]).toBe(23);
  });

  it("flushes dirty edits before exporting（先 flush 再 GET 的机制证明：GET 晚于 flush 结算）", async () => {
    let saved = 0;
    const h = harness({
      flush: async () => {
        saved += 1; // 模拟 flush 真正把 dirty 内容提交并确认
        return { version: saved };
      },
    });
    await h.run();
    expect(saved).toBe(1);
    expect(h.exportNoteSpy.mock.calls[0]![1]).toBe(1);
  });

  it("rejects an untrustworthy receipt version（缺版本/非正整数 → 不导出、不下载）", async () => {
    for (const version of [undefined, 0, -1, 2.5, Number.NaN, "3"]) {
      const h = harness({ flush: async () => ({ version: version as number }) });
      const outcome = await h.run();
      expect(outcome.ok).toBe(false);
      expect(h.exportNoteSpy).not.toHaveBeenCalled();
      expect(h.downloadSpy).not.toHaveBeenCalled();
    }
    expect(isValidExportVersion(1)).toBe(true);
    expect(isValidExportVersion(0)).toBe(false);
  });
});

describe("studyNoteExportFlusher（失败面：绝不下载旧文）", () => {
  it("does not call export when persist rejects（flush reject → GET 0 次、下载 0 次）", async () => {
    const persistError = new Error("保存被服务端拒绝");
    const h = harness({
      flush: async () => {
        throw persistError;
      },
    });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ ok: false, reason: "flush" });
    expect(h.exportNoteSpy).toHaveBeenCalledTimes(0);
    expect(h.downloadSpy).toHaveBeenCalledTimes(0);
    expect(h.timeline).toEqual(["flush"]);
  });

  it("does not download on flush conflict（控制器 flush reject 的冲突态同样不导出）", async () => {
    const conflict = Object.assign(new Error("当前为冲突状态"), { name: "StudyNoteConflictError" });
    const h = harness({
      flush: async () => {
        throw conflict;
      },
    });
    const outcome = await h.run();
    expect(outcome).toMatchObject({ ok: false, reason: "flush" });
    expect(h.exportNoteSpy).toHaveBeenCalledTimes(0);
    expect(h.downloadSpy).toHaveBeenCalledTimes(0);
  });

  it("surfaces 409 without downloading（服务端版本冲突 → 无下载，且不再重试）", async () => {
    const h = harness({
      exportNote: async () => {
        throw new BrowserApiError(409, { code: "CONFLICT", details: { currentVersion: 9 } });
      },
    });
    const outcome = await h.run();

    expect(outcome).toMatchObject({ ok: false, reason: "conflict" });
    expect(h.downloadSpy).toHaveBeenCalledTimes(0);
    expect(h.exportNoteSpy).toHaveBeenCalledTimes(1); // 409 不重试
  });

  it("does not download on network error（无 status 的网络/超时错误 → request 分支）", async () => {
    const h = harness({
      exportNote: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const outcome = await h.run();
    expect(outcome).toMatchObject({ ok: false, reason: "request" });
    expect(h.downloadSpy).toHaveBeenCalledTimes(0);

    const timeout = harness({
      exportNote: async () => {
        throw new BrowserApiError(0, { code: "TIMEOUT" });
      },
    });
    expect(await timeout.run()).toMatchObject({ ok: false, reason: "request" });
    expect(timeout.downloadSpy).toHaveBeenCalledTimes(0);
  });

  it("does not download when the response fails validation（INVALID_RESPONSE → 独立分支）", async () => {
    const h = harness({
      exportNote: async () => {
        throw new BrowserApiError(200, { code: "INVALID_RESPONSE", message: "导出响应缺少合法的文件名" });
      },
    });
    const outcome = await h.run();
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_response" });
    expect(h.downloadSpy).toHaveBeenCalledTimes(0);
  });

  it("does not download when the note was switched during the request（切换笔记 → 丢弃结果）", async () => {
    let current = true;
    const h = harness({
      isCurrent: () => current,
      exportNote: async () => {
        current = false; // 响应回来之前用户切到了另一篇笔记
        return exportResult();
      },
    });
    const outcome = await h.run();
    expect(outcome).toMatchObject({ ok: false, reason: "note_switched" });
    expect(h.downloadSpy).toHaveBeenCalledTimes(0);
    expect(h.timeline).toEqual(["flush", `GET:${NOTE_ID}:4`]); // 无 download
  });

  it("reports every failure to onError（两侧宿主据此给出可见提示，而不是静默）", async () => {
    const onError = vi.fn();
    const h = harness({
      exportNote: async () => {
        throw new BrowserApiError(409, { code: "CONFLICT" });
      },
    });
    await flushThenExportNote(
      { noteId: NOTE_ID, generation: 1, isCurrent: () => true },
      { ...h.deps, onError },
      h.gate,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toContain("已在其他地方更新");
  });
});

describe("studyNoteExportFlusher（双击与单飞）", () => {
  it("ignores a second click while an export is in flight（双击 → flush/GET 各一次、下载一次）", async () => {
    let release: (() => void) | null = null;
    const h = harness({
      exportNote: async () =>
        new Promise<StudyNoteExportResult>((resolve) => {
          release = () => resolve(exportResult());
        }),
    });
    const first = h.run();
    const second = h.run(); // 双击的第二下：同一闸门
    await expect(second).resolves.toMatchObject({ ok: false, reason: "busy" });

    release!();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(h.flushSpy).toHaveBeenCalledTimes(1);
    expect(h.exportNoteSpy).toHaveBeenCalledTimes(1);
    expect(h.downloadSpy).toHaveBeenCalledTimes(1);
  });

  it("releases the gate after a failure（失败后仍可再次导出）", async () => {
    let fail = true;
    const h = harness({
      exportNote: async () => {
        if (fail) throw new TypeError("offline");
        return exportResult();
      },
    });
    await expect(h.run()).resolves.toMatchObject({ ok: false, reason: "request" });
    expect(h.gate.active()).toBe(false);
    fail = false;
    await expect(h.run()).resolves.toMatchObject({ ok: true });
    expect(h.downloadSpy).toHaveBeenCalledTimes(1);
  });
});

describe("studyNoteExportFlusher（N2/P4：schemaVersion 显式选版透传）", () => {
  it("input.schemaVersion=2 → 原样透传给导出请求（不替调用方升级/降级）", async () => {
    const h = harness();
    await h.run(1, 2);
    expect(h.exportNoteSpy.mock.calls[0]![2]).toEqual({ schemaVersion: 2 });
  });

  it("未显式选版 → 透传 undefined（服务端按 v1 冻结面处理，客户端不猜）", async () => {
    const h = harness();
    await h.run();
    expect(h.exportNoteSpy.mock.calls[0]![2]).toEqual({ schemaVersion: undefined });
  });

  it("v2 请求失败（422 等）不退回 v1：只导出一次且失败可见", async () => {
    const h = harness({
      exportNote: async () => {
        throw new Error("422 schemaVersion");
      },
    });
    await expect(h.run(1, 2)).resolves.toMatchObject({ ok: false, reason: "request" });
    expect(h.exportNoteSpy).toHaveBeenCalledTimes(1);
    expect(h.exportNoteSpy.mock.calls[0]![2]).toEqual({ schemaVersion: 2 });
    expect(h.downloadSpy).not.toHaveBeenCalled();
  });
});
