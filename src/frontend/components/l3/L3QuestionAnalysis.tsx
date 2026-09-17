import { useEffect, useRef, useState } from "react";
import type { ExamQuestion } from "./examTypes";
import type {
  AnnotationTagDict,
  CreateQuestionAnnotationRequest,
  L3Attempt,
  QuestionAnnotation,
  QuestionAnnotationOptionKey,
  QuestionAnnotationPatchRequest,
} from "@/frontend/api/l3Client";
import { annotationCoverage } from "@/domain/l3-annotations";

/**
 * 题卡「原文分析」折叠子区（批次一）。
 *
 * - 默认折叠，标题「原文分析 · N」；条目卡支持定位锚点、行内编辑/软删。
 * - 无锚点条目在此内联新增（有锚点条目由文栏划词分叉创建）。
 * - A–D 选项错误类型走多选浮层（字典项 + 内联新建，新建即 PUT 字典并选中）。
 * 铁律：浮层/打标按钮的内部点击一律 stopPropagation，不冒泡到题卡。
 */

const OPTION_KEYS: QuestionAnnotationOptionKey[] = ["A", "B", "C", "D"];
const TAG_MAX_LENGTH = 30;

interface L3QuestionAnalysisProps {
  question: ExamQuestion;
  annotations: QuestionAnnotation[];
  tagDict: AnnotationTagDict;
  onLocate: (anchor: { start: number; end: number }) => void;
  onCreate: (input: CreateQuestionAnnotationRequest) => Promise<void>;
  onPatch: (id: string, patch: QuestionAnnotationPatchRequest) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSaveTagDict: (dict: AnnotationTagDict) => Promise<void>;
  /** 批次二：该题作答历史（徽标数据源；父层已过滤已删条目）。 */
  attempts?: L3Attempt[];
  /** 批次二：点徽标打开历史 modal。 */
  onOpenHistory?: () => void;
}

interface FormState {
  note: string;
  entryTags: string[];
  optionTags: Partial<Record<QuestionAnnotationOptionKey, string[]>>;
}

const EMPTY_FORM: FormState = { note: "", entryTags: [], optionTags: {} };

type PopoverTarget = { kind: "entry" | "option"; optionKey?: QuestionAnnotationOptionKey };

function toggleLabel(list: string[], label: string): string[] {
  return list.includes(label) ? list.filter((value) => value !== label) : [...list, label];
}

function uniqueAppend(list: readonly string[], label: string): string[] {
  return list.includes(label) ? [...list] : [...list, label];
}

function TagChip({ label, active, onClick, onPointerDown }: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  onPointerDown?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      onPointerDown={(e) => { e.stopPropagation(); onPointerDown?.(); }}
      className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] ring-1 transition-colors ${
        active
          ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))] ring-[var(--color-accent)]"
          : "bg-[var(--color-surface)] text-[var(--color-ink-soft)] ring-[var(--color-border)] hover:ring-[var(--color-accent)]"
      }`}
    >
      {label}
    </button>
  );
}

function TagMultiSelectPopover({
  title,
  labels,
  selected,
  onToggle,
  onCreate,
  onClose,
}: {
  title: string;
  labels: readonly string[];
  selected: readonly string[];
  onToggle: (label: string) => void;
  onCreate: (label: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const submitNew = async () => {
    const label = draft.trim();
    if (!label) return;
    if (label.length > TAG_MAX_LENGTH) {
      setError(`标签最长 ${TAG_MAX_LENGTH} 字`);
      return;
    }
    if (labels.includes(label)) {
      setError("标签已存在");
      return;
    }
    try {
      await onCreate(label);
      setDraft("");
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "新建失败");
    }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={title}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute right-0 z-40 mt-1 w-52 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 shadow-lg"
    >
      <p className="mb-1.5 text-[11px] font-semibold text-[var(--color-ink-soft)]">{title}</p>
      <div className="flex max-h-44 flex-wrap content-start gap-1 overflow-y-auto">
        {labels.map((label) => (
          <TagChip key={label} label={label} active={selected.includes(label)} onClick={() => onToggle(label)} />
        ))}
        {labels.length === 0 && <p className="text-[11px] text-[var(--color-ink-soft)]">暂无标签，先新建一个</p>}
      </div>
      <div className="mt-2 flex items-center gap-1 border-t border-[var(--color-border)] pt-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); void submitNew(); } }}
          placeholder="新标签名"
          className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] focus:border-[var(--color-accent)] focus:outline-none"
        />
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); void submitNew(); }}
          className="shrink-0 rounded-md bg-[var(--color-accent)] px-2 py-1 text-[11px] font-semibold text-[var(--color-accent-contrast,var(--color-surface))]"
        >
          ＋新建
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-rose-600">{error}</p>}
    </div>
  );
}

export function L3QuestionAnalysis({
  question,
  annotations,
  tagDict,
  onLocate,
  onCreate,
  onPatch,
  onDelete,
  onSaveTagDict,
  attempts,
  onOpenHistory,
}: L3QuestionAnalysisProps) {
  const [expanded, setExpanded] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [popover, setPopover] = useState<PopoverTarget | null>(null);

  const optionKeys = question.options
    .map((option) => option.key)
    .filter((key): key is QuestionAnnotationOptionKey =>
      (OPTION_KEYS as readonly string[]).includes(key),
    );

  // 覆盖度视图（批次二，设计卡 §4.4）：按选项键呈现被注记覆盖情况，只呈现不催。
  const coverage = annotationCoverage(
    annotations.map((annotation) => ({ optionTags: annotation.option_tags })),
    optionKeys,
  );

  // 徽标（批次二）：跨 venue 历史计数 + 最近自评标记（verdict 数据由批次三评卷接入，
  // 无数据时只显示次数——优雅降级，不造伪标记）。
  const attemptCount = attempts?.length ?? 0;
  const latestVerdict = attemptCount > 0
    ? (attempts![attemptCount - 1]!.self_assessment as { verdict?: unknown } | null)?.verdict
    : null;
  const latestMark = latestVerdict === "correct" ? "✓" : latestVerdict === "wrong" ? "✗" : null;

  const openComposer = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setComposerOpen(true);
  };

  const openEditor = (annotation: QuestionAnnotation) => {
    setEditingId(annotation.id);
    setForm({
      note: annotation.note,
      entryTags: [...annotation.entry_tags],
      optionTags: { ...annotation.option_tags },
    });
    setFormError(null);
    setComposerOpen(true);
  };

  const toggleEntryTag = (label: string) => {
    setForm((prev) => ({ ...prev, entryTags: toggleLabel(prev.entryTags, label) }));
  };

  const toggleOptionTag = (key: QuestionAnnotationOptionKey, label: string) => {
    setForm((prev) => ({
      ...prev,
      optionTags: { ...prev.optionTags, [key]: toggleLabel(prev.optionTags[key] ?? [], label) },
    }));
  };

  /** 浮层内新建标签：PUT 字典并立即在当前表单选中。 */
  const createLabel = async (label: string) => {
    const kind = popover?.kind;
    if (!kind) return;
    const nextDict: AnnotationTagDict = {
      entry: kind === "entry" ? uniqueAppend(tagDict.entry, label) : tagDict.entry,
      option: kind === "option" ? uniqueAppend(tagDict.option, label) : tagDict.option,
    };
    await onSaveTagDict(nextDict);
    if (kind === "entry") toggleEntryTag(label);
    else if (popover.optionKey) toggleOptionTag(popover.optionKey, label);
  };

  const submitForm = async () => {
    if (form.note.trim().length === 0 && form.entryTags.length === 0
      && Object.values(form.optionTags).every((list) => (list ?? []).length === 0)) {
      setFormError("无锚点条目至少写一条笔记或选择一个标签");
      return;
    }
    setBusy(true);
    setFormError(null);
    const payload = {
      note: form.note.trim(),
      entryTags: form.entryTags,
      optionTags: form.optionTags,
    };
    try {
      if (editingId) {
        await onPatch(editingId, payload);
      } else {
        await onCreate({ questionId: question.id, ...payload });
      }
      setComposerOpen(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      setPopover(null);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const popoverLabels = popover?.kind === "entry" ? tagDict.entry : tagDict.option;
  const popoverSelected = popover?.kind === "entry"
    ? form.entryTags
    : popover?.optionKey ? (form.optionTags[popover.optionKey] ?? []) : [];

  return (
    <div className="mt-2.5 border-t border-dashed border-[var(--color-border)] pt-2">
      <div className="flex w-full items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {attemptCount > 0 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenHistory?.(); }}
              title="查看作答历史"
              className="shrink-0 whitespace-nowrap rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-ink-soft)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              做过 {attemptCount} 次{latestMark ? ` · 最近 ${latestMark}` : ""}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            aria-expanded={expanded}
            className="min-w-0 truncate whitespace-nowrap text-xs font-semibold text-[var(--color-ink-soft)] hover:text-[var(--color-accent)]"
          >
            原文分析 · {annotations.length}
          </button>
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
          className="shrink-0 text-[10px] text-[var(--color-ink-soft)] hover:text-[var(--color-accent)]"
        >
          {expanded ? "收起 ▴" : "展开 ▸"}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-2" onClick={(e) => e.stopPropagation()}>
          {coverage.length > 0 && (
            <p className="text-[11px] text-[var(--color-ink-soft)]" title="选项被注记覆盖的情况（只呈现，不催促）">
              {coverage.map((entry) => `${entry.key}${entry.covered ? "✓" : "—"}`).join(" ")}
            </p>
          )}
          {annotations.map((annotation) => (
            <li
              key={annotation.id}
              className={`list-none rounded-lg bg-[var(--color-surface)] p-2.5 text-xs leading-relaxed ${annotation.stage === "draft" ? "border border-dashed border-[var(--color-accent)]" : "ring-1 ring-[var(--color-border)]"}`}
            >
              {annotation.stage === "draft" && (
                <span className="mr-1 inline-block rounded-full border border-dashed border-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-accent)]">
                  草稿
                </span>
              )}
              {annotation.excerpt && annotation.anchor_start != null && annotation.anchor_end != null && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onLocate({ start: annotation.anchor_start!, end: annotation.anchor_end! });
                  }}
                  className="mb-1 mr-2 rounded-md border border-[var(--color-accent)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent)] hover:bg-[var(--color-accent-soft,var(--color-surface))]"
                >
                  定位「{annotation.excerpt}」
                </button>
              )}
              {annotation.entry_tags.map((label) => (
                <span key={label} className="mr-1 inline-block rounded-full bg-[var(--color-accent-soft,var(--color-surface))] px-2 py-0.5 text-[10px] text-[var(--color-accent)]">
                  {label}
                </span>
              ))}
              {annotation.note && <p className="mt-1 whitespace-pre-wrap text-[var(--color-ink)]">{annotation.note}</p>}
              {OPTION_KEYS.filter((key) => (annotation.option_tags[key] ?? []).length > 0).map((key) => (
                <p key={key} className="mt-1 flex flex-wrap items-center gap-1">
                  <span className="font-semibold text-[var(--color-ink-soft)]">{key}</span>
                  {(annotation.option_tags[key] ?? []).map((label) => (
                    <span key={label} className="rounded-full bg-[var(--color-surface)] px-2 py-0.5 text-[10px] ring-1 ring-[var(--color-border)]">
                      {label}
                    </span>
                  ))}
                </p>
              ))}
              <span className="mt-1.5 flex justify-end gap-2">
                <button
                  type="button"
                  aria-label="编辑"
                  onClick={(e) => { e.stopPropagation(); openEditor(annotation); }}
                  className="text-[10px] text-[var(--color-ink-soft)] hover:text-[var(--color-accent)]"
                >
                  编辑
                </button>
                <button
                  type="button"
                  aria-label="删除"
                  onClick={(e) => { e.stopPropagation(); void onDelete(annotation.id); }}
                  className="text-[10px] text-[var(--color-ink-soft)] hover:text-rose-600"
                >
                  删除
                </button>
              </span>
            </li>
          ))}

          {composerOpen ? (
            <div className="relative space-y-2 rounded-lg p-2 ring-1 ring-[var(--color-accent)]">
              {editingId && (
                <p className="text-[10px] text-[var(--color-ink-soft)]">编辑中：笔记与标签可改，原文锚点保持不变。</p>
              )}
              <textarea
                aria-label="分析笔记"
                value={form.note}
                onChange={(e) => setForm((prev) => ({ ...prev, note: e.target.value }))}
                rows={2}
                placeholder="这题/选项为什么错？（无锚点的题型归因写这里）"
                className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs leading-relaxed focus:border-[var(--color-accent)] focus:outline-none"
              />
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[10px] font-semibold text-[var(--color-ink-soft)]">题型</span>
                {tagDict.entry.map((label) => (
                  <TagChip key={label} label={label} active={form.entryTags.includes(label)} onClick={() => toggleEntryTag(label)} />
                ))}
              </div>
              <div className="space-y-1">
                {optionKeys.map((key) => (
                  <div key={key} className="relative flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPopover({ kind: "option", optionKey: key });
                      }}
                      className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)]"
                    >
                      {key} 打标
                    </button>
                    {(form.optionTags[key] ?? []).map((label) => (
                      <TagChip
                        key={label}
                        label={label}
                        active
                        onClick={() => toggleOptionTag(key, label)}
                      />
                    ))}
                    {popover?.kind === "option" && popover.optionKey === key && (
                      <TagMultiSelectPopover
                        title={`${key} 选项打标`}
                        labels={tagDict.option}
                        selected={form.optionTags[key] ?? []}
                        onToggle={(label) => toggleOptionTag(key, label)}
                        onCreate={createLabel}
                        onClose={() => setPopover(null)}
                      />
                    )}
                  </div>
                ))}
              </div>
              {formError && <p className="text-[11px] text-rose-600">{formError}</p>}
              <span className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setComposerOpen(false); setEditingId(null); setPopover(null); }}
                  className="rounded-md px-2.5 py-1 text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={(e) => { e.stopPropagation(); void submitForm(); }}
                  className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-[11px] font-semibold text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50"
                >
                  保存条目
                </button>
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openComposer(); }}
              className="w-full rounded-md border border-dashed border-[var(--color-border)] py-1.5 text-[11px] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              ＋ 添加条目
            </button>
          )}
        </div>
      )}
    </div>
  );
}
