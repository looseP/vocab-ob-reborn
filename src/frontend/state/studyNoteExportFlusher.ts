/**
 * 学习笔记导出流水线（Task 10）——**顺序固定、失败绝不降级为「下载旧文」**的唯一实现。
 *
 * 为什么单独成一个模块（而不是写在组件里）：
 *  - 顺序是硬合同：`await controller.flush()` → 取 `receipt.version` → 以该版本 GET 导出
 *    → Blob → 下载；任何一步失败都**不得**产生下载（版本不符时服务端只会 409，
 *    根本没有旧正文可拿）；
 *  - 编辑器页（`StudyNoteEditor`，Task 10 P4 决策的出口）与 09B 卷面侧栏
 *    （`StudyNoteSidePanel` 复用 `StudyNoteExportButton`）必须复用**同一份**实现——组件里各写一遍
 *    必然出现两份顺序与两份失败分支；
 *  - 纯 TS、不依赖 React/DOM 之外的东西（DOM 效果经注入），可用假时钟与 spy 直接
 *    举证「persist reject → 导出未被调用」。
 *
 * 纪律（每条都有对应测试）：
 *  1. flush 成功前**不发起任何网络请求**（含「flush 尚未 settle 时导出 GET 未发生」）；
 *  2. `expectedVersion` **只**来自本次 flush 回执（不接受调用方传入的版本，避免用旧版本
 *     导出旧内容）；
 *  3. 失败面（flush reject / 409 / 网络错误 / 响应校验失败 / 响应期间笔记被切换）一律
 *     `ok:false`，且**不触碰任何 DOM**（无 anchor、无 createObjectURL、无 revokeObjectURL）；
 *  4. 点击去重（同一次在途导出内的重复点击/双击 = no-op）与笔记身份核对（generation）
 *     由本模块负责；IME 组合由调用方在点击入口拦下（见两侧按钮的 `isComposing`）。
 */
import type { StudyNoteExportResult, StudyNotesClient } from "@/frontend/api/studyNotesClient";

/** 导出流水线依赖（全部可注入，故可用 spy 直接断言调用次数与顺序）。 */
export interface StudyNoteExportDeps {
  /** 等待在途保存确认；成功回执携带**本次确认的版本**。 */
  flush: () => Promise<{ version: number }>;
  /** 导出客户端（`studyNotesClient.exportNote` 或其替身）。 */
  exportNote: (noteId: string, expectedVersion: number, signal?: AbortSignal) => Promise<StudyNoteExportResult>;
  /** 触发浏览器下载（默认 `downloadMarkdownBlob`；测试注入 spy 以断言「从未被调用」）。 */
  download: (result: StudyNoteExportResult) => void;
  /** 可读错误提示（默认不弹；两侧组件各自接到自己的提示条）。 */
  onError?: (message: string, error: unknown) => void;
}

export type StudyNoteExportOutcome =
  | { ok: true; filename: string; sha256: string | null; schemaVersion: number | null }
  | { ok: false; reason: StudyNoteExportFailureReason; message: string; error?: unknown };

export type StudyNoteExportFailureReason =
  /** 在途保存未确认（含冲突/预检/放弃）：绝不导出未保存内容。 */
  | "flush"
  /** 服务端版本不一致（409）：本次没有可下载的正文。 */
  | "conflict"
  /** 网络/超时/服务端错误。 */
  | "request"
  /** 响应不符合导出合同（空正文、缺安全文件名等）。 */
  | "invalid_response"
  /** 响应返回时编辑器已切到另一篇笔记：丢弃结果，不下载。 */
  | "note_switched"
  /** 已有一笔导出在途：重复点击为 no-op。 */
  | "busy";

const MESSAGES: Record<StudyNoteExportFailureReason, string> = {
  flush: "保存未完成，导出已取消；请先处理保存状态再导出。",
  conflict: "笔记已在其他地方更新，导出已取消：请重新载入后再导出。",
  request: "导出失败：网络或服务异常，请稍后重试。",
  invalid_response: "导出响应不符合合同，已取消下载。",
  note_switched: "笔记已切换，已放弃本次导出结果。",
  busy: "导出进行中，请稍候。",
};

function statusOf(error: unknown): number | null {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return null;
}

function codeOf(error: unknown): string | null {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/**
 * flush 回执版本必须是**正整数**——拿不到可信版本就不导出（不猜、不用 undefined）。
 */
export function isValidExportVersion(version: unknown): version is number {
  return typeof version === "number" && Number.isInteger(version) && version > 0;
}

/**
 * 单飞（single-flight）导出闸门：同一时刻至多一笔。
 *
 * `begin()` 返回 false 表示已有在途导出——调用方据此**直接返回**（no-op，不重复
 * flush、不重复 GET）。所有失败与成功路径都必须 `end()`（经 `finally`）。
 */
export function createSingleFlightGate(): { begin(): boolean; end(): void; active(): boolean } {
  let active = false;
  return {
    begin: () => {
      if (active) return false;
      active = true;
      return true;
    },
    end: () => {
      active = false;
    },
    active: () => active,
  };
}

/** 浏览器下载（Blob → a[download] → revoke）。文件名**只**取服务端返回值。 */
export function downloadMarkdownBlob(result: StudyNoteExportResult): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const blob = new Blob([result.markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function failure(
  reason: StudyNoteExportFailureReason,
  error?: unknown,
  message?: string,
): StudyNoteExportOutcome {
  return { ok: false, reason, message: message ?? MESSAGES[reason], error };
}

/**
 * 执行一次导出（顺序固定）：
 *
 * ```text
 * gate.begin() ─false→ { ok:false, reason:"busy" }
 *   │true
 *   ├─1 await flush()            失败 → "flush"      （此时**未**发起导出请求）
 *   ├─2 receipt.version 校验     非法 → "flush"
 *   ├─3 GET export(noteId, version)
 *   │      409 → "conflict"；INVALID_RESPONSE → "invalid_response"；其余 → "request"
 *   ├─4 身份核对（generation 未变）
 *   ├─5 download(result)（文件名来自服务端；Blob 由默认下载器构造）
 *   └─finally gate.end()（成功或失败都释放；失败路径不触碰 DOM）
 * ```
 */
export async function flushThenExportNote(
  input: { noteId: string; generation: number; isCurrent: (generation: number) => boolean },
  deps: StudyNoteExportDeps,
  gate: { begin(): boolean; end(): void },
): Promise<StudyNoteExportOutcome> {
  if (!gate.begin()) return failure("busy");
  try {
    // 1) 先等待在途保存确认：未确认的本地输入绝不进入导出。
    let receipt: { version: unknown };
    try {
      receipt = await deps.flush();
    } catch (error) {
      return report(deps, failure("flush", error));
    }

    // 2) expectedVersion 只来自本次回执（不猜、不用调用方传入的旧版本）。
    if (!isValidExportVersion(receipt?.version)) {
      return report(deps, failure("flush", undefined, "保存回执缺少可信版本，导出已取消。"));
    }

    // 3) 以该版本 GET 导出：服务端核对，不一致只会 409（没有旧正文可下载）。
    let result: StudyNoteExportResult;
    try {
      result = await deps.exportNote(input.noteId, receipt.version);
    } catch (error) {
      const status = statusOf(error);
      if (status === 409) return report(deps, failure("conflict", error));
      if (codeOf(error) === "INVALID_RESPONSE") return report(deps, failure("invalid_response", error));
      return report(deps, failure("request", error));
    }

    // 4) 响应期间笔记被切换（或编辑器已卸载）：丢弃结果，不下载。
    if (!input.isCurrent(input.generation)) return report(deps, failure("note_switched"));

    // 5) 下载（文件名由服务端安全文件名决定）。
    deps.download(result);
    return {
      ok: true,
      filename: result.filename,
      sha256: result.sha256,
      schemaVersion: result.schemaVersion,
    };
  } finally {
    gate.end();
  }
}

function report(deps: StudyNoteExportDeps, outcome: StudyNoteExportOutcome): StudyNoteExportOutcome {
  if (!outcome.ok) deps.onError?.(outcome.message, outcome.error);
  return outcome;
}

/** 便捷类型：从客户端派生导出函数签名（两侧组件共用同一形状）。 */
export type StudyNoteExportNoteFn = StudyNotesClient["exportNote"];
