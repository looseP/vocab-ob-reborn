/**
 * useStudyNoteEditor（Task 07）：把学习笔记保存控制器接入 React。
 *
 * 职责与纪律：
 *  - 初始化 **只 GET**（校验 note 身份与请求代际；失败显示错误/重试；不落回空笔记、
 *    不自动 POST）；已有本地更新时不直接覆盖；同一 note 的重复取数不重建并丢弃 dirty 控制器；
 *  - reload 语义（R3）：仅用于**初始化失败后的重试**；已有活跃控制器时 no-op——
 *    不销毁、不覆盖 dirty/inFlight/error/conflict，不触发重复取数（放弃本地内容只走
 *    `loadServerVersion` → `adoptServerSnapshot`，不让普通 reload 成为丢失内容的后门）；
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
  type StudyNoteConfirmedSnapshot,
  type StudyNoteEditSnapshot,
  type StudyNoteFlushReceipt,
  type StudyNoteSaveController,
  type StudyNoteSaveSnapshot,
} from "@/frontend/state/studyNoteSaveController";
import { studyNotesClient, type StudyNotesClient, type StudyNoteExportResult } from "@/frontend/api/studyNotesClient";
import {
  createSingleFlightGate,
  downloadMarkdownBlob,
  flushThenExportNote,
  type StudyNoteExportOutcome,
} from "@/frontend/state/studyNoteExportFlusher";
import {
  assertReferenceSet,
  normalizeStudyUuid,
  STUDY_REFERENCE_MAX_PER_NOTE,
  type ReferencePreview,
  type ReferenceTarget,
  type ReferenceTargetPreview,
  type ReferenceWrite,
  type StudyNoteDto,
} from "@/domain/l3-study-notes";
import {
  excerptLinesFromSnapshot,
  exportSchemaVersionForReferences,
  insertReferenceMarker,
  removeReferenceMarker,
  replaceMarkerWithExcerpt,
} from "@/frontend/utils/studyNoteReferenceOps";

export type StudyNoteEditorLoadState = "loading" | "ready" | "error";

/**
 * 引用卡片元数据：`ReferencePreview` + **确认状态**（R2）。
 *
 * - `confirmed: true`：来自服务端 DTO（GET 或保存成功响应）——`capturedAt` 是服务端
 *   capture 时间，`displaySnapshot` 是已落库快照，可安全用于「转普通摘录」；
 * - `confirmed: false`：仅本机预览（插入后尚未保存确认），`capturedAt` 为空串且
 *   **不使用本机时间冒充服务端时间**；UI 必须显式标明「待确认」，转换被拒绝。
 */
export type StudyNoteReferenceMeta = ReferencePreview & { confirmed: boolean };

/** 服务端 DTO → 已确认元数据（唯一产生 `confirmed: true` 的来源）。 */
function toConfirmedMeta(references: readonly ReferencePreview[]): StudyNoteReferenceMeta[] {
  return references.map((reference) => ({ ...reference, confirmed: true }));
}

/** 是否可用于生成摘录（只认服务端确认的内容）。 */
function isReferenceConfirmed(meta: StudyNoteReferenceMeta | ReferencePreview): boolean {
  return (meta as StudyNoteReferenceMeta).confirmed === true;
}

export interface UseStudyNoteEditorOptions {
  noteId: string;
  /** 注入客户端（测试）；默认单例。 */
  client?: StudyNotesClient;
  /**
   * Task 10：下载效果注入（测试不触碰真实 DOM）。缺省 = Blob + `a[download]`
   * （文件名来自服务端 `Content-Disposition`）。
   */
  downloadExport?: (result: StudyNoteExportResult) => void;
  /**
   * Task 10：对**已校验**的服务端文件名/哈希做一次观察（宿主可记台账；测试可断言
   * 「下载用的就是服务端给的名字」）。仅成功路径调用。
   */
  onExportReady?: (info: { filename: string; sha256: string | null; schemaVersion: number | null }) => void;
}

export interface CopyLocalResult {
  ok: boolean;
  /** 始终返回可复制文本（剪贴板失败时供可见备选展示，不丢 title/venues/status/引用信息）。 */
  text: string;
}

export interface UseStudyNoteEditorResult {
  loadState: StudyNoteEditorLoadState;
  loadError: string | null;
  /** 初始化失败后的重试（无活跃控制器时生效；已有活跃控制器时 no-op——不丢本地输入）。 */
  reload(): void;

  /** 控制器快照（加载完成前为 null）。 */
  snapshot: StudyNoteSaveSnapshot | null;
  /** 引用元数据（加载/载入服务器版本时保留；正文 marker 占位与复制文本使用）。 */
  referencesMeta: StudyNoteReferenceMeta[];

  setTitle(value: string): void;
  setBodyMd(value: string): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  retry(): Promise<void>;

  /**
   * Task 09A：引用编辑（经同一 applyEdit 通道，与正文原子保存）。
   * 插入：新 refId + capture write + marker（光标处）。失败返回 null 并给出
   * `referenceError` 可见原因（被锁/超限/光标位置不安全）；**拒绝时不改本地状态**。
   */
  insertReference(target: ReferenceTarget, preview: ReferenceTargetPreview, cursor: number | null): string | null;
  /** 移除：marker 与 write 同次移除；marker 缺失/被锁返回 false（不静默部分修改）。 */
  removeReference(refId: string): boolean;
  /**
   * 转普通摘录：marker 替换为引文行 + write 移除。
   * **只消费已确认快照**（R2）：未确认的待确认引用不转换（返回 false 并给出可见原因）。
   */
  convertReferenceToExcerpt(refId: string): boolean;
  /** 引用操作拒绝原因（插入/移除/转换失败时的可见反馈；下一步操作时清空）。 */
  referenceError: string | null;
  dismissReferenceError(): void;

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
  /**
   * Task 09B 补批：**同步**读取当次导航拒绝原因（ref 镜像）。
   * 宿主在屏障返回的同一时刻归因时使用；状态版 `navigationError` 传播晚于 await 结算。
   */
  getNavigationError(): string | null;
  dismissNavigationError(): void;

  /** 是否有未保存内容（dirty/saving/retrying/error/conflict/invalid 非 idle 即包含）。 */
  hasUnsavedChanges: boolean;

  /**
   * Task 10：导出（`await flush() → receipt.version → GET export → Blob 下载`）。
   *
   * 顺序与失败面由共享流水线 `flushThenExportNote` 唯一实现（编辑器页与 09B 侧栏同源）：
   * - flush 成功前不发起导出请求；
   * - `expectedVersion` 只取本次回执；409/网络错误/响应非法/笔记被切换**一律不下载**；
   * - 双击由单飞闸门吞掉（返回 `ok:false, reason:"busy"`，不重复 flush/GET）；
   * - 期间锁编辑与离页（复用既有 action lock 语义），结束（成功或失败）恢复。
   */
  exportNote(): Promise<StudyNoteExportOutcome>;
  /** 导出中（工具栏显示「导出中…」并禁用）。 */
  exportBusy: boolean;
  /** 导出失败的可见原因（成功或下次导出时清空）。 */
  exportError: string | null;
  /** 导出成功提示（含服务端文件名；空串表示无提示）。 */
  exportNotice: string | null;
  dismissExportFeedback(): void;
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
function buildLocalCopyText(snapshot: StudyNoteSaveSnapshot, referencesMeta: readonly StudyNoteReferenceMeta[]): string {
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
        // 引用清单的标签取「最能认出这条引用是什么」的一段文本。判别联合的兜底分支
        // 显式列出 grading（N2 第四条链，ADR-0039）：漏掉它会落到 option_quote 的
        // `.quote` 上，而 grading 快照没有 quote 字段 ⇒ 运行时崩在导出/复制上。
        const label =
          meta.displaySnapshot.kind === "source" || meta.displaySnapshot.kind === "source_quote"
            ? meta.displaySnapshot.title
            : meta.displaySnapshot.kind === "question"
              ? meta.displaySnapshot.stem
              : meta.displaySnapshot.kind === "assessment"
                ? meta.displaySnapshot.excerpt
                : meta.displaySnapshot.kind === "note"
                  ? meta.displaySnapshot.title
                  : meta.displaySnapshot.kind === "sheet"
                    ? meta.displaySnapshot.summaryExcerpt
                    : meta.displaySnapshot.kind === "attempt"
                      ? meta.displaySnapshot.answerExcerpt
                      : meta.displaySnapshot.kind === "grading"
                        ? (meta.displaySnapshot.analysisExcerpt || `评卷（${meta.displaySnapshot.verdict}）`)
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

/** 引用身份归一（大小写不敏感比较）。 */
const sameRef = (a: string, b: string): boolean => normalizeStudyUuid(a) === normalizeStudyUuid(b);

/**
 * 消费一次**真实成功确认**（R1/R2）。**只做「升级」，绝不做删除或回退**：
 *
 * 1. capture → keep：仅当该引用「本次确实以 capture 提交」且「仍在当前编辑集合中」。
 *    —— 已确认内容不再重新采集；在途移除的引用不被复活；尚未确认的新引用保持 capture。
 * 2. 正式元数据：按引用身份用本次确认 DTO 覆盖本地条目（displaySnapshot/capturedAt/
 *    status/liveTitle，且 confirmed:true）。**响应里缺失的引用一律保留本地条目**：
 *    响应未覆盖某个引用属服务端/适配器异常，绝不能据此删除本地引用或回退正文/快照。
 * 3. 正文绝不改写：确认只影响 references 动作与引用元数据；本地并发输入（在途 B、
 *    已移除的 A、更新的正文）一律优先，不被整包服务器快照覆盖。
 */
function applyConfirmedReferences(
  controller: StudyNoteSaveController,
  confirmed: StudyNoteConfirmedSnapshot,
  setReferencesMeta: (updater: (previous: StudyNoteReferenceMeta[]) => StudyNoteReferenceMeta[]) => void,
  referencesMetaRef: { current: StudyNoteReferenceMeta[] },
): void {
  // 「当前有效引用集合」：确认回包只能作用于**此刻仍在编辑中的**引用身份。
  // 在途移除的 A 已不在集合内——它既不能被升级，也不能被下面的「补齐」循环复活。
  // 只按身份过滤，不从迟到的服务器快照整体覆写本地编辑态（本地并发输入优先）。
  const liveIds = new Set(controller.getSnapshot().edit.references.map((write) => normalizeStudyUuid(write.id)));
  const upgraded = new Map<string, StudyNoteReferenceMeta>(
    confirmed.references
      .filter((reference) => liveIds.has(normalizeStudyUuid(reference.id)))
      .map((reference) => [normalizeStudyUuid(reference.id), { ...reference, confirmed: true }]),
  );

  referencesMetaRef.current = referencesMetaRef.current.map((meta) => {
    const fresh = upgraded.get(normalizeStudyUuid(meta.id));
    return fresh ? { ...fresh, id: meta.id } : meta;
  });
  setReferencesMeta((previous) => {
    const next = previous.map((meta) => {
      const fresh = upgraded.get(normalizeStudyUuid(meta.id));
      return fresh ? { ...fresh, id: meta.id } : meta;
    });
    // 响应确认存在的引用若本地元数据缺失则补入（同样只限仍在编辑集合中的身份）；
    // **不删除任何本地条目**。
    for (const reference of confirmed.references) {
      if (!liveIds.has(normalizeStudyUuid(reference.id))) continue;
      if (!next.some((meta) => sameRef(meta.id, reference.id))) next.push({ ...reference, confirmed: true });
    }
    return next;
  });

  // capture → keep：用 markConfirmed 做**本地簿记**（不推进 editSeq、不多打一次 PUT）——
  // 服务端已持有正确内容，后续载荷不再重复采集即可。仅本次载荷中确为 capture 的引用生效。
  const confirmedCaptureIds = confirmed.snapshot.references
    .filter((sent) => sent.action === "capture")
    .map((sent) => sent.id)
    .filter((id) =>
      controller.getSnapshot().edit.references.some((write) => sameRef(write.id, id)),
    );
  if (confirmedCaptureIds.length > 0) controller.markConfirmed(confirmedCaptureIds);
}

/** 引用集合等价（顺序敏感；capture 目标按 JSON 比较）。 */
function referencesEqual(a: readonly ReferenceWrite[], b: readonly ReferenceWrite[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (left.id !== right.id || left.action !== right.action) return false;
    if (left.action === "capture" && right.action === "capture") {
      if (JSON.stringify(left.target) !== JSON.stringify(right.target)) return false;
    }
  }
  return true;
}

// ── hook ────────────────────────────────────────────────────────────────────

export function useStudyNoteEditor(options: UseStudyNoteEditorOptions): UseStudyNoteEditorResult {
  const { noteId } = options;
  const clientRef = useRef<StudyNotesClient>(options.client ?? studyNotesClient);
  clientRef.current = options.client ?? studyNotesClient;

  const [loadState, setLoadState] = useState<StudyNoteEditorLoadState>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<StudyNoteSaveSnapshot | null>(null);
  const [referencesMeta, setReferencesMeta] = useState<StudyNoteReferenceMeta[]>([]);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [navigationLocked, setNavigationLocked] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  /**
   * Task 09B 补批：`navigationError` 的**同步镜像**。
   *
   * `requestNavigation` 失败不 reject，只写状态；而 React 状态传播晚于 `await` 结算，
   * 宿主在屏障返回的那一刻读到的是旧值。宿主需要**当次**拒绝原因来归因（IME/冲突/
   * 需修复/保存失败指引不同），故以 ref 同步记录，供 `getNavigationError()` 立即读取。
   */
  const navigationErrorRef = useRef<string | null>(null);
  const setNavigationErrorSync = useCallback((message: string | null) => {
    navigationErrorRef.current = message;
    setNavigationError(message);
  }, []);
  const [loadNonce, setLoadNonce] = useState(0);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  // ── Task 10：导出（复用既有 action lock 语义）────────────────────────────
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  /** 已挂载（未卸载）的编辑器实例：响应回来前若已卸载（侧栏关闭）则丢弃结果。 */
  const mountedRef = useRef(true);
  /** 笔记身份代际：切笔记后旧响应一律不下载（与列表竞态同一纪律）。 */
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  /** 导出单飞闸门（与按钮层的同步锁互补：hook 层保证「重复调用不重复 flush」）。 */
  const exportGateRef = useRef(createSingleFlightGate());
  const downloadExportRef = useRef(options.downloadExport ?? downloadMarkdownBlob);
  downloadExportRef.current = options.downloadExport ?? downloadMarkdownBlob;
  const onExportReadyRef = useRef(options.onExportReady);
  onExportReadyRef.current = options.onExportReady;

  const controllerRef = useRef<StudyNoteSaveController | null>(null);
  const generationRef = useRef(0);
  const recoveryInFlightRef = useRef(false);
  const navigationLockRef = useRef(false);
  const snapshotRef = useRef<StudyNoteSaveSnapshot | null>(null);
  snapshotRef.current = snapshot;
  /** 引用元数据镜像（确认回调里同步读取，避免闭包拿到过期 state）。 */
  const referencesMetaRef = useRef<StudyNoteReferenceMeta[]>(referencesMeta);
  referencesMetaRef.current = referencesMeta;

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
            setReferencesMeta(toConfirmedMeta(item.references));
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
            return { version: saved.version, updatedAt: saved.updatedAt, references: saved.references };
          },
          precheck: referencePrecheck,
          // R1/R2：仅在**真实成功确认**后把本次 capture 转 keep，并把服务端正式快照回填。
          onConfirmed: (confirmed) => {
            if (generation === generationRef.current && !cancelled) {
              applyConfirmedReferences(controller, confirmed, setReferencesMeta, referencesMetaRef);
            }
          },
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        });
        attach(controller);
        setReferencesMeta(toConfirmedMeta(item.references));
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

  // ── 挂载标记（Task 10）：导出响应回来前若已卸载（侧栏关闭），结果一律丢弃 ────
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  // ── Task 09A：引用编辑（marker 与 references 同一次 patch；与正文原子保存）────
  const insertReference = useCallback(
    (target: ReferenceTarget, preview: ReferenceTargetPreview, cursor: number | null): string | null => {
      const controller = controllerRef.current;
      if (!controller || controller.isDisposed() || editingLocked()) {
        setReferenceError("当前不可编辑（正在恢复/离开流程中），请稍后再插入引用。");
        return null;
      }
      const current = controller.getSnapshot().edit;
      if (current.references.length >= STUDY_REFERENCE_MAX_PER_NOTE) {
        setReferenceError(`引用数量已达上限（${STUDY_REFERENCE_MAX_PER_NOTE} 条），请先移除部分引用。`);
        return null;
      }
      const refId = crypto.randomUUID();
      let nextBodyMd: string;
      try {
        // R4：解析完整 Markdown 后再定位——光标处在代码块/列表/引用块等无法安全插入的
        // 容器内时**明确拒绝且不改动任何本地状态**（不写入后再靠预检兜底）。
        nextBodyMd = insertReferenceMarker(current.bodyMd, refId, cursor);
      } catch (error) {
        setReferenceError(error instanceof Error ? error.message : "无法在此处插入引用标记。");
        return null;
      }
      const nextReferences = [...current.references, { id: refId, action: "capture" as const, target }];
      // 原子提交前用真实语义复核（marker 集合 == references 集合）。
      try {
        assertReferenceSet(nextBodyMd, nextReferences);
      } catch (error) {
        setReferenceError(error instanceof Error ? error.message : "插入结果未通过引用预检，已取消。");
        return null;
      }
      // 仅在确定提交时才建立「待确认」元数据；本机时间**不冒充**服务端 capture 时间。
      setReferencesMeta((previous) => [
        ...previous,
        {
          id: refId,
          target,
          status: "current",
          capturedAt: "",
          confirmed: false,
          displaySnapshot: preview.displaySnapshot,
          liveTitle: preview.liveTitle,
        },
      ]);
      controller.edit({ ...current, bodyMd: nextBodyMd, references: nextReferences });
      setReferenceError(null);
      return refId;
    },
    [editingLocked],
  );

  const removeReference = useCallback(
    (refId: string): boolean => {
      const controller = controllerRef.current;
      if (!controller || controller.isDisposed() || editingLocked()) {
        setReferenceError("当前不可编辑（正在恢复/离开流程中），请稍后再试。");
        return false;
      }
      const current = controller.getSnapshot().edit;
      let nextBodyMd: string;
      try {
        nextBodyMd = removeReferenceMarker(current.bodyMd, refId);
      } catch (error) {
        setReferenceError(error instanceof Error ? error.message : "引用标记不存在，未做修改。");
        return false; // marker 缺失：不静默部分修改（保存预检兜底提示）
      }
      const nextReferences = current.references.filter(
        (write) => normalizeStudyUuid(write.id) !== normalizeStudyUuid(refId),
      );
      controller.edit({ ...current, bodyMd: nextBodyMd, references: nextReferences });
      setReferencesMeta((previous) =>
        previous.filter((meta) => normalizeStudyUuid(meta.id) !== normalizeStudyUuid(refId)),
      );
      setReferenceError(null);
      return true;
    },
    [editingLocked],
  );

  const convertReferenceToExcerpt = useCallback(
    (refId: string): boolean => {
      const controller = controllerRef.current;
      if (!controller || controller.isDisposed() || editingLocked()) {
        setReferenceError("当前不可编辑（正在恢复/离开流程中），请稍后再试。");
        return false;
      }
      const current = controller.getSnapshot().edit;
      const meta = referencesMeta.find(
        (reference) => normalizeStudyUuid(reference.id) === normalizeStudyUuid(refId),
      );
      if (!meta) {
        setReferenceError("没有可用的引用快照，无法生成摘录（不猜测内容）。");
        return false;
      }
      // R2：转换只消费**已确认**快照——预览可能早于真实 capture，来源可在两者之间变化。
      if (!isReferenceConfirmed(meta)) {
        setReferenceError("该引用尚未保存确认：请先保存（或等待自动保存完成）后再转为普通摘录。");
        return false;
      }
      const excerptLines = excerptLinesFromSnapshot(meta);
      let nextBodyMd: string;
      try {
        nextBodyMd = replaceMarkerWithExcerpt(current.bodyMd, refId, excerptLines);
      } catch (error) {
        setReferenceError(error instanceof Error ? error.message : "引用标记不存在，未做修改。");
        return false;
      }
      const nextReferences = current.references.filter(
        (write) => normalizeStudyUuid(write.id) !== normalizeStudyUuid(refId),
      );
      try {
        assertReferenceSet(nextBodyMd, nextReferences);
      } catch (error) {
        setReferenceError(error instanceof Error ? error.message : "转换结果未通过引用预检，已取消。");
        return false;
      }
      controller.edit({ ...current, bodyMd: nextBodyMd, references: nextReferences });
      setReferencesMeta((previous) =>
        previous.filter((reference) => normalizeStudyUuid(reference.id) !== normalizeStudyUuid(refId)),
      );
      setReferenceError(null);
      return true;
    },
    [editingLocked, referencesMeta],
  );
  const dismissReferenceError = useCallback(() => setReferenceError(null), []);
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

  /**
   * 初始化失败后的重试入口（R3 语义收窄）：
   * - **仅当当前无活跃控制器时有效**（加载失败/首次加载中）；
   * - 已有活跃控制器时 **no-op**：不销毁、不覆盖任何 dirty/inFlight/error/conflict 内容，
   *   不触发重复取数——同身份刷新不承担「放弃本地修改」职责；
   * - 显式放弃本地内容仍走 `loadServerVersion()` → `adoptServerSnapshot`（唯一入口）。
   * Task 08 接入注意：不得把本方法复用为「同笔记刷新/丢弃本地」的后门。
   */
  const reload = useCallback(() => {
    const controller = controllerRef.current;
    if (controller && !controller.isDisposed()) return;
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
      setReferencesMeta(toConfirmedMeta(item.references));
    } catch (error) {
      setRecoveryError(describeError(error, "载入服务器版本失败"));
    } finally {
      recoveryInFlightRef.current = false;
      setRecoveryLoading(false);
    }
  }, [noteId]);

  const dismissRecoveryError = useCallback(() => setRecoveryError(null), []);

  // ── Task 10：导出（flush → receipt.version → GET → Blob 下载）──────────────
  /**
   * 导出实现**只此一处**：`flushThenExportNote`（共享流水线）。本 hook 提供：
   *  - 身份/活动性核对（`isCurrent`：编辑器仍挂载、同一实例代际、noteId 未变）；
   *  - 单飞闸门（双击/重复调用不重复 flush、不重复 GET）；
   *  - 既有 action lock 的导出面：导出期间以 `exportBusy` 锁编辑入口（两侧按钮与
   *    输入框据此禁用），避免「导出在途时继续改内容」造成版本错配；
   *  - 可见反馈（成功提示服务端文件名；失败给出可归因原因）。
   */
  const exportNote = useCallback(async (): Promise<StudyNoteExportOutcome> => {
    const controller = controllerRef.current;
    if (!controller || controller.isDisposed()) {
      const outcome: StudyNoteExportOutcome = {
        ok: false,
        reason: "flush",
        message: "笔记尚未就绪，无法导出。",
      };
      setExportError(outcome.message);
      return outcome;
    }
    setExportError(null);
    setExportNotice(null);
    setExportBusy(true);
    const generation = generationRef.current;
    const startedNoteId = noteIdRef.current;
    try {
      const outcome = await flushThenExportNote(
        {
          noteId: startedNoteId,
          generation,
          // N2/P4：显式选版——含评析（N2）引用 → v2；纯 N1 引用 → 保持 v1 冻结面。
          // 取 ref 而非 state：导出动作在 useCallback([]) 里，不能用快照态。
          schemaVersion: exportSchemaVersionForReferences(referencesMetaRef.current),
          // 响应回来时：编辑器仍挂载、仍是同一实例代际、仍是同一篇笔记
          isCurrent: (expected) =>
            mountedRef.current &&
            !controller.isDisposed() &&
            expected === generationRef.current &&
            noteIdRef.current === startedNoteId,
        },
        {
          flush: () => controller.flush(),
          exportNote: (id, expectedVersion, options) =>
            clientRef.current.exportNote(id, expectedVersion, options),
          download: (result) => downloadExportRef.current(result),
        },
        exportGateRef.current,
      );
      if (outcome.ok) {
        setExportNotice(`已开始下载 ${outcome.filename}`);
        onExportReadyRef.current?.({
          filename: outcome.filename,
          sha256: outcome.sha256,
          schemaVersion: outcome.schemaVersion,
        });
      } else if (outcome.reason !== "busy") {
        setExportError(outcome.message);
      }
      return outcome;
    } finally {
      setExportBusy(false);
    }
  }, []);

  const dismissExportFeedback = useCallback(() => {
    setExportError(null);
    setExportNotice(null);
  }, []);

  // ── 导航辅助 ────────────────────────────────────────────────────────────
  const requestNavigation = useCallback(async (action: () => void | Promise<void>): Promise<void> => {
    if (navigationLockRef.current) return; // 事件同 tick / 重复导航守卫
    navigationLockRef.current = true;
    setNavigationLocked(true);
    setNavigationErrorSync(null);
    try {
      const controller = controllerRef.current;
      if (controller && !controller.isDisposed()) {
        if (controller.getSnapshot().composing) {
          // R2 协同：组合中的编辑不完整，不进入「锁输入 + flush 等待」流程
          //（禁用输入会让 compositionend 缺席 → flush 永久 pending，也不可用超时
          // 把半成品当完整内容保存）。明确拒绝并留原位；输入保持可用，
          // 用户完成组合（内容可保存）后再导航。
          throw new Error("正在输入法组合输入中：请先完成当前输入（确认候选词或按 Esc 取消）再离开。");
        }
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
          await controller.flush();
          // R5 回执语义：receipt.editSeq = 实际确认序号（≥ flush 目标）；不再据此做序号
          // 比较（防回执语义变化导致提前导航）；一律以最新快照「无未保存、无在途」为
          // 离开条件；期间新增编辑由循环继续核对（不循环等待旧目标）。
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
      setNavigationErrorSync(error instanceof Error ? error.message : "无法离开：保存未完成。");
    } finally {
      navigationLockRef.current = false;
      setNavigationLocked(false);
    }
  }, []);

  const dismissNavigationError = useCallback(() => setNavigationErrorSync(null), [setNavigationErrorSync]);
  /** Task 09B 补批：同步读取**当次**导航拒绝原因（不依赖 React 状态传播）。 */
  const getNavigationError = useCallback(() => navigationErrorRef.current, []);

  const hasUnsavedChanges = snapshot !== null && snapshot.state !== "idle";
  return {
    loadState,
    loadError,
    reload,
    snapshot,
    referencesMeta,
    setTitle,
    setBodyMd,
    insertReference,
    removeReference,
    convertReferenceToExcerpt,
    referenceError,
    dismissReferenceError,
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
    getNavigationError,
    dismissNavigationError,
    hasUnsavedChanges,
    exportNote,
    exportBusy,
    exportError,
    exportNotice,
    dismissExportFeedback,
  };
}

/** 供组件复用：flush 回执类型再导出（宿主核对提交屏障时使用）。 */
export type { StudyNoteFlushReceipt, StudyNotePrecheckError };
