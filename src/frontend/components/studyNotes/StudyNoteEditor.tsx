/**
 * 学习笔记基础编辑器（Task 07）——标题/正文、诚实保存状态、冲突恢复入口、
 * 普通 Markdown 安全预览（复用项目净化链）、引用 marker 安全只读占位。
 *
 * 纪律：
 *  - 编辑状态真源 = `useStudyNoteEditor`（controller 快照）；本组件不另造保存逻辑；
 *  - 预览（R4）：与 domain 同一 lexer 语义（`splitStudyNotePreviewBlocks`）——仅
 *    **顶层 paragraph 完全等于 `[[ref:…]]`** 渲染为只读占位卡（快照摘要；unavailable
 *    显示「已失效」但仍保留摘录），缩进代码/围栏/列表/引用块等一律保持普通 Markdown，
 *    绝不作为 HTML 注入；
 *  - 引用深度编辑（新 capture/完整卡片/显式移除）后置 Task 09，本组件不提供假入口；
 *  - 冲突面板：复制本地内容（失败给可见文本备选）/ 显式载入服务器版本（锁编辑）；
 *  - marker 集合被手动破坏时由保存预检阻止 PUT 并给出恢复指引（invalid 面板）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReferencePreview } from "@/domain/l3-study-notes";
import { studyNotesClient, type StudyNotesClient } from "@/frontend/api/studyNotesClient";
import { Markdown } from "@/frontend/components/ui/Markdown";
import { Button } from "@/frontend/components/ui/Button";
import { StudyReferencePicker } from "@/frontend/components/studyNotes/StudyReferencePicker";
import { useStudyNoteEditor } from "@/frontend/hooks/useStudyNoteEditor";
import type { StudyNoteSaveState } from "@/frontend/state/studyNoteSaveController";
import { splitStudyNotePreviewBlocks } from "@/frontend/utils/studyNotePreviewBlocks";

/** 导航屏障：flush 成功且无未保存/无在途才执行 action；失败留在原位（错误经 hook 呈现）。 */
export type StudyNoteLeaveBarrier = (action: () => void | Promise<void>) => Promise<void>;

export interface StudyNoteEditorProps {
  noteId: string;
  /** 注入客户端（联调宿主/测试）；默认单例。 */
  client?: StudyNotesClient;
  /**
   * 宿主提供的离开动作：经 hook 的 requestNavigation 包装——
   * flush 成功且无未保存/无在途才执行；失败释放锁并留在原位（navigationError 呈现）。
   */
  leaveAction?: { label: string; onLeave: () => void | Promise<void> };
  /**
   * Task 08：把导航屏障（= hook 的 requestNavigation）注册给宿主——
   * 页面把同一屏障复用于 history guard（前进/后退）与站内导航（列表打开/返回列表）。
   */
  onRegisterLeaveBarrier?: (barrier: StudyNoteLeaveBarrier | null) => void;
}

const SAVE_STATE_LABELS: Record<StudyNoteSaveState, string> = {
  idle: "已保存",
  dirty: "未保存",
  saving: "保存中…",
  retrying: "网络重试中…",
  error: "保存失败",
  conflict: "存在冲突",
  invalid: "内容需修复",
};

const TITLE_MAX = 120;
const BODY_MAX = 100_000;

function formatSavedAt(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `最近保存于 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}

function referenceSummary(meta: ReferencePreview): string {
  const snapshot = meta.displaySnapshot;
  switch (snapshot.kind) {
    case "source":
      return snapshot.title;
    case "source_quote":
      return `「${snapshot.quote}」`;
    case "question":
      return snapshot.stem;
    case "stem_quote":
      return `「${snapshot.quote}」`;
    case "option_quote":
      return `选项 ${snapshot.optionKey}「${snapshot.quote}」`;
  }
}

function ReferencePlaceholder({
  refId,
  meta,
  onRemove,
  onConvert,
}: {
  refId: string;
  meta: ReferencePreview & { confirmed?: boolean } | undefined;
  onRemove?: (refId: string) => void;
  onConvert?: (refId: string) => void;
}) {
  const pending = meta !== undefined && meta.confirmed === false;
  const statusLabel =
    meta === undefined
      ? "未找到快照"
      : pending
        ? "待确认"
        : meta.status === "changed"
          ? "内容已变化"
          : meta.status === "unavailable"
            ? "引用已失效"
            : null;
  return (
    <div
      className="my-2 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-ink)]"
      data-testid="reference-placeholder"
      data-ref-id={refId}
      data-ref-confirmed={meta === undefined ? "unknown" : pending ? "pending" : "confirmed"}
    >
      <div className="flex items-center gap-2">
        <span className="rounded bg-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-soft)]">引用</span>
        <span className="min-w-0 flex-1 truncate">{meta ? referenceSummary(meta) : refId}</span>
        {statusLabel && <span className="shrink-0 text-[10px] text-[var(--color-accent-2)]">{statusLabel}</span>}
      </div>
      {meta?.status === "changed" && meta.liveTitle && (
        <p className="mt-1 text-[10px] text-[var(--color-ink-soft)]" data-testid="ref-card-live-title">
          当前来源：{meta.liveTitle}
        </p>
      )}
      {meta && (onRemove || onConvert) && (
        <div className="mt-1 flex items-center gap-2">
          {onConvert && (
            <button
              type="button"
              className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => onConvert(refId)}
              disabled={pending}
              title={pending ? "该引用尚未保存确认：请先保存后再转为普通摘录" : undefined}
              data-testid="ref-card-convert"
            >
              转普通摘录
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-soft)] hover:border-[var(--color-accent-2)]"
              onClick={() => onRemove(refId)}
              data-testid="ref-card-remove"
            >
              移除
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function StudyNoteEditor({ noteId, client, leaveAction, onRegisterLeaveBarrier }: StudyNoteEditorProps) {
  const editor = useStudyNoteEditor({ noteId, client });
  const activeClient = client ?? studyNotesClient;
  const [showPreview, setShowPreview] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [copyState, setCopyState] = useState<{ ok: boolean; text: string } | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const insertCursorRef = useRef<number | null>(null);

  // Task 08：把导航屏障注册给宿主（requestNavigation 稳定标识；卸载时解除）。
  const requestNavigation = editor.requestNavigation;
  useEffect(() => {
    if (!onRegisterLeaveBarrier) return;
    onRegisterLeaveBarrier(requestNavigation);
    return () => onRegisterLeaveBarrier(null);
  }, [onRegisterLeaveBarrier, requestNavigation]);

  const snapshot = editor.snapshot;
  const blocks = useMemo(
    () => (snapshot && showPreview ? splitStudyNotePreviewBlocks(snapshot.edit.bodyMd) : []),
    [snapshot, showPreview],
  );

  if (editor.loadState === "loading") {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-ink-soft)]" role="status">
        正在加载笔记…
      </div>
    );
  }

  if (editor.loadState === "error") {
    return (
      <div className="space-y-2 rounded-xl border border-[var(--color-accent-2)] bg-[var(--color-surface)] p-4" role="alert">
        <p className="text-sm text-[var(--color-ink)]">{editor.loadError ?? "加载笔记失败"}</p>
        <Button size="sm" variant="secondary" onClick={editor.reload}>
          重试加载
        </Button>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-ink-soft)]" role="status">
        正在加载笔记…
      </div>
    );
  }

  const { edit, state } = snapshot;
  const editingLocked = editor.recoveryLoading || editor.navigationLocked;
  const overTitle = edit.title.length > TITLE_MAX;
  const overBody = edit.bodyMd.length > BODY_MAX;

  const handleCopy = async (): Promise<void> => {
    const result = await editor.copyLocalContent();
    setCopyState(result);
  };

  return (
    <div className="space-y-3" data-testid="study-note-editor">
      {/* 状态条（诚实） */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-[var(--color-ink-soft)]">
          <span role="status" aria-live="polite" data-testid="save-state">
            保存状态：{SAVE_STATE_LABELS[state]}
          </span>
          {snapshot.lastSavedAt && state === "idle" && <span>· {formatSavedAt(snapshot.lastSavedAt)}</span>}
          <span>· 字符数 {edit.bodyMd.length}</span>
          <span>· 引用 {edit.references.length} 条</span>
        </div>
        <div className="flex items-center gap-2">
          {state === "error" && (
            <Button size="sm" variant="secondary" onClick={() => void editor.retry()} disabled={editingLocked}>
              重试保存
            </Button>
          )}
          {!showPreview && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                insertCursorRef.current = bodyRef.current?.selectionStart ?? null;
                setShowPicker(true);
              }}
              disabled={editingLocked}
              data-testid="insert-reference-button"
            >
              插入引用
            </Button>
          )}
          <Button size="sm" variant={showPreview ? "primary" : "ghost"} onClick={() => setShowPreview((value) => !value)}>
            {showPreview ? "返回编辑" : "预览"}
          </Button>
          {leaveAction && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void editor.requestNavigation(leaveAction.onLeave)}
              disabled={editingLocked}
              data-testid="leave-action"
            >
              {leaveAction.label}
            </Button>
          )}
        </div>
      </div>

      {/* 标题 */}
      <div>
        <input
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
          placeholder="无标题笔记"
          value={edit.title}
          onChange={(event) => editor.setTitle(event.target.value)}
          onCompositionStart={editor.onCompositionStart}
          onCompositionEnd={editor.onCompositionEnd}
          disabled={editingLocked}
          aria-label="笔记标题"
          data-testid="note-title"
        />
        {overTitle && <p className="mt-1 text-[11px] text-[var(--color-accent-2)]">标题超过 {TITLE_MAX} 字符上限，保存将被拒绝；请先精简。</p>}
      </div>

      {/* 正文 / 预览 */}
      {showPreview ? (
        <div className="min-h-[240px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3" data-testid="note-preview">
          {edit.bodyMd.trim() ? (
            blocks.map((block, index) =>
              block.kind === "markdown" ? (
                <Markdown key={index} content={block.text} />
              ) : (
                <ReferencePlaceholder
                  key={index}
                  refId={block.refId}
                  meta={editor.referencesMeta.find((reference) => reference.id.toLowerCase() === block.refId.toLowerCase())}
                  onRemove={(refId) => {
                    editor.removeReference(refId);
                  }}
                  onConvert={(refId) => {
                    editor.convertReferenceToExcerpt(refId);
                  }}
                />
              ),
            )
          ) : (
            <p className="text-sm text-[var(--color-ink-soft)]">（空白笔记）</p>
          )}
        </div>
      ) : (
        <div>
          <textarea
            ref={bodyRef}
            className="min-h-[240px] w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
            placeholder="在这里写正文…（支持 Markdown）"
            value={edit.bodyMd}
            onChange={(event) => editor.setBodyMd(event.target.value)}
            onCompositionStart={editor.onCompositionStart}
            onCompositionEnd={editor.onCompositionEnd}
            disabled={editingLocked}
            aria-label="笔记正文"
            data-testid="note-body"
          />
          {overBody && <p className="mt-1 text-[11px] text-[var(--color-accent-2)]">正文超过 {BODY_MAX} 字符上限，保存将被拒绝；请先精简。</p>}
        </div>
      )}

      {/* Task 09A：引用操作拒绝/未确认反馈（可见原因，不只返回 false/null） */}
      {editor.referenceError && (
        <div
          className="flex items-start justify-between gap-2 rounded-lg border border-[var(--color-accent-2)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-ink)]"
          role="alert"
          data-testid="reference-error"
        >
          <span className="min-w-0 flex-1">{editor.referenceError}</span>
          <button
            type="button"
            className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-soft)]"
            onClick={editor.dismissReferenceError}
          >
            知道了
          </button>
        </div>
      )}

      {/* Task 09A：引用选择面板（搜索 → 预览 → 插入；插入经 hook 原子 patch） */}
      {showPicker && (
        <StudyReferencePicker
          client={activeClient}
          onInsert={(target, preview) => {
            // 以「插入时刻」的选区为准（面板打开期间光标可能已移动）；textarea 不可用时回退到打开时快照
            const cursor = bodyRef.current?.selectionStart ?? insertCursorRef.current;
            return editor.insertReference(target, preview, cursor) !== null;
          }}
          onClose={() => setShowPicker(false)}
        />
      )}

      {/* 冲突面板（复制本地内容 / 显式载入服务器版本；无「确认已合并后重试」） */}
      {state === "conflict" && (
        <div
          className="space-y-2 rounded-lg border border-[var(--color-accent-2)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-ink)]"
          role="alert"
          data-testid="conflict-panel"
        >
          <p className="font-medium">
            检测到保存冲突：这篇笔记已在其他窗口被更新{snapshot.conflictCurrentVersion !== null ? `（服务器版本 ${snapshot.conflictCurrentVersion}）` : ""}。
          </p>
          <p>你的本地内容仍在。建议先复制本地内容留存，再决定是否载入服务器版本。</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => void handleCopy()}>
              复制本地内容
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void editor.loadServerVersion()} disabled={editor.recoveryLoading}>
              {editor.recoveryLoading ? "载入中…" : "载入服务器版本"}
            </Button>
            <span className="text-[var(--color-ink-soft)]">（载入将放弃本地未保存的修改；随后可重新编辑保存）</span>
          </div>
          {copyState && copyState.ok && <p className="text-[var(--color-ink-soft)]">已复制本地内容（含标题/归属/引用清单）。</p>}
          {copyState && !copyState.ok && (
            <div className="space-y-1">
              <p className="text-[var(--color-accent-2)]">复制失败：请手动选择下方文本并复制。</p>
              <textarea
                readOnly
                className="h-32 w-full resize-y rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[11px] text-[var(--color-ink)]"
                value={copyState.text}
                data-testid="copy-fallback"
              />
            </div>
          )}
          {editor.recoveryError && <p className="text-[var(--color-accent-2)]">{editor.recoveryError}</p>}
        </div>
      )}

      {/* 预检阻止（引用标记与引用清单不一致） */}
      {state === "invalid" && (
        <div
          className="space-y-1 rounded-lg border border-[var(--color-accent-2)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-ink)]"
          role="alert"
          data-testid="invalid-panel"
        >
          <p className="font-medium">内容未通过保存前预检，已阻止提交。</p>
          <p>{snapshot.invalidReason ?? "引用标记与引用清单不一致。"}</p>
          <p className="text-[var(--color-ink-soft)]">参考恢复方式：撤销对引用标记行的删除/修改（表格收回 Ctrl+Z），或恢复引用清单；修订后会自动恢复保存。</p>
        </div>
      )}

      {/* 保存失败提示（R1：区分服务端确定拒绝 / 身份失败 / 结果不明，字段错误可读） */}
      {state === "error" && (
        <p className="text-xs text-[var(--color-accent-2)]" role="alert" data-testid="error-panel">
          {snapshot.errorKind === "rejected"
            ? `保存被服务端拒绝${snapshot.lastErrorMessage ? `（${snapshot.lastErrorMessage}）` : ""}：本地输入已保留；请修正内容后点「重试保存」提交当前最新内容。`
            : snapshot.errorKind === "auth"
              ? "登录状态或权限已失效：本地输入已保留；请重新登录后点「重试保存」继续。"
              : "保存失败（网络或服务异常）：本地输入已保留；可点「重试保存」继续。若持续失败，建议先复制内容留存。"}
        </p>
      )}

      {/* 恢复错误提示（非冲突态的载入失败） */}
      {editor.recoveryError && state !== "conflict" && (
        <p className="text-xs text-[var(--color-accent-2)]" role="alert">
          {editor.recoveryError}
        </p>
      )}

      {/* 导航锁提示 */}
      {editor.navigationLocked && (
        <p className="text-xs text-[var(--color-ink-soft)]" role="status">
          正在保存并确认未保存内容，请稍候…
        </p>
      )}
      {editor.navigationError && (
        <p className="text-xs text-[var(--color-accent-2)]" role="alert" data-testid="navigation-error">
          {editor.navigationError}
        </p>
      )}
    </div>
  );
}
