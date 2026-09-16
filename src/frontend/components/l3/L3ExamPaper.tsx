import { useMemo, useRef, useState, useEffect, useCallback, type ReactNode } from "react";
import { buildPassageSpans, enclosingSentence, type PassageSpan } from "./examPassageSpans";
import { L3QuestionAnalysis } from "./L3QuestionAnalysis";
import { L3SourceNotesDrawer } from "./L3SourceNotesDrawer";
import { apiFetch } from "@/frontend/api/client";
import {
  createQuestionAnnotation,
  deleteQuestionAnnotation,
  fetchAnnotationTags,
  fetchQuestionAnnotations,
  patchQuestionAnnotation,
  saveAnnotationTags,
  type AnnotationTagDict,
  type CreateQuestionAnnotationRequest,
  type QuestionAnnotation,
  type QuestionAnnotationPatchRequest,
} from "@/frontend/api/l3Client";
import { useToast } from "@/frontend/components/ui/Toast";

/**
 * 拟真卷面（ADR-0030 V1 展示面）：左文右题 + 即点即判 + 解析模式 + 翻译/作文书写区。
 * 批次一（2026-09-16）：文栏三通道（空位角标 / 官方 evidence 仅解析模式 /
 * 用户注记锚点全程）、划词分叉（建原文分析条目 / 圈词入笔记）、题卡原文分析子区。
 */

export interface ExamQuestion {
  id: string;
  ordinal: number;
  stem: string;
  options: Array<{ key: string; text: string }>;
  answer: { choice?: string; choices?: string[]; text?: string; sample?: string; points?: string[] };
  explanation: string | null;
  /** 官方 evidence 锚点（start/end 为 content UTF-16 偏移；仅解析模式渲染）。 */
  evidence?: Array<{ start: number; end: number; label: string }>;
}
export interface ExamSection {
  key: string;
  title: string;
  questionType:
    | "cloze" | "reading_choice" | "new_question" | "sentence_translation"
    | "short_essay" | "long_essay" | "grammar_blank";
  sourceId: string | null;
  fileKey: string | null;
  questionIds: string[];
  missing: boolean;
  missing_reason?: string;
  source_title: string | null;
  source_content: string | null;
  questions: ExamQuestion[];
}
export interface ExamPaper {
  id: string;
  title: string;
  direction: string | null;
  metadata: Record<string, unknown>;
  sections: ExamSection[];
}

interface LocateTarget {
  sectionKey: string;
  start: number;
  end: number;
  nonce: number;
}

const TYPE_SHORT: Record<ExamSection["questionType"], string> = {
  cloze: "完型",
  reading_choice: "阅读",
  new_question: "新题型",
  sentence_translation: "翻译",
  short_essay: "小作文",
  long_essay: "大作文",
  grammar_blank: "语法填空",
};

const OBJECTIVE_TYPES = new Set(["cloze", "reading_choice", "new_question", "grammar_blank"]);
const SECTION_POINTS: Record<string, number> = {
  cloze: 10,
  reading_choice: 40,
  new_question: 10,
  sentence_translation: 15,
  short_essay: 10,
  long_essay: 15,
};

/** 浏览器选区 → content 偏移：text 节点上溯最近的 [data-content-off] 文本段。 */
function selectionToContentOffsets(container: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const endNode = range.endContainer;
  if (startNode.nodeType !== Node.TEXT_NODE || endNode.nodeType !== Node.TEXT_NODE) return null;
  if (!container.contains(startNode) || !container.contains(endNode)) return null;
  const offsetOf = (node: Node): number | null => {
    const span = node.parentElement?.closest<HTMLElement>("[data-content-off]");
    if (!span) return null;
    const value = Number(span.dataset.contentOff);
    return Number.isFinite(value) ? value : null;
  };
  const startBase = offsetOf(startNode);
  const endBase = offsetOf(endNode);
  if (startBase == null || endBase == null) return null;
  const start = startBase + range.startOffset;
  const end = endBase + range.endOffset;
  return end > start ? { start, end } : null;
}

interface CaptureState {
  x: number;
  y: number;
  start: number;
  end: number;
  excerpt: string;
  mode: "menu" | "annotate" | "capture";
}

function PassageBody({
  section,
  content,
  revealAll,
  activeBlank,
  annotations,
  locate,
  questionDisplayNo,
  onJumpQuestion,
  onCreateAnnotation,
  onContextBuffered,
}: {
  section: ExamSection;
  content: string;
  revealAll: boolean;
  activeBlank: number | null;
  annotations: QuestionAnnotation[];
  locate: LocateTarget | null;
  questionDisplayNo: Map<string, number>;
  onJumpQuestion: (questionId: string) => void;
  onCreateAnnotation?: (input: CreateQuestionAnnotationRequest) => Promise<void>;
  onContextBuffered?: (contextId: string) => void;
}) {
  const passageRef = useRef<HTMLDivElement>(null);
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [pulseNonce, setPulseNonce] = useState(0);
  const [wordSlug, setWordSlug] = useState("");
  const [boundSense, setBoundSense] = useState("");
  const [busy, setBusy] = useState(false);
  const { addToast } = useToast();

  const evidence = useMemo(
    () => section.questions.flatMap((q) => q.evidence ?? []),
    [section.questions],
  );

  const spans = useMemo(
    () => buildPassageSpans(content, {
      evidence,
      annotations: annotations
        .filter((a) => a.anchor_start != null && a.anchor_end != null)
        .map((a) => ({ id: a.id, anchorStart: a.anchor_start, anchorEnd: a.anchor_end })),
      showEvidence: revealAll,
    }),
    [content, evidence, annotations, revealAll],
  );

  // 题卡定位钮 → 滚动到锚点并脉冲（nonce 保证重复点击同一锚点也重播动画）。
  useEffect(() => {
    if (!locate || locate.sectionKey !== section.key) return;
    const target = passageRef.current?.querySelector<HTMLElement>(
      `[data-ann-start="${locate.start}"][data-ann-end="${locate.end}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setPulseNonce(locate.nonce);
    const timer = setTimeout(() => setPulseNonce(0), 1400);
    return () => clearTimeout(timer);
  }, [locate, section.key]);

  // 浮条外点关闭 / Esc 关闭。
  useEffect(() => {
    if (!capture) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest("[data-exam-capture-bar]")) return;
      setCapture(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCapture(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [capture !== null]);

  const handleMouseUp = useCallback(() => {
    const container = passageRef.current;
    if (!container) return;
    const offsets = selectionToContentOffsets(container);
    if (!offsets) {
      setCapture(null);
      return;
    }
    const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
    setCapture({
      x: rect ? rect.left + rect.width / 2 : 120,
      y: rect ? rect.top : 120,
      start: offsets.start,
      end: offsets.end,
      excerpt: content.slice(offsets.start, offsets.end),
      mode: "menu",
    });
  }, [content]);

  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
    setCapture(null);
  };

  const createAnnotatedEntry = async (questionId: string) => {
    if (!capture || !onCreateAnnotation) return;
    setBusy(true);
    try {
      await onCreateAnnotation({
        questionId,
        anchorStart: capture.start,
        anchorEnd: capture.end,
        excerpt: capture.excerpt,
        note: "",
        entryTags: [],
        optionTags: {},
      });
      addToast("success", "已建原文分析条目，可在题卡补充标签与笔记");
      clearSelection();
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "创建失败");
      setBusy(false);
    }
  };

  const submitCaptureNote = async () => {
    if (!capture || !section.sourceId || !wordSlug.trim()) return;
    setBusy(true);
    try {
      const result = await apiFetch<{ contextId: string }>(`/l3/sources/${section.sourceId}/captures`, {
        method: "POST",
        body: JSON.stringify({
          text: enclosingSentence(content, capture.start, capture.end),
          anchorStart: capture.start,
          anchorEnd: capture.end,
          surface: capture.excerpt,
          wordSlug: wordSlug.trim(),
          boundSense: boundSense.trim() || null,
        }),
      });
      if (result.contextId) onContextBuffered?.(result.contextId);
      addToast("success", "已圈入素材笔记，可在素材空间回访处理");
      setWordSlug("");
      setBoundSense("");
      clearSelection();
    } catch (error) {
      addToast("error", error instanceof Error ? error.message : "圈记失败");
      setBusy(false);
    }
  };

  const renderedBadges = new Set<string>();

  return (
    <div>
      <div
        ref={passageRef}
        data-ann-passage
        onMouseUp={handleMouseUp}
        className="text-sm leading-8 [text-align:justify]"
      >
        {spans.map((span: PassageSpan) => {
          if (span.kind === "blank") {
            const isActiveBlank = activeBlank === span.blankNo;
            return (
              <button
                key={`${span.start}-${span.end}`}
                type="button"
                data-blank-no={span.blankNo}
                onClick={() => onJumpQuestion(section.questions.find((q) =>
                  section.questionType === "new_question" ? q.ordinal + 41 === span.blankNo : questionDisplayNo.get(q.id) === span.blankNo,
                )?.id ?? "")}
                className={`mx-0.5 inline-flex h-5 min-w-5 select-none items-center justify-center rounded px-1 text-[11px] font-semibold align-middle transition-all ${
                  isActiveBlank
                    ? "scale-110 bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]"
                    : "bg-[var(--color-accent-soft,var(--color-surface))] text-[var(--color-accent)] ring-1 ring-[var(--color-border)] hover:ring-[var(--color-accent)]"
                }`}
                title={`跳到第 ${span.blankNo} 空`}
              >
                {span.blankNo}
              </button>
            );
          }
          const text = content.slice(span.start, span.end);
          if (span.kind === "evidence") {
            return (
              <mark
                key={`${span.start}-${span.end}`}
                data-content-off={span.start}
                data-evidence
                className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-400/30"
              >
                {text}
              </mark>
            );
          }
          if (span.kind === "annotation") {
            const annotationId = span.annotationId!;
            const isPulsing = pulseNonce > 0
              && locate?.start === span.start && locate?.end === span.end;
            const showBadge = !renderedBadges.has(annotationId);
            if (showBadge) renderedBadges.add(annotationId);
            return (
              <span key={`${span.start}-${span.end}`} className="whitespace-nowrap">
                <mark
                  data-content-off={span.start}
                  data-ann-id={annotationId}
                  data-ann-start={span.start}
                  data-ann-end={span.end}
                  className={`rounded-sm border-b-2 border-[var(--color-accent)] px-0.5 text-inherit ${
                    isPulsing ? "[animation:exam-locate-pulse_1.2s_ease-out] rounded" : ""
                  }`}
                >
                  {text}
                </mark>
                {showBadge && (
                  <button
                    type="button"
                    data-ann-jump={annotationId}
                    onClick={(e) => {
                      e.stopPropagation();
                      const owner = annotations.find((a) => a.id === annotationId);
                      if (owner) onJumpQuestion(owner.question_id);
                    }}
                    title="查看该题的原文分析"
                    className="ml-0.5 inline-flex h-4 min-w-4 select-none items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[9px] font-bold leading-none text-[var(--color-accent-contrast,var(--color-surface))] align-middle"
                  >
                    {(() => {
                      const owner = annotations.find((a) => a.id === annotationId);
                      return owner ? (questionDisplayNo.get(owner.question_id) ?? "•") : "•";
                    })()}
                  </button>
                )}
              </span>
            );
          }
          return (
            <span key={`${span.start}-${span.end}`} data-content-off={span.start}>
              {text}
            </span>
          );
        })}
      </div>

      {capture && (
        <div
          data-exam-capture-bar
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            left: Math.min(Math.max(capture.x, 140), window.innerWidth - 140),
            top: Math.max(capture.y - 8, 72),
            transform: "translateX(-50%) translateY(-100%)",
          }}
          className="z-50 w-72 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-xl"
        >
          <p className="mb-2 line-clamp-2 rounded-md bg-[var(--color-accent-soft,var(--color-surface))] p-1.5 text-[11px] italic text-[var(--color-ink-soft)]">
            「{capture.excerpt}」
          </p>
          {capture.mode === "menu" && (
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                disabled={!onCreateAnnotation || busy}
                onClick={() => setCapture((c) => (c ? { ...c, mode: "annotate" } : c))}
                className="rounded-md bg-[var(--color-accent)] px-2 py-1.5 text-xs font-semibold text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50"
              >
                建原文分析条目
              </button>
              <button
                type="button"
                disabled={!section.sourceId || busy}
                onClick={() => {
                  setWordSlug(capture.excerpt.trim().split(/\s+/)[0]?.slice(0, 30) ?? "");
                  setCapture((c) => (c ? { ...c, mode: "capture" } : c));
                }}
                className="rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-ink)] hover:border-[var(--color-accent)] disabled:opacity-50"
              >
                圈词入笔记
              </button>
            </div>
          )}
          {capture.mode === "annotate" && (
            <div className="max-h-48 space-y-1 overflow-y-auto">
              <p className="text-[10px] text-[var(--color-ink-soft)]">挂到哪道题？（锚点已自动带入）</p>
              {section.questions.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void createAnnotatedEntry(q.id)}
                  className="block w-full truncate rounded-md px-2 py-1 text-left text-[11px] hover:bg-[var(--color-accent-soft,var(--color-surface))] disabled:opacity-50"
                >
                  第 {questionDisplayNo.get(q.id)} 题 · {q.stem}
                </button>
              ))}
              <button type="button" onClick={() => setCapture(null)} className="text-[10px] text-[var(--color-ink-soft)]">取消</button>
            </div>
          )}
          {capture.mode === "capture" && (
            <div className="space-y-2">
              <input
                value={wordSlug}
                onChange={(e) => setWordSlug(e.target.value)}
                placeholder="目标词（slug）"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] focus:border-[var(--color-accent)] focus:outline-none"
              />
              <input
                value={boundSense}
                onChange={(e) => setBoundSense(e.target.value)}
                placeholder="语境义（可选）"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] focus:border-[var(--color-accent)] focus:outline-none"
              />
              <span className="flex justify-end gap-2">
                <button type="button" onClick={() => setCapture(null)} className="text-[11px] text-[var(--color-ink-soft)]">取消</button>
                <button
                  type="button"
                  disabled={busy || !wordSlug.trim()}
                  onClick={() => void submitCaptureNote()}
                  className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50"
                >
                  存入笔记
                </button>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OptionRow({
  optionKey, text, state, onSelect,
}: {
  optionKey: string;
  text: string;
  state: "idle" | "correct" | "wrong" | "muted";
  onSelect: () => void;
}) {
  const styles = {
    idle: "border-[var(--color-border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft,var(--color-surface))]",
    correct: "border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
    wrong: "border-rose-500 bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200 [animation:exam-shake_.2s_ease-in-out]",
    muted: "border-[var(--color-border)] opacity-60",
  }[state];
  const badge = {
    idle: "border-[var(--color-border)] text-[var(--color-ink-soft)]",
    correct: "border-emerald-500 bg-emerald-500 text-white",
    wrong: "border-rose-500 bg-rose-500 text-white",
    muted: "border-[var(--color-border)] text-[var(--color-ink-soft)]",
  }[state];
  return (
    <button type="button" onClick={onSelect} disabled={state !== "idle"}
      className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-all ${styles}`}>
      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${badge}`}>
        {state === "correct" ? "✓" : state === "wrong" ? "✕" : optionKey}
      </span>
      <span className="leading-relaxed">{text}</span>
    </button>
  );
}

function ChoiceQuestion({
  question,
  index,
  revealAll,
  picked,
  onPick,
  analysis,
}: {
  question: ExamQuestion;
  index: number;
  revealAll: boolean;
  picked?: string;
  onPick: (key: string) => void;
  analysis?: ReactNode;
}) {
  const correct = question.answer.choice;
  const answered = Boolean(picked);
  const showResult = revealAll || answered;
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3.5 transition-shadow hover:shadow-sm">
      <div className="mb-2.5 flex items-start gap-2">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft,var(--color-surface))] text-xs font-bold text-[var(--color-accent)]">
          {index}
        </span>
        <p className="text-sm font-medium leading-relaxed">{question.stem}</p>
      </div>
      <div className="grid gap-1.5">
        {question.options.map((opt) => {
          let state: "idle" | "correct" | "wrong" | "muted" = "idle";
          if (showResult && correct) {
            if (opt.key === correct) state = "correct";
            else if (opt.key === picked) state = "wrong";
            else if (answered || revealAll) state = "muted";
          }
          return <OptionRow key={opt.key} optionKey={opt.key} text={opt.text} state={state} onSelect={() => onPick(opt.key)} />;
        })}
      </div>
      {showResult && question.explanation && (
        <details className="group mt-2.5 rounded-lg bg-[var(--color-surface)] p-2.5 text-xs leading-relaxed text-[var(--color-ink-soft)] ring-1 ring-[var(--color-border)]" open={revealAll}>
          <summary className="cursor-pointer select-none font-medium text-[var(--color-ink)]">解析</summary>
          <p className="mt-1.5 whitespace-pre-wrap">{question.explanation}</p>
        </details>
      )}
      {analysis}
    </div>
  );
}

function WrittenQuestion({
  question,
  kind,
  placeholder,
  analysis,
}: {
  question: ExamQuestion;
  kind: "translation" | "essay";
  placeholder: string;
  analysis?: ReactNode;
}) {
  const reference = kind === "translation" ? question.answer.text : question.answer.sample;
  return (
    <div className="space-y-3">
      <div className="whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm leading-7">
        {question.stem}
      </div>
      <textarea
        rows={kind === "translation" ? 7 : 12}
        placeholder={placeholder}
        className="w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm leading-7 [background-image:repeating-linear-gradient(transparent,transparent_27px,var(--color-border)_28px)] [background-position:0_11px] focus:border-[var(--color-accent)] focus:outline-none"
      />
      {reference && (
        <details className="rounded-xl border border-emerald-500/40 bg-emerald-50/60 p-3.5 dark:bg-emerald-950/20">
          <summary className="cursor-pointer select-none text-sm font-semibold text-emerald-700 dark:text-emerald-300">
            {kind === "translation" ? "参考译文（官方解析整理）" : "参考范文"}
          </summary>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-emerald-900 dark:text-emerald-200">{reference}</p>
          {question.explanation && <p className="mt-2 text-xs leading-relaxed text-emerald-700/80 dark:text-emerald-300/70">{question.explanation}</p>}
        </details>
      )}
      {analysis}
    </div>
  );
}

export function L3ExamPaper({ paper, onBack }: { paper: ExamPaper; onBack: () => void }) {
  const { addToast } = useToast();
  const [revealAll, setRevealAll] = useState(false);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [activeBlank, setActiveBlank] = useState<number | null>(null);
  const [activeSection, setActiveSection] = useState(paper.sections[0]?.key ?? "");
  const [locate, setLocate] = useState<LocateTarget | null>(null);
  const [annotations, setAnnotations] = useState<QuestionAnnotation[]>([]);
  const [tagDict, setTagDict] = useState<AnnotationTagDict | null>(null);
  /** 本会话划词「圈词入笔记」新建的 context id（抽屉打缓冲徽标）。 */
  const [bufferedContextIds, setBufferedContextIds] = useState<ReadonlySet<string>>(new Set());
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  // 卷面加载后按全部 section 的 questionIds 批量拉注记 + 标签字典（首读 lazy-seed）。
  useEffect(() => {
    let cancelled = false;
    const allQuestionIds = [...new Set(paper.sections.flatMap((section) => section.questionIds))];
    if (allQuestionIds.length === 0) return;
    Promise.all([
      fetchQuestionAnnotations(allQuestionIds),
      fetchAnnotationTags(),
    ]).then(([items, dict]) => {
      if (cancelled) return;
      // 双保险：l3Client 已做形状归一，这里再保证 state 恒为数组（防止任何脏数据进迭代）。
      setAnnotations(Array.isArray(items) ? items : []);
      setTagDict(dict);
    }).catch(() => {
      if (!cancelled) addToast("error", "做题注记加载失败，稍后重试");
    });
    return () => { cancelled = true; };
  }, [paper.id, paper.sections, addToast]);

  const upsertAnnotation = useCallback((item: QuestionAnnotation) => {
    setAnnotations((prev) => {
      const without = prev.filter((row) => row.id !== item.id);
      return [...without, item];
    });
  }, []);

  const handleCreateAnnotation = useCallback(async (input: CreateQuestionAnnotationRequest) => {
    upsertAnnotation(await createQuestionAnnotation(input));
  }, [upsertAnnotation]);

  const handlePatchAnnotation = useCallback(async (id: string, patch: QuestionAnnotationPatchRequest) => {
    upsertAnnotation(await patchQuestionAnnotation(id, patch));
  }, [upsertAnnotation]);

  const handleDeleteAnnotation = useCallback(async (id: string) => {
    await deleteQuestionAnnotation(id);
    setAnnotations((prev) => prev.filter((row) => row.id !== id));
  }, []);

  const handleSaveTagDict = useCallback(async (dict: AnnotationTagDict) => {
    setTagDict(await saveAnnotationTags(dict));
  }, []);

  const handleContextBuffered = useCallback((contextId: string) => {
    setBufferedContextIds((prev) => {
      if (prev.has(contextId)) return prev;
      const next = new Set(prev);
      next.add(contextId);
      return next;
    });
  }, []);

  const annotationsByQuestion = useMemo(() => {
    const grouped: Record<string, QuestionAnnotation[]> = {};
    for (const annotation of annotations) {
      (grouped[annotation.question_id] ??= []).push(annotation);
    }
    for (const list of Object.values(grouped)) {
      list.sort((a, b) => a.ordinal - b.ordinal
        || a.created_at.localeCompare(b.created_at)
        || a.id.localeCompare(b.id));
    }
    return grouped;
  }, [annotations]);

  const pickQuestion = (questionId: string, key: string) =>
    setPicks((prev) => ({ ...prev, [questionId]: key }));

  const stats = useMemo(() => {
    let correct = 0;
    let total = 0;
    let score = 0;
    for (const section of paper.sections) {
      if (!OBJECTIVE_TYPES.has(section.questionType)) continue;
      const per = SECTION_POINTS[section.questionType]! / section.questions.length;
      for (const q of section.questions) {
        total += 1;
        if (picks[q.id] && picks[q.id] === q.answer.choice) {
          correct += 1;
          score += per;
        }
      }
    }
    return { correct, total, score: Math.round(score * 10) / 10 };
  }, [picks, paper.sections]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0]) setActiveSection(visible[0].target.id.replace("section-", ""));
      },
      { rootMargin: "-20% 0px -65% 0px", threshold: [0, 0.25, 1] },
    );
    Object.values(sectionRefs.current).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [paper.id]);

  const scrollToSection = (key: string) => {
    document.getElementById(`section-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const scrollToQuestion = (sectionKey: string, domId: string) => {
    scrollToSection(sectionKey);
    setTimeout(() => document.getElementById(domId)?.scrollIntoView({ behavior: "smooth", block: "center" }), 250);
  };

  const renderAnalysis = (sectionKey: string, q: ExamQuestion) => {
    if (!tagDict) return null;
    return (
      <L3QuestionAnalysis
        question={q}
        annotations={annotationsByQuestion[q.id] ?? []}
        tagDict={tagDict}
        onLocate={(anchor) => setLocate({ sectionKey, ...anchor, nonce: Date.now() })}
        onCreate={handleCreateAnnotation}
        onPatch={handlePatchAnnotation}
        onDelete={handleDeleteAnnotation}
        onSaveTagDict={handleSaveTagDict}
      />
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} className="text-xs text-[var(--color-accent)]">← 返回试卷列表</button>
      </div>

      <header className="rounded-2xl bg-gradient-to-br from-[var(--color-accent-soft,var(--color-surface))] to-transparent p-5 ring-1 ring-[var(--color-border)]">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-accent)]">National Postgraduate Entrance Exam</p>
        <h2 className="mt-1 text-xl font-bold leading-snug">{paper.title}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {[paper.direction, String(paper.metadata.year ?? ""), "满分 100 分", "48 题"].filter(Boolean).map((chip) => (
            <span key={chip} className="rounded-full bg-[var(--color-surface)] px-2.5 py-1 ring-1 ring-[var(--color-border)]">{chip}</span>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setRevealAll((v) => !v)}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${revealAll ? "bg-[var(--color-ink)] text-[var(--color-surface)]" : "bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]"}`}>
            {revealAll ? "隐藏全部答案" : "显示全部答案与解析"}
          </button>
          <span className="text-xs text-[var(--color-ink-soft)]">
            客观题已答 <strong className="text-[var(--color-ink)]">{Object.keys(picks).length}/{stats.total}</strong> ·
            答对 <strong className="text-emerald-600">{stats.correct}</strong> ·
            估算 <strong>{stats.score}</strong> 分（客观题满分 60）
          </span>
        </div>
      </header>

      {/* 节导航 */}
      <nav className="sticky top-0 z-20 -mx-1 flex gap-1.5 overflow-x-auto rounded-xl bg-[var(--color-surface)] px-1 py-2 shadow-sm ring-1 ring-[var(--color-border)]" aria-label="卷面章节">
        {paper.sections.map((section, i) => {
          const active = activeSection === section.key;
          return (
            <button key={section.key} type="button" onClick={() => scrollToSection(section.key)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs transition-all ${active ? "bg-[var(--color-accent)] font-semibold text-[var(--color-accent-contrast,var(--color-surface))]" : "border border-[var(--color-border)] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)]"}`}>
              <span className="opacity-70">{i + 1}</span>
              {TYPE_SHORT[section.questionType]}
              <span className="opacity-60">{section.questions.length}题</span>
            </button>
          );
        })}
      </nav>

      <div className="space-y-6">
        {paper.sections.map((section, sectionIndex) => {
          const hasPassage = Boolean(section.source_content) && ["cloze", "reading_choice", "new_question"].includes(section.questionType);
          const isWritten = ["sentence_translation", "short_essay", "long_essay"].includes(section.questionType);
          const sectionAnnotations = section.questions
            .flatMap((q) => annotationsByQuestion[q.id] ?? []);
          const questionDisplayNo = new Map(
            section.questions.map((q, qi) => [
              q.id,
              section.questionType === "new_question" ? q.ordinal + 41 : qi + 1,
            ]),
          );
          return (
            <section
              key={section.key}
              id={`section-${section.key}`}
              ref={(el) => { sectionRefs.current[section.key] = el; }}
              className="scroll-mt-16"
            >
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-accent)] text-xs font-bold text-[var(--color-accent-contrast,var(--color-surface))]">{sectionIndex + 1}</span>
                <h3 className="text-base font-bold">{section.title}</h3>
                <span className="text-xs text-[var(--color-ink-soft)]">{SECTION_POINTS[section.questionType]} 分</span>
              </div>

              {section.missing && (
                <div className="rounded-xl border border-amber-400 bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                  该节引用的{section.missing_reason === "source" ? "材料" : "部分题目"}已删除，仅展示仍存在的内容。
                </div>
              )}

              {isWritten ? (
                <div className="space-y-3">
                  {section.questions.map((q) => (
                    <WrittenQuestion
                      key={q.id}
                      question={q}
                      kind={section.questionType === "sentence_translation" ? "translation" : "essay"}
                      placeholder={section.questionType === "sentence_translation" ? "在这里写下你的译文…" : "在这里写作文（约 100/150 词）…"}
                      analysis={renderAnalysis(section.key, q)}
                    />
                  ))}
                </div>
              ) : hasPassage ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="lg:sticky lg:top-20 lg:self-start">
                    <div className="max-h-[calc(100vh-7rem)] overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
                      {section.source_title && (
                        <p className="mb-3 border-b border-[var(--color-border)] pb-2 text-xs font-semibold text-[var(--color-ink-soft)]">
                          {section.source_title}
                        </p>
                      )}
                      <PassageBody
                        section={section}
                        content={section.source_content ?? ""}
                        revealAll={revealAll}
                        activeBlank={activeBlank}
                        annotations={sectionAnnotations}
                        locate={locate}
                        questionDisplayNo={questionDisplayNo}
                        onJumpQuestion={(questionId) => scrollToQuestion(section.key, `q-${questionId}`)}
                        onCreateAnnotation={handleCreateAnnotation}
                        onContextBuffered={handleContextBuffered}
                      />
                      {section.sourceId && (
                        <L3SourceNotesDrawer sourceId={section.sourceId} bufferedIds={bufferedContextIds} />
                      )}
                    </div>
                  </div>
                  <div className="space-y-3">
                    {section.questions.map((q, qi) => (
                      <div key={q.id} id={`q-${q.id}`}
                        onMouseEnter={() => ["cloze", "new_question"].includes(section.questionType) && setActiveBlank(section.questionType === "new_question" ? q.ordinal + 41 : qi + 1)}
                        onMouseLeave={() => setActiveBlank(null)}
                        className="scroll-mt-20">
                        <ChoiceQuestion
                          question={q}
                          index={section.questionType === "new_question" ? q.ordinal + 41 : qi + 1}
                          revealAll={revealAll}
                          picked={picks[q.id]}
                          onPick={(key) => {
                            pickQuestion(q.id, key);
                            if (section.questionType === "cloze") setActiveBlank(qi + 1);
                            if (section.questionType === "new_question") setActiveBlank(q.ordinal + 41);
                          }}
                          analysis={renderAnalysis(section.key, q)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {section.questions.map((q, qi) => (
                    <ChoiceQuestion
                      key={q.id}
                      question={q}
                      index={section.questionType === "new_question" ? q.ordinal + 41 : qi + 1}
                      revealAll={revealAll}
                      picked={picks[q.id]}
                      onPick={(key) => pickQuestion(q.id, key)}
                      analysis={renderAnalysis(section.key, q)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
