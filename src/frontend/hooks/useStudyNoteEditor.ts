/**
 * useStudyNoteEditor（Task 07）：把学习笔记保存控制器接入 React。
 *
 * 职责与纪律：
 *  - 初始化 **只 GET**（校验 note 身份与请求代际；失败显示错误/重试；不落回空笔记、
 *    不自动 POST）；已有本地更新时不直接覆盖；同一 note 的重复取数不重建并丢弃 dirty 控制器；
 *  - controller 生命周期与 effect 一致（不在 render 重建）；StrictMode 双挂载安全
 *    （旧实例 dispose / 代际丢弃，新实例接管）；旧回包不污染新实例；
 *  - 保存逻辑只用 `studyNoteSaveController`（防抖/退避/IME/flush 语义在其中），不另造；
 *  - 冲突恢复：复制本地内容（含 title/venues/status/引用信息，剪贴板失败给可见文本备选）、
 *    显式载入服务器版本（期间锁编辑 + 身份/代际/编辑序号检查，新输入出现则作废恢复结果）；
 *  - 导航辅助：flush 期间锁定输入与重复导航（含事件同 tick 守卫），真正切换前核对
 *    savedSeq/editSeq 与无在途状态；失败释放锁并留原位；
 *  - beforeunload 仅诚实提示（dirty/saving/retrying/error/conflict/invalid），
 *    不承诺关闭后异步保存成功。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createStudyNoteSaveController,
  StudyNotePrecheckError,
  type StudyNoteEditSnapshot,
  type StudyNoteFlushReceipt,
  type StudyNoteSaveController,
  type StudyNoteSaveSnapshot,
} from "@/frontend/state/studyNoteSaveController";
import { studyNotesClient, type StudyNotesClient } from "@/frontend/api/studyNotesClient";
import {
  assertReferenceSet,
  normalizeStudyUuid,
  type ReferencePreview,
  type StudyNoteDto,
} from "@/domain/l3-study-notes";

export type StudyNoteEditorLoadState = "loading" | "ready" | "error";

export interface UseStudyNoteEditorOptions {
  noteId: string;
  /** 注入客户端（测试）；默认单例。 */
  client?: StudyNotesClient;
}

export interface CopyLocalResult {
  ok: boolean;
  /** 始终返回可复制文本（剪贴板失败时供可见备选展示，不丢 title/venues/status/引用信息）。 */
  text: string;
}

export interface UseStudyNoteEditorResult {
  loadState: StudyNoteEditorLoadState;
  loadError: string | null;
  reload(): void;

  /** 控制器快照（加载完成前为 null）。 */
  snapshot: StudyNoteSaveSnapshot | null;
  /** 引用元数据（加载/载入服务器版本时保留；正文 marker 占位与复制文本使用）。 */
  referencesMeta: ReferencePreview[];

  setTitle(value: string): void;
  setBodyMd(value: string): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  retry(): Promise<void>;

  /** 冲突面板：复制本地内容（ok=false 时展示 text 作为可见备选）。 */
  copyLocalContent(): Promise<CopyLocalResult>;
  /** 冲突面板：显式载入服务器版本（期间锁编辑；新输入出现则作废）。 */
  loadServerVersion(): Promise<void>;
  recoveryLoading: boolean;
  recoveryError: string | null;
  dismissRecoveryError(): void;

  /** 导航辅助：先 flush 并核对无未保存/无在途，成功才执行 action；失败留原位。 */
  requestNavigation(action: () => void | Promise<void>): Promise<void>;
  navigationLocked: boolean;
  navigationError: string | null;
  dismissNavigationError(): void;

  /** 是否有未保存内容（dirty/saving/retrying/error/conflict/invalid 非 idle 即包含）。 */
  hasUnsavedChanges: boolean;
}

// ── 文案与工具 ──────────────────────────────────────────────────────────────

function describeError(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (status === 401) return "登录状态已失效，请重新登录后重试。";
    if (status === 403) return "没有权限访问该笔记。";
    if (status === 404) return "笔记不存在或已被移除。";
    if (typeof status === "number" && status >= 500) return `${fallback}（服务暂时不可用）`;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return `${fallback}：${message}`;
  }
  return fallback;
}

function isAbortLikeError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "AbortError";
}

/** 本地内容副本文本（包含标题/归属/置顶/归档/引用清单——不只正文）。 */
function buildLocalCopyText(snapshot: StudyNoteSaveSnapshot, referencesMeta: ReferencePreview[]): string {
  const { edit } = snapshot;
  const lines: string[] = [];
  lines.push(`# ${edit.title.trim() ? edit.title : "（无标题）"}`);
  lines.push("");
  lines.push(
    `> 状态：${edit.status === "archived" ? "已归档" : "未归档"}${edit.pinned ? " · 置顶" : ""} · 归属：${edit.venues.join("、")}`,
  );
  lines.push("");
  lines.push(edit.bodyMd);
  if (edit.references.length > 0) {
    lines.push("");
    lines.push("---");
    lines.push(`引用清单（${edit.references.length} 条）：`);
    for (const write of edit.references) {
      const meta = referencesMeta.find((reference) => normalizeStudyUuid(reference.id) === normalizeStudyUuid(write.id));
      if (meta) {
        const label =
          meta.displaySnapshot.kind === "source" || meta.displaySnapshot.kind === "source_quote"
            ? meta.displaySnapshot.title
            : meta.displaySnapshot.kind === "question"
              ? meta.displaySnapshot.stem
              : meta.displaySnapshot.quote;
        lines.push(`- [[ref:${write.id}]] ${label}（状态：${meta.status}${meta.capturedAt ? ` · ${meta.capturedAt}` : ""}）`);
      } else {
        lines.push(`- [[ref:${write.id}]]`);
      }
    }
  }
  return lines.join("\n");
}

/** 保存前预检：marker 集合与 references 集合必须完全一致（阻止 PUT，不自动修正）。 */
function referencePrecheck(snapshot: StudyNoteEditSnapshot): { ok: true } | { ok: false; reason: string } {
  try {
    assertReferenceSet(snapshot.bodyMd, snapshot.references);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "引用标记与引用清单不一致";
    return {
      ok: false,
      reason: `${message}。请恢复正文中被删除的引用标记（如 [[ref:…]] 行），或恢复引用清单；内容未提交。`,
    };
  }
}

// ── hook ────────────────────────────────────────────────────────────────────

export function useStudyNoteEditor(options: UseStudyNoteEditorOptions): UseStudyNoteEditorResult {
  const { noteId } = options;
  const clientRef = useRef<StudyNotesClient>(options.client ?? studyNotesClient);
  clientRef.current = options.client ?? studyNotesClient;

  const [loadState, setLoadState] = useState<StudyNoteEditorLoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<StudyNoteSaveSnapshot | null>(null);
  const [referencesMeta, setReferencesMeta] = useState<ReferencePreview[]>([]);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [navigationLocked, setNavigationLocked] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);

  const controllerRef = useRef<StudyNoteSaveController | null>(null);
  const generationRef = useRef(0);
  const recoveryInFlightRef = useRef(false);
  const navigationLockRef = useRef(false);
  const snapshotRef = useRef<StudyNoteSaveSnapshot | null>(null);
  snapshotRef.current = snapshot;

  // ── 加载 / controller 生命周期（与 effect 一致；不在 render 重建）────────
  useEffect(() => {
    let cancelled = false;
    let ownController: StudyNoteSaveController | null = null;
    let unsubscribe: (() => void) | null = null;
    const generation = ++generationRef.current;

    setLoadState("loading");
    setLoadError(null);
    setSnapshot(null);

    const attach = (controller: StudyNoteSaveController): void => {
      ownController = controller;
      controllerRef.current = controller;
      unsubscribe = controller.subscribe(() => {
        setSnapshot(controller.getSnapshot());
      });
      setSnapshot(controller.getSnapshot());
    };

    const boot = async (): Promise<void> => {
      try {
        const { item } = await clientRef.current.get(noteId);
        if (cancelled || generation !== generationRef.current) return;
        if (normalizeStudyUuid(item.id) !== normalizeStudyUuid(noteId)) {
          setLoadState("error");
          setLoadError("服务器返回的笔记与请求的身份不符，已停止加载。");
          return;
        }
        const existing = controllerRef.current;
        if (existing && !existing.isDisposed()) {
          // 同一挂载周期内的重复取数：不重建、不丢弃 dirty 输入。
          attach(existing);
          const snap = existing.getSnapshot();
          const isClean = snap.state === "idle" && snap.editSeq === snap.savedSeq;
          if (isClean) {
            existing.adoptServerSnapshot(item); // 仅干净态采纳服务器快照刷新基线
            setReferencesMeta(item.references);
          }
          setLoadState("ready");
          return;
        }
        const controller = createStudyNoteSaveController({
          noteId: item.id,
          version: item.version,
          baseline: {
            title: item.title,
            bodyMd: item.bodyMd,
            venues: [...item.venues],
            pinned: item.pinned,
            status: item.status,
            references: item.references.map((reference) => ({ id: reference.id, action: "keep" as const })),
          },
          lastSavedAt: item.updatedAt,
          save: async (input) => {
            const { item: saved } = await clientRef.current.save(input.noteId, {
              expectedVersion: input.expectedVersion,
              requestId: input.requestId,
              title: input.snapshot.title,
              bodyMd: input.snapshot.bodyMd,
              venues: input.snapshot.venues,
              pinned: input.snapshot.pinned,
              status: input.snapshot.status,
              references: input.snapshot.references,
            });
            return { version: saved.version, updatedAt: saved.updatedAt };
          },
          precheck: referencePrecheck,
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        });
        attach(controller);
        setReferencesMeta(item.references);
        setLoadState("ready");
      } catch (error) {
        if (cancelled || generation !== generationRef.current) return;
        if (isAbortLikeError(error)) return;
        setLoadState("error");
        setLoadError(describeError(error, "加载笔记失败"));
      }
    };
    void boot();

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (ownController) {
        if (controllerRef.current === ownController) controllerRef.current = null;
        ownController.dispose();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- client 经 ref 读取；noteId/loadNonce 驱动重取
  }, [noteId, loadNonce]);

  // ── beforeunload：诚实提示（不承诺关闭后异步保存成功）────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: BeforeUnloadEvent): void => {
      const snap = snapshotRef.current;
      if (snap && snap.state !== "idle") {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // ── 编辑入口（恢复/导航期间锁编辑）──────────────────────────────────────
  const editingLocked = useCallback((): boolean => recoveryInFlightRef.current || navigationLockRef.current, []);

  const applyEdit = useCallback(
    (patch: Partial<StudyNoteEditSnapshot>) => {
      const controller = controllerRef.current;
      if (!controller || controller.isDisposed()) return;
      if (editingLocked()) return;
      const current = controller.getSnapshot().edit;
      controller.edit({ ...current, ...patch });
    },
    [editingLocked],
  );

  const setTitle = useCallback((value: string) => applyEdit({ title: value }), [applyEdit]);
  const setBodyMd = useCallback((value: string) => applyEdit({ bodyMd: value }), [applyEdit]);
  const onCompositionStart = useCallback(() => controllerRef.current?.setComposing(true), []);
  const onCompositionEnd = useCallback(() => controllerRef.current?.setComposing(false), []);

  const retry = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller || controller.isDisposed()) return;
    try {
      await controller.retry();
    } catch {
      // 失败态经 snapshot 呈现（error/conflict/invalid）；这里不弹重复提示
    }
  }, []);

  const reload = useCallback(() => {
    setLoadNonce((value) => value + 1);
  }, []);

  // ── 冲突恢复 ────────────────────────────────────────────────────────────
  const copyLocalContent = useCallback(async (): Promise<CopyLocalResult> => {
    const controller = controllerRef.current;
    const snap = controller?.getSnapshot() ?? snapshotRef.current;
    if (!snap) return { ok: false, text: "" };
    const text = buildLocalCopyText(snap, referencesMeta);
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return { ok: false, text };
      await navigator.clipboard.writeText(text);
      return { ok: true, text };
    } catch {
      return { ok: false, text };
    }
  }, [referencesMeta]);

  const loadServerVersion = useCallback(async (): Promise<void> => {
    if (recoveryInFlightRef.current) return;
    const controller = controllerRef.current;
    if (!controller || controller.isDisposed()) return;
    recoveryInFlightRef.current = true;
    setRecoveryLoading(true);
    setRecoveryError(null);
    const generation = generationRef.current;
    const seqAtStart = controller.getSnapshot().editSeq;
    try {
      const { item } = await clientRef.current.get(noteId);
      if (generation !== generationRef.current || controller.isDisposed()) return; // 代际/实例检查
      if (normalizeStudyUuid(item.id) !== normalizeStudyUuid(noteId)) {
        setRecoveryError("服务器返回的笔记身份不符，未载入。");
        return;
      }
      if (controller.getSnapshot().editSeq !== seqAtStart) {
        // 恢复请求期间产生新输入 → 恢复结果作废（绝不静默覆盖）
        setRecoveryError("恢复请求期间产生了新的编辑：已放弃本次载入结果；请确认内容后重试。");
        return;
      }
      controller.adoptServerSnapshot(item);
      setReferencesMeta(item.references);
    } catch (error) {
      setRecoveryError(describeError(error, "载入服务器版本失败"));
    } finally {
      recoveryInFlightRef.current = false;
      setRecoveryLoading(false);
    }
  }, [noteId]);

  const dismissRecoveryError = useCallback(() => setRecoveryError(null), []);

  // ── 导航辅助 ────────────────────────────────────────────────────────────
  const requestNavigation = useCallback(async (action: () => void | Promise<void>): Promise<void> => {
    if (navigationLockRef.current) return; // 事件同 tick / 重复导航守卫
    navigationLockRef.current = true;
    setNavigationLocked(true);
    setNavigationError(null);
    try {
      const controller = controllerRef.current;
      if (controller && !controller.isDisposed()) {
        for (let guard = 0; guard < 20; guard += 1) {
          const snap = controller.getSnapshot();
          if (snap.state === "conflict" || snap.state === "error" || snap.state === "invalid") {
            throw new Error(
              snap.state === "conflict"
                ? "存在未处理的保存冲突：请先复制本地内容或载入服务器版本。"
                : snap.state === "invalid"
                  ? "内容未通过保存前预检：请按提示修复后再离开。"
                  : "保存失败：请重试成功后再离开。",
            );
          }
          if (snap.editSeq <= snap.savedSeq && !snap.inFlight) break;
          const receipt = await controller.flush();
          if (receipt.editSeq < snap.editSeq) continue; // 期间又有新编辑：继续核对循环
          const after = controller.getSnapshot();
          if (after.editSeq <= after.savedSeq && !after.inFlight) break;
        }
        const finalSnap = controller.getSnapshot();
        if (finalSnap.editSeq > finalSnap.savedSeq || finalSnap.inFlight) {
          throw new Error("仍有未保存内容：已暂停离开。");
        }
      }
      await action();
    } catch (error) {
      setNavigationError(error instanceof Error ? error.message : "无法离开：保存未完成。");
    } finally {
      navigationLockRef.current = false;
      setNavigationLocked(false);
    }
  }, []);

  const dismissNavigationError = useCallback(() => setNavigationError(null), []);

  const hasUnsavedChanges = snapshot !== null && snapshot.state !== "idle";

  return {
    loadState,
    loadError,
    reload,
    snapshot,
    referencesMeta,
    setTitle,
    setBodyMd,
    onCompositionStart,
    onCompositionEnd,
    retry,
    copyLocalContent,
    loadServerVersion,
    recoveryLoading,
    recoveryError,
    dismissRecoveryError,
    requestNavigation,
    navigationLocked,
    navigationError,
    dismissNavigationError,
    hasUnsavedChanges,
  };
}

/** 供组件复用：flush 回执类型再导出（宿主核对提交屏障时使用）。 */
export type { StudyNoteFlushReceipt, StudyNotePrecheckError };
