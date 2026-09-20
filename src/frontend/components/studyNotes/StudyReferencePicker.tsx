/**
 * Task 09A · 引用选择面板——分页查找现有对象 → 预览 → 插入引用。
 *
 * 纪律：
 *  - 搜索经 `studyReferenceSearchModel`（协议 R1–R5；切 kind/q/venue 清 cursor）；
 *  - 预览经 `client.preview(target)`（只读，不持久化）；插入由宿主（编辑器）执行
 *    （capture write + marker 同一次 patch）；
 *  - 面板不直接改笔记；未选择目标不产生任何写入。
 */
import { useEffect, useRef, useState } from "react";
import type { ReferenceTarget, ReferenceTargetPreview } from "@/domain/l3-study-notes";
import type { StudyNotesClient, StudyTargetItem } from "@/frontend/api/studyNotesClient";
import { Button } from "@/frontend/components/ui/Button";
import {
  createStudyReferenceSearchModel,
  type ReferenceSearchModel,
  type ReferenceSearchSnapshot,
} from "@/frontend/state/studyReferenceSearchModel";
import { L3_QUESTION_TYPES, L3_QUESTION_TYPE_LABELS } from "@/domain/l3-question-types";

export interface StudyReferencePickerProps {
  client: StudyNotesClient;
  /** 插入：宿主把 (target, preview) 写入编辑器（capture + marker）；返回 false 表示被锁。 */
  onInsert: (target: ReferenceTarget, preview: ReferenceTargetPreview) => boolean;
  onClose: () => void;
}

function targetOf(item: StudyTargetItem): ReferenceTarget {
  if ("title" in item) return { kind: "source", sourceId: item.id };
  return { kind: "question", questionId: item.id };
}

function itemLabel(item: StudyTargetItem): string {
  return "title" in item ? item.title : item.stem;
}

function previewSummary(preview: ReferenceTargetPreview): string {
  const snapshot = preview.displaySnapshot;
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

export function StudyReferencePicker({ client, onInsert, onClose }: StudyReferencePickerProps) {
  const modelRef = useRef<ReferenceSearchModel | null>(null);
  const ensureModel = (): ReferenceSearchModel => {
    const existing = modelRef.current;
    if (existing && !existing.isDisposed()) return existing;
    const created = createStudyReferenceSearchModel({
      search: (query) => client.searchTargets(query),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    modelRef.current = created;
    return created;
  };
  const model = ensureModel();
  const [snapshot, setSnapshot] = useState<ReferenceSearchSnapshot>(() => model.getSnapshot());
  const [previewState, setPreviewState] = useState<
    | { phase: "idle" }
    | { phase: "loading"; target: ReferenceTarget }
    | { phase: "ready"; target: ReferenceTarget; preview: ReferenceTargetPreview }
    | { phase: "error"; message: string }
  >({ phase: "idle" });
  const previewSeqRef = useRef(0);

  useEffect(() => {
    const current = ensureModel(); // StrictMode：cleanup 处置旧实例后，重挂载需重建（否则面板永久失效）
    const unsubscribe = current.subscribe(() => setSnapshot(current.getSnapshot()));
    setSnapshot(current.getSnapshot());
    return () => {
      unsubscribe();
      current.dispose();
      modelRef.current = null; // 卸下已处置实例：下次挂载（含 StrictMode 双调用）重建
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ensureModel 只依赖 client；实例生命周期由本 effect 接管
  }, [client]);

  /** 作废在途预览并清空预览卡（筛选变化/取消时防止插入过期预览）。 */
  const resetPreview = (): void => {
    previewSeqRef.current += 1;
    setPreviewState((prev) => (prev.phase === "idle" ? prev : { phase: "idle" }));
  };

  const handlePreview = (item: StudyTargetItem): void => {
    const target = targetOf(item);
    const seq = ++previewSeqRef.current;
    setPreviewState({ phase: "loading", target });
    void client
      .preview(target)
      .then((preview) => {
        if (previewSeqRef.current !== seq) return;
        setPreviewState({ phase: "ready", target, preview });
      })
      .catch((error: unknown) => {
        if (previewSeqRef.current !== seq) return;
        const status = (error as { status?: unknown } | null)?.status;
        setPreviewState({
          phase: "error",
          message:
            status === 404
              ? "该目标当前不可用（可能已删除或未发布）。"
              : error instanceof Error && error.message
                ? error.message
                : "预览失败，请重试。",
        });
      });
  };

  const handleInsert = (): void => {
    if (previewState.phase !== "ready") return;
    if (onInsert(previewState.target, previewState.preview)) {
      onClose();
    }
  };

  const filters = snapshot.filters;
  return (
    <section
      className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
      data-testid="reference-picker"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-[var(--color-ink-soft)]">插入引用</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`rounded-full border px-2 py-0.5 text-[11px] ${filters.kind === "source" ? "border-[var(--color-accent)] text-[var(--color-ink)]" : "border-[var(--color-border)] text-[var(--color-ink-soft)]"}`}
            onClick={() => {
              resetPreview();
              model.setKind("source");
            }}
            data-testid="ref-picker-kind-source"
          >
            来源
          </button>
          <button
            type="button"
            className={`rounded-full border px-2 py-0.5 text-[11px] ${filters.kind === "question" ? "border-[var(--color-accent)] text-[var(--color-ink)]" : "border-[var(--color-border)] text-[var(--color-ink-soft)]"}`}
            onClick={() => {
              resetPreview();
              model.setKind("question");
            }}
            data-testid="ref-picker-kind-question"
          >
            题目
          </button>
          <Button size="sm" variant="ghost" onClick={onClose} data-testid="ref-picker-close">
            关闭
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
          placeholder="搜索标题/题干…"
          value={filters.q ?? ""}
          onChange={(event) => {
            resetPreview();
            model.setQuery(event.target.value);
          }}
          data-testid="ref-picker-q"
        />
        {filters.kind === "question" && (
          <select
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-ink)]"
            value={filters.venue ?? ""}
            onChange={(event) => {
              resetPreview();
              model.setVenue((event.target.value || null) as (typeof L3_QUESTION_TYPES)[number] | null);
            }}
            data-testid="ref-picker-venue"
          >
            <option value="">全部题型</option>
            {L3_QUESTION_TYPES.map((venue) => (
              <option key={venue} value={venue}>
                {L3_QUESTION_TYPE_LABELS[venue]}
              </option>
            ))}
          </select>
        )}
      </div>

      {snapshot.state === "loading" && (
        <p className="text-xs text-[var(--color-ink-soft)]" role="status">
          正在搜索…
        </p>
      )}
      {snapshot.error && (
        <div className="flex items-center gap-2" role="alert" data-testid="ref-picker-error">
          <p className="text-xs text-[var(--color-accent-2)]">{snapshot.error}</p>
          <Button size="sm" variant="ghost" onClick={() => model.refresh()}>
            刷新
          </Button>
        </div>
      )}

      <div className="max-h-52 space-y-1 overflow-y-auto">
        {snapshot.candidates.map((item) => (
          <button
            key={item.id}
            type="button"
            className="w-full rounded-lg border border-[var(--color-border)] px-2 py-1.5 text-left text-xs text-[var(--color-ink)] hover:border-[var(--color-accent)]"
            onClick={() => handlePreview(item)}
            data-testid="ref-picker-item"
            data-target-id={item.id}
          >
            <span className="block truncate">{itemLabel(item)}</span>
          </button>
        ))}
        {snapshot.state === "ready" && snapshot.candidates.length === 0 && (
          <p className="text-[11px] text-[var(--color-ink-soft)]">没有匹配的对象。</p>
        )}
        {snapshot.nextCursor && (
          <Button
            size="sm"
            variant="ghost"
            disabled={snapshot.loadingMore}
            onClick={() => void model.loadMore()}
            data-testid="ref-picker-load-more"
          >
            {snapshot.loadingMore ? "加载中…" : "加载更多"}
          </Button>
        )}
      </div>

      {previewState.phase === "loading" && (
        <p className="text-xs text-[var(--color-ink-soft)]" role="status" data-testid="ref-preview-loading">
          正在预览…
        </p>
      )}
      {previewState.phase === "error" && (
        <p className="text-xs text-[var(--color-accent-2)]" role="alert" data-testid="ref-preview-error">
          {previewState.message}
        </p>
      )}
      {previewState.phase === "ready" && (
        <div
          className="space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2"
          data-testid="ref-preview-card"
        >
          <p className="text-xs text-[var(--color-ink)]">{previewSummary(previewState.preview)}</p>
          {previewState.preview.liveTitle && (
            <p className="text-[10px] text-[var(--color-ink-soft)]">来源：{previewState.preview.liveTitle}</p>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={handleInsert} data-testid="ref-picker-insert">
              插入引用
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={resetPreview}
              data-testid="ref-picker-cancel"
            >
              取消
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
