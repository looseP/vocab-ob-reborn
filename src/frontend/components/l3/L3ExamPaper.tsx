import { useMemo, useRef, useState, useEffect, useCallback, type ReactNode } from "react";
import { buildPassageSpans, enclosingSentence, groupSpansIntoParagraphs, type PassageRun } from "./examPassageSpans";
import type { ExamPaper as ExamPaperType, ExamQuestion, ExamSection } from "./examTypes";
import { L3QuestionAnalysis } from "./L3QuestionAnalysis";
import { L3SourceNotesDrawer } from "./L3SourceNotesDrawer";
import { apiFetch } from "@/frontend/api/client";
import {
  createQuestionAnnotation,
  deleteAttempt,
  deleteQuestionAnnotation,
  fetchAnnotationTags,
  fetchAttempts,
  fetchQuestionAnnotations,
  fetchSheet,
  openSheet,
  patchSheet,
  patchQuestionAnnotation,
  saveAnnotationTags,
  sealSheet,
  type AnnotationTagDict,
  type CreateQuestionAnnotationRequest,
  type L3Attempt,
  type L3Sheet,
  type QuestionAnnotation,
  type QuestionAnnotationPatchRequest,
  type SealModeValue,
} from "@/frontend/api/l3Client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import {
  addSheetAnswerMark,
  countRecheckQuestions,
  pruneSheetAnswer,
  removeSheetAnswerMark,
  type SheetAnswer,
  type SheetAnswerFlags,
} from "@/domain/l3-sheets";
import { L3AttemptHistoryModal } from "./L3AttemptHistoryModal";
import { L3QuestionAssessment } from "./L3QuestionAssessment";
import { useToast } from "@/frontend/components/ui/Toast";

/**
 * 拟真卷面（ADR-0030 V1 展示面）：左文右题 + 草稿作答 + 解析模式 + 翻译/作文书写区。
 *
 * 草稿作答模型（2026-09-17 修订）：选中仅为"已选"草稿态——不判对错、不露解析、
 * 随时可改选（只在 readOnly 定格后或显式揭示后锁定）；判定与解析仅在
 * 「显示全部答案与解析」（revealAll）揭示后呈现。
 * 批次一（2026-09-16）：文栏三通道（空位角标 / 官方 evidence 仅解析模式 /
 * 用户注记锚点全程）、划词分叉（建原文分析条目 / 圈词入笔记）、题卡原文分析子区。
 * 批次二（2026-09-17）：题纸栏（进卷自动开纸 / 防抖 800ms 逐题 merge 保存）、
 * 定格三档 modal（ADR-0034 §5）、定格后只读；划词注记挂题纸为草稿（stage='draft'）。
 */

// 题型从独立类型文件 re-export，保持 L3PapersPage 等既有导入路径不变。
export type { ExamPaper, ExamQuestion, ExamSection } from "./examTypes";

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

/** 定格档位文案（ADR-0034 §5 三档：完整记录 / 增量条目 / 只留总结）。 */
const SEAL_MODE_OPTIONS: Array<{ value: SealModeValue; label: string; hint: string }> = [
  { value: "full", label: "完整记录", hint: "记录全部已作答题目；题纸保留，可回看逐题明细" },
  { value: "incremental", label: "增量条目", hint: "不保留作答记录，只把草稿注记提交待检验" },
  { value: "summary", label: "只留总结", hint: "只保留一条本次刷题总结，作答与草稿注记不留存" },
];

function formatSavedAt(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
  mode: "menu" | "annotate" | "mark" | "capture";
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
  passageMarks,
  onAddPassageMark,
  onRemovePassageMark,
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
  /** v2 §4.6：本题组文章的划重点标记（含所属题号，取消时反查；纯底色通道）。 */
  passageMarks?: ReadonlyArray<{ questionId: string; start: number; end: number }>;
  onAddPassageMark?: (questionId: string, anchor: { start: number; end: number }) => void;
  onRemovePassageMark?: (anchor: { start: number; end: number }) => void;
}) {
  const passageRef = useRef<HTMLDivElement>(null);
  const [capture, setCapture] = useState<CaptureState | null>(null);
  /** 当前划词区间是否已是 passage 标记（v2 §4.6：同区间显示「取消标记」）。 */
  const captureMarked = capture != null
    && (passageMarks ?? []).some((mark) => mark.start === capture.start && mark.end === capture.end);
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
      marks: (passageMarks ?? []).map((mark) => ({ start: mark.start, end: mark.end })),
      showEvidence: revealAll,
    }),
    [content, evidence, annotations, passageMarks, revealAll],
  );

  // 按原文换行分段：每段独立 <p> 带段距，空行占位；run 携带全局偏移，拆段不影响选区坐标。
  const paragraphs = useMemo(() => groupSpansIntoParagraphs(spans, content), [spans, content]);

  // 题卡定位钮 → 滚动到锚点并脉冲（nonce 保证重复点击同一锚点也重播动画）。
  // 跨段标注会拆成多个 mark 片段，按 data-ann-start（锚点全局起点）取第一个片段即可。
  useEffect(() => {
    if (!locate || locate.sectionKey !== section.key) return;
    const target = passageRef.current?.querySelector<HTMLElement>(
      `[data-ann-start="${locate.start}"]`,
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
    // getBoundingClientRect 可选调用：jsdom 等受限环境无此方法（真实浏览器恒在）。
    const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect?.();
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
        {paragraphs.map((paragraph, paragraphIndex) => {
          if (paragraph.blank) {
            return <p key={`p-${paragraphIndex}`} aria-hidden className="min-h-[0.75em]" />;
          }
          return (
            <p key={`p-${paragraphIndex}`} className="mb-3 last:mb-0">
              {paragraph.runs.map((run: PassageRun) => {
                if (run.kind === "blank") {
                  const isActiveBlank = activeBlank === run.blankNo;
                  return (
                    <button
                      key={`${run.start}-${run.end}`}
                      type="button"
                      data-blank-no={run.blankNo}
                      onClick={() => onJumpQuestion(section.questions.find((q) =>
                        section.questionType === "new_question" ? q.ordinal + 41 === run.blankNo : questionDisplayNo.get(q.id) === run.blankNo,
                      )?.id ?? "")}
                      className={`mx-0.5 inline-flex h-5 min-w-5 select-none items-center justify-center rounded px-1 text-[11px] font-semibold align-middle transition-all ${
                        isActiveBlank
                          ? "scale-110 bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]"
                          : "bg-[var(--color-accent-soft,var(--color-surface))] text-[var(--color-accent)] ring-1 ring-[var(--color-border)] hover:ring-[var(--color-accent)]"
                      }`}
                      title={`跳到第 ${run.blankNo} 空`}
                    >
                      {run.blankNo}
                    </button>
                  );
                }
                if (run.kind === "evidence") {
                  return (
                    <mark
                      key={`${run.start}-${run.end}`}
                      data-content-off={run.start}
                      data-evidence
                      className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-400/30"
                    >
                      {run.text}
                    </mark>
                  );
                }
                if (run.kind === "mark") {
                  // v2 §4.6 划词铁律：纯底色高亮——无角标、无徽标、无 cursor、无 onClick。
                  return (
                    <mark
                      key={`${run.start}-${run.end}`}
                      data-content-off={run.start}
                      data-passage-mark
                      className="rounded-sm bg-sky-100 px-0.5 text-inherit dark:bg-sky-900/40"
                    >
                      {run.text}
                    </mark>
                  );
                }
                if (run.kind === "annotation") {
                  const annotationId = run.annotationId!;
                  const owner = annotations.find((a) => a.id === annotationId);
                  const locateStart = locate?.start;
                  const locateEnd = locate?.end;
                  const isPulsing = pulseNonce > 0 && owner
                    && locateStart != null && locateEnd != null
                    && locateStart <= run.start && run.end <= locateEnd;
                  const showBadge = !renderedBadges.has(annotationId);
                  if (showBadge) renderedBadges.add(annotationId);
                  return (
                    <span key={`${run.start}-${run.end}`}>
                      <mark
                        data-content-off={run.start}
                        data-ann-id={annotationId}
                        data-ann-start={owner?.anchor_start ?? undefined}
                        data-ann-end={owner?.anchor_end ?? undefined}
                        className={`rounded-sm border-b-2 border-[var(--color-accent)] px-0.5 text-inherit ${
                          isPulsing ? "[animation:exam-locate-pulse_1.2s_ease-out] rounded" : ""
                        }`}
                      >
                        {run.text}
                      </mark>
                      {showBadge && (
                        <button
                          type="button"
                          data-ann-jump={annotationId}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (owner) onJumpQuestion(owner.question_id);
                          }}
                          title="查看该题的原文分析"
                          className="ml-0.5 inline-flex h-4 min-w-4 select-none items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[9px] font-bold leading-none text-[var(--color-accent-contrast,var(--color-surface))] align-middle"
                        >
                          {owner ? (questionDisplayNo.get(owner.question_id) ?? "•") : "•"}
                        </button>
                      )}
                    </span>
                  );
                }
                return (
                  <span key={`${run.start}-${run.end}`} data-content-off={run.start}>
                    {run.text}
                  </span>
                );
              })}
            </p>
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
              {captureMarked ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    onRemovePassageMark?.({ start: capture.start, end: capture.end });
                    addToast("success", "已取消标记");
                    clearSelection();
                  }}
                  className="rounded-md border border-sky-400 bg-sky-50 px-2 py-1.5 text-xs text-sky-800 hover:border-sky-500 dark:bg-sky-950/40 dark:text-sky-200"
                >
                  取消标记
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!onAddPassageMark || busy}
                  onClick={() => setCapture((c) => (c ? { ...c, mode: "mark" } : c))}
                  className="rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-ink)] hover:border-sky-400 disabled:opacity-50"
                >
                  标记重点
                </button>
              )}
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
          {capture.mode === "mark" && (
            <div className="max-h-48 space-y-1 overflow-y-auto">
              <p className="text-[10px] text-[var(--color-ink-soft)]">标记关联哪道题？（随该题保存，导出可见）</p>
              {section.questions.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    onAddPassageMark?.(q.id, { start: capture.start, end: capture.end });
                    addToast("success", "已标记重点");
                    clearSelection();
                  }}
                  className="block w-full truncate rounded-md px-2 py-1 text-left text-[11px] hover:bg-sky-50 disabled:opacity-50 dark:hover:bg-sky-950/40"
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
  optionKey, text, state, selected = false, onSelect, readOnly = false, doubt = false, onToggleDoubt,
}: {
  optionKey: string;
  text: string;
  state: "idle" | "correct" | "wrong" | "muted";
  /** 草稿态选中（未揭示答案前：仅示选中、不判对错，可随时改选）。 */
  selected?: boolean;
  onSelect: () => void;
  readOnly?: boolean;
  /** v2 §10：选项级存疑（行尾悬停钮 + 行内小字；随定格物化进 self_assessment）。 */
  doubt?: boolean;
  onToggleDoubt?: (key: string) => void;
}) {
  const styles = selected
    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft,var(--color-surface))]"
    : {
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
    <div className="group flex items-stretch gap-1">
      <button type="button" onClick={onSelect} disabled={state !== "idle" || readOnly}
        data-option-key={optionKey}
        data-selected={selected ? "true" : undefined}
        className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-all ${styles}`}>
        <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${badge}`}>
          {state === "correct" ? "✓" : state === "wrong" ? "✕" : optionKey}
        </span>
        <span className="leading-relaxed">{text}</span>
        {doubt && <span className="ml-auto shrink-0 whitespace-nowrap text-[10px] font-medium text-amber-600 dark:text-amber-400">存疑</span>}
      </button>
      {!readOnly && onToggleDoubt && (
        <span
          data-doubt-toggle={optionKey}
          title={doubt ? "取消存疑" : "标记存疑（定格时随作答一起记录）"}
          onClick={(event) => { event.stopPropagation(); onToggleDoubt(optionKey); }}
          className={`flex w-6 shrink-0 cursor-pointer items-center justify-center rounded-lg border text-[11px] transition-all ${
            doubt
              ? "border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
              : "border-[var(--color-border)] text-[var(--color-ink-soft)] opacity-0 group-hover:opacity-100 hover:border-amber-400 hover:text-amber-600"
          }`}>
          ?
        </span>
      )}
    </div>
  );
}

function ChoiceQuestion({
  question,
  index,
  revealAll,
  picked,
  onPick,
  analysis,
  readOnly = false,
  cleared = false,
  flags,
  onToggleFlag,
  optionFlags,
  onToggleOptionDoubt,
  stemMarks,
  onToggleStemMark,
}: {
  question: ExamQuestion;
  index: number;
  revealAll: boolean;
  picked?: string;
  onPick: (key: string) => void;
  analysis?: ReactNode;
  readOnly?: boolean;
  /** 结果页占位：该题作答记录已清理（内容不展示，尊重删除意图）。 */
  cleared?: boolean;
  /** v2 §10：题级旗标（待复查 / 存疑）与选项级存疑（定格物化进 self_assessment）。 */
  flags?: SheetAnswerFlags;
  onToggleFlag?: (flag: "doubt" | "recheck") => void;
  optionFlags?: string[];
  onToggleOptionDoubt?: (key: string) => void;
  /** v2 §4.6：题干划重点（scope='stem'，题号天然已知无需选择器）。 */
  stemMarks?: ReadonlyArray<{ start: number; end: number }>;
  onToggleStemMark?: (anchor: { start: number; end: number }) => void;
}) {
  const correct = question.answer.choice;

  // v2 §4.6：题干划词（scope='stem'）——浮动条直接标记/取消，不走题号选择器。
  const stemRef = useRef<HTMLParagraphElement>(null);
  const [stemCapture, setStemCapture] = useState<{ x: number; y: number; start: number; end: number; excerpt: string } | null>(null);
  useEffect(() => {
    if (!stemCapture) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest("[data-exam-capture-bar]")) return;
      setStemCapture(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setStemCapture(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [stemCapture !== null]);

  const handleStemMouseUp = useCallback(() => {
    if (readOnly || !onToggleStemMark) return;
    const container = stemRef.current;
    if (!container) return;
    const offsets = selectionToContentOffsets(container);
    if (!offsets) {
      setStemCapture(null);
      return;
    }
    const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect?.();
    setStemCapture({
      x: rect ? rect.left + rect.width / 2 : 120,
      y: rect ? rect.top : 120,
      start: offsets.start,
      end: offsets.end,
      excerpt: question.stem.slice(offsets.start, offsets.end),
    });
  }, [question.stem, readOnly, onToggleStemMark]);

  const stemMarked = stemCapture != null
    && (stemMarks ?? []).some((mark) => mark.start === stemCapture.start && mark.end === stemCapture.end);
  const stemSpans = useMemo(
    () => buildPassageSpans(question.stem, { marks: stemMarks ?? [], parseBlanks: false }),
    [question.stem, stemMarks],
  );

  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3.5 transition-shadow hover:shadow-sm">
      <div className="mb-2.5 flex items-start gap-2">
        <span className="relative mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft,var(--color-surface))] text-xs font-bold text-[var(--color-accent)]">
          {index}
          {(flags?.doubt || flags?.recheck) && (
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
          )}
        </span>
        <p ref={stemRef} onMouseUp={handleStemMouseUp} className="min-w-0 flex-1 text-sm font-medium leading-relaxed">
          {stemSpans.map((span) => span.kind === "mark" ? (
            <mark
              key={`${span.start}-${span.end}`}
              data-content-off={span.start}
              data-stem-mark
              className="rounded-sm bg-sky-100 px-0.5 text-inherit dark:bg-sky-900/40"
            >
              {question.stem.slice(span.start, span.end)}
            </mark>
          ) : (
            <span key={`${span.start}-${span.end}`} data-content-off={span.start}>
              {question.stem.slice(span.start, span.end)}
            </span>
          ))}
        </p>
        {!readOnly && onToggleFlag && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <button type="button" onClick={(event) => { event.stopPropagation(); onToggleFlag("recheck"); }}
              className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${flags?.recheck ? "border-sky-500 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300" : "border-[var(--color-border)] text-[var(--color-ink-soft)] hover:border-sky-400 hover:text-sky-600"}`}>
              待复查
            </button>
            <button type="button" onClick={(event) => { event.stopPropagation(); onToggleFlag("doubt"); }}
              className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors ${flags?.doubt ? "border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300" : "border-[var(--color-border)] text-[var(--color-ink-soft)] hover:border-amber-400 hover:text-amber-600"}`}>
              存疑
            </button>
          </span>
        )}
      </div>
      {stemCapture && onToggleStemMark && !readOnly && (
        <div
          data-exam-capture-bar
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            position: "fixed",
            left: Math.min(Math.max(stemCapture.x, 140), window.innerWidth - 140),
            top: Math.max(stemCapture.y - 8, 72),
            transform: "translateX(-50%) translateY(-100%)",
          }}
          className="z-50 w-64 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-xl"
        >
          <p className="mb-2 line-clamp-2 rounded-md bg-[var(--color-accent-soft,var(--color-surface))] p-1.5 text-[11px] italic text-[var(--color-ink-soft)]">
            「{stemCapture.excerpt}」
          </p>
          <button
            type="button"
            onClick={() => {
              onToggleStemMark({ start: stemCapture.start, end: stemCapture.end });
              setStemCapture(null);
              window.getSelection()?.removeAllRanges();
            }}
            className={stemMarked
              ? "w-full rounded-md border border-sky-400 bg-sky-50 px-2 py-1.5 text-xs text-sky-800 hover:border-sky-500 dark:bg-sky-950/40 dark:text-sky-200"
              : "w-full rounded-md bg-[var(--color-accent)] px-2 py-1.5 text-xs font-semibold text-[var(--color-accent-contrast,var(--color-surface))]"}
          >
            {stemMarked ? "取消标记" : "标记重点"}
          </button>
        </div>
      )}
      {cleared && (
        <p className="mb-2 inline-block rounded-md bg-[var(--color-surface)] px-2 py-1 text-[11px] text-[var(--color-ink-soft)] ring-1 ring-[var(--color-border)]">
          作答记录已清理
        </p>
      )}
      <div className="grid gap-1.5">
        {question.options.map((opt) => {
          // 判定仅在显式揭示后（revealAll）：草稿作答不判对错、不锁死（可改选）。
          let state: "idle" | "correct" | "wrong" | "muted" = "idle";
          if (revealAll && correct) {
            if (opt.key === correct) state = "correct";
            else if (opt.key === picked) state = "wrong";
            else state = "muted";
          }
          return (
            <OptionRow
              key={opt.key}
              optionKey={opt.key}
              text={opt.text}
              state={state}
              selected={!revealAll && picked === opt.key}
              readOnly={readOnly}
              doubt={optionFlags?.includes(opt.key) ?? false}
              onToggleDoubt={onToggleOptionDoubt}
              onSelect={() => onPick(opt.key)}
            />
          );
        })}
      </div>
      {revealAll && question.explanation && (
        <details className="group mt-2.5 rounded-lg bg-[var(--color-surface)] p-2.5 text-xs leading-relaxed text-[var(--color-ink-soft)] ring-1 ring-[var(--color-border)]" open>
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
  revealAll = false,
  readOnly = false,
  cleared = false,
}: {
  question: ExamQuestion;
  kind: "translation" | "essay";
  placeholder: string;
  analysis?: ReactNode;
  /** 参考译文/范文仅在显式揭示后可见（与客观题同一草稿作答模型）。 */
  revealAll?: boolean;
  readOnly?: boolean;
  cleared?: boolean;
}) {
  const reference = kind === "translation" ? question.answer.text : question.answer.sample;
  return (
    <div className="space-y-3">
      <div className="whitespace-pre-wrap rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm leading-7">
        {question.stem}
      </div>
      {cleared && (
        <p className="inline-block rounded-md bg-[var(--color-surface)] px-2 py-1 text-[11px] text-[var(--color-ink-soft)] ring-1 ring-[var(--color-border)]">
          作答记录已清理
        </p>
      )}
      <textarea
        rows={kind === "translation" ? 7 : 12}
        placeholder={placeholder}
        disabled={readOnly}
        className="w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm leading-7 [background-image:repeating-linear-gradient(transparent,transparent_27px,var(--color-border)_28px)] [background-position:0_11px] focus:border-[var(--color-accent)] focus:outline-none"
      />
      {revealAll && reference && (
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

export function L3ExamPaper({ paper, onBack, fileVenue }: {
  paper: ExamPaperType;
  onBack: () => void;
  /** 批次二补齐：题型空间（file venue）复用本组件作单文件做题表面——
   *  题纸作用域切 file:<sourceId>:<questionType>，题纸栏/头部文案按文件语义呈现。 */
  fileVenue?: { sourceId: string; questionType: ExamSection["questionType"] };
}) {
  const { addToast } = useToast();
  const [revealAll, setRevealAll] = useState(false);
  // v2：答案本地真源 = 完整 answer 对象（choice/flags/optionFlags/marks，ADR-0034
  // 增补条 8）；picks（choice 投影）由 useMemo 派生，下游渲染与统计契约不变。
  const [answers, setAnswers] = useState<Record<string, SheetAnswer>>({});
  const [activeBlank, setActiveBlank] = useState<number | null>(null);
  const [activeSection, setActiveSection] = useState(paper.sections[0]?.key ?? "");
  const [locate, setLocate] = useState<LocateTarget | null>(null);
  const [annotations, setAnnotations] = useState<QuestionAnnotation[]>([]);
  const [tagDict, setTagDict] = useState<AnnotationTagDict | null>(null);
  /** 本会话划词「圈词入笔记」新建的 context id（抽屉打缓冲徽标）。 */
  const [bufferedContextIds, setBufferedContextIds] = useState<ReadonlySet<string>>(new Set());
  // ── 批次二：题纸状态机与防抖保存 ──
  const [sheet, setSheet] = useState<L3Sheet | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [sealOpen, setSealOpen] = useState(false);
  const [sealMode, setSealMode] = useState<SealModeValue>("full");
  const [sealSummary, setSealSummary] = useState("");
  const [sealBusy, setSealBusy] = useState(false);
  /** 「仍要定格」二次确认：第一次 409 后服务端给出的未答计数。 */
  const [sealUnanswered, setSealUnanswered] = useState<number | null>(null);
  /** v2 §10：定格 modal 待复查计数（本地实时口径 + 服务端 409 复述）。 */
  const [sealRecheck, setSealRecheck] = useState(0);
  // ── 批次二：作答历史（徽标/modal/派生渲染）──
  const [attempts, setAttempts] = useState<L3Attempt[]>([]);
  const [historyQuestionId, setHistoryQuestionId] = useState<string | null>(null);
  /** 结果页占位：已软删条目的题（内容不展示，统计口径不变）。 */
  const [clearedQuestions, setClearedQuestions] = useState<ReadonlySet<string>>(new Set());
  /** 定格档案统计（交卷时口径：total 不因后续删除变化）。 */
  const [sheetStats, setSheetStats] = useState<{ total: number; cleared: number } | null>(null);
  const pendingAnswers = useRef<Record<string, unknown>>({});
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sheetRef = useRef<L3Sheet | null>(null);
  const answersRef = useRef<Record<string, SheetAnswer>>({});
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  // 进卷自动开纸（幂等）：paper venue 作用域键 paper:<id>，冲突复用既有 draft 行。
  // draft 行携带服务端 answers → 本地 picks（重进页面不丢已保存作答）。
  useEffect(() => {
    let cancelled = false;
    openSheet(fileVenue
      ? { scope: "file", sourceId: fileVenue.sourceId, questionType: fileVenue.questionType }
      : { scope: "paper", paperId: paper.id })
      .then((row) => {
        if (cancelled) return;
        setSheet(row);
        if (row.status === "draft") {
          const restored: Record<string, SheetAnswer> = {};
          for (const [questionId, value] of Object.entries(row.answers ?? {})) {
            if (value && typeof value === "object" && !Array.isArray(value)) {
              restored[questionId] = value as SheetAnswer;
            }
          }
          if (Object.keys(restored).length > 0) {
            const merged = { ...restored, ...answersRef.current };
            answersRef.current = merged;
            setAnswers(merged);
          }
        }
      })
      .catch(() => {
        if (!cancelled) addToast("error", "题纸打开失败，本次作答不会保存");
      });
    return () => { cancelled = true; };
  }, [paper.id, fileVenue?.sourceId, fileVenue?.questionType, addToast]);

  useEffect(() => { sheetRef.current = sheet; }, [sheet]);
  useEffect(() => { answersRef.current = answers; }, [answers]);

  /** choice 投影（下游渲染与统计沿用批次二契约，不感知完整对象形态）。 */
  const picks = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [questionId, answer] of Object.entries(answers)) {
      if (typeof answer.choice === "string") map[questionId] = answer.choice;
    }
    return map;
  }, [answers]);

  // 批次二：批量拉全部题的作答历史（题卡徽标数据源；跨 venue 同显）。
  useEffect(() => {
    let cancelled = false;
    const allQuestionIds = [...new Set(paper.sections.flatMap((section) => section.questionIds))];
    if (allQuestionIds.length === 0) return;
    fetchAttempts(allQuestionIds)
      .then((rows) => { if (!cancelled) setAttempts(Array.isArray(rows) ? rows : []); })
      .catch(() => { /* 徽标加载失败静默降级，不打扰做题 */ });
    return () => { cancelled = true; };
  }, [paper.id, paper.sections]);

  /** 防抖 800ms 逐题 merge：批量 PATCH 到题纸（失败回填待重试）。 */
  const flushAnswers = useCallback(async () => {
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    const batch = pendingAnswers.current;
    const current = sheetRef.current;
    if (!current || current.status !== "draft" || Object.keys(batch).length === 0) return;
    pendingAnswers.current = {};
    setSaveState("saving");
    try {
      const updated = await patchSheet(current.id, batch);
      sheetRef.current = updated;
      setSheet(updated);
      setSaveState("idle");
      setLastSavedAt(new Date().toISOString());
    } catch {
      pendingAnswers.current = { ...batch, ...pendingAnswers.current };
      setSaveState("error");
    }
  }, []);

  const scheduleSave = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => { void flushAnswers(); }, 800);
  }, [flushAnswers]);

  /**
   * v2 草稿答案状态机：完整对象浅 merge → prune（空键清理）→ 整题入队 pending
   * → 防抖 PATCH（服务端为题目键级整体替换，必须发送合并后的完整对象）。
   * 定格后（sheet 非 draft）静默忽略——只读由渲染层与守卫双重收口。
   */
  const commitAnswer = useCallback((questionId: string, patch: Partial<SheetAnswer>) => {
    if (sheetRef.current && sheetRef.current.status !== "draft") return;
    const merged: SheetAnswer = { ...(answersRef.current[questionId] ?? {}), ...patch };
    const next = pruneSheetAnswer(merged);
    const updated = { ...answersRef.current };
    if (next === null) {
      delete updated[questionId];
      pendingAnswers.current = { ...pendingAnswers.current, [questionId]: null };
    } else {
      updated[questionId] = next;
      pendingAnswers.current = { ...pendingAnswers.current, [questionId]: next };
    }
    answersRef.current = updated;
    setAnswers(updated);
    scheduleSave();
  }, [scheduleSave]);

  /** v2 §10：题级旗标切换（待复查=流程状态 / 存疑=认知状态；取消即删键）。 */
  const toggleFlag = useCallback((questionId: string, flag: "doubt" | "recheck") => {
    const current = answersRef.current[questionId]?.flags ?? {};
    const next: SheetAnswerFlags = { ...current };
    if (next[flag]) delete next[flag];
    else next[flag] = true;
    commitAnswer(questionId, { flags: next });
  }, [commitAnswer]);

  /** v2 §10：选项级存疑切换（选项行尾悬停钮）。 */
  const toggleOptionDoubt = useCallback((questionId: string, optionKey: string) => {
    const current = answersRef.current[questionId]?.optionFlags ?? [];
    const next = current.includes(optionKey)
      ? current.filter((key) => key !== optionKey)
      : [...current, optionKey];
    commitAnswer(questionId, { optionFlags: next });
  }, [commitAnswer]);

  /** v2 §4.6：文栏划重点（挂题号选择器；同区间去重由 addSheetAnswerMark 保证幂等）。 */
  const addPassageMark = useCallback((questionId: string, anchor: { start: number; end: number }) => {
    const marks = answersRef.current[questionId]?.marks ?? [];
    commitAnswer(questionId, {
      marks: addSheetAnswerMark(marks, { scope: "passage", start: anchor.start, end: anchor.end }),
    });
  }, [commitAnswer]);

  /** v2 §4.6：取消文栏标记（同区间可能被多题各标一次——全部清除）。 */
  const removePassageMark = useCallback((anchor: { start: number; end: number }) => {
    for (const [questionId, answer] of Object.entries(answersRef.current)) {
      const marks = answer.marks ?? [];
      const next = marks.filter(
        (mark) => !(mark.scope === "passage" && mark.start === anchor.start && mark.end === anchor.end),
      );
      if (next.length !== marks.length) commitAnswer(questionId, { marks: next });
    }
  }, [commitAnswer]);

  /** v2 §4.6：题干划重点（scope='stem'，题号天然已知——toggle 语义）。 */
  const toggleStemMark = useCallback((questionId: string, anchor: { start: number; end: number }) => {
    const marks = answersRef.current[questionId]?.marks ?? [];
    const exists = marks.some(
      (mark) => mark.scope === "stem" && mark.start === anchor.start && mark.end === anchor.end,
    );
    const next = exists
      ? removeSheetAnswerMark(marks, { scope: "stem", start: anchor.start, end: anchor.end })
      : addSheetAnswerMark(marks, { scope: "stem", start: anchor.start, end: anchor.end });
    commitAnswer(questionId, { marks: next });
  }, [commitAnswer]);

  /** sealed 派生（批次二）：picks 以 attempts 为准重算 + 结果页占位集合 + 本地历史并入。 */
  const deriveFromSheet = useCallback(async (sheetId: string) => {
    try {
      const { attempts: derived } = await fetchSheet(sheetId);
      const restored: Record<string, SheetAnswer> = {};
      const cleared = new Set<string>();
      for (const row of derived) {
        if (row.status === "deleted") { cleared.add(row.question_id); continue; }
        const answer = row.answer as { choice?: unknown } | null;
        const assessment = row.self_assessment as {
          flags?: SheetAnswerFlags;
          optionFlags?: string[];
          marks?: SheetAnswer["marks"];
        } | null;
        const next: SheetAnswer = {};
        if (answer && typeof answer.choice === "string") next.choice = answer.choice;
        if (assessment?.flags) next.flags = assessment.flags;
        if (Array.isArray(assessment?.optionFlags) && assessment.optionFlags.length > 0) {
          next.optionFlags = assessment.optionFlags;
        }
        if (Array.isArray(assessment?.marks) && assessment.marks.length > 0) next.marks = assessment.marks;
        if (Object.keys(next).length > 0) restored[row.question_id] = next;
      }
      answersRef.current = restored;
      setAnswers(restored);
      setClearedQuestions(cleared);
      setSheetStats({ total: derived.length, cleared: cleared.size });
      setAttempts((prev) => {
        const byId = new Map(prev.map((row) => [row.id, row]));
        for (const row of derived) byId.set(row.id, row);
        return [...byId.values()];
      });
    } catch {
      addToast("error", "定格已保存，但结果明细加载失败，稍后可重试");
    }
  }, [addToast]);

  // 卸载时把防抖窗口内未发送的作答立即送存（尽力而为，不阻塞卸载）。
  useEffect(() => () => {
    if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; }
    const batch = pendingAnswers.current;
    const current = sheetRef.current;
    if (current && current.status === "draft" && Object.keys(batch).length > 0) {
      pendingAnswers.current = {};
      void patchSheet(current.id, batch).catch(() => {});
    }
  }, []);

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
    // 做题中（draft 题纸）：划词注记挂当前题纸为草稿注记；题纸未就绪/已定格回落正式注记。
    const current = sheetRef.current;
    const sheetId = current && current.status === "draft" ? current.id : undefined;
    upsertAnnotation(await createQuestionAnnotation({ ...input, ...(sheetId ? { sheetId } : {}) }));
  }, [upsertAnnotation]);

  const openSealModal = useCallback(() => {
    setSealUnanswered(null);
    // v2 §10：待复查计数（本地实时口径；服务端 409/定格响应同源复核）。
    const scopeIds = paper.sections.flatMap((section) => section.questionIds);
    setSealRecheck(countRecheckQuestions(scopeIds, answersRef.current));
    setSealOpen(true);
  }, [paper.sections]);

  const submitSeal = useCallback(async (acknowledgeUnanswered: boolean) => {
    const current = sheetRef.current;
    if (!current) return;
    setSealBusy(true);
    try {
      await flushAnswers();
      const result = await sealSheet(current.id, {
        mode: sealMode,
        ...(sealMode === "summary" ? { summary: sealSummary.trim() } : {}),
        acknowledgeUnanswered,
      });
      sheetRef.current = result.sheet;
      setSheet(result.sheet);
      setSealOpen(false);
      setSealUnanswered(null);
      addToast("success", result.materializedCount > 0
        ? `已定格：${result.materializedCount} 条作答已入库，可打开「显示全部答案与解析」进入解析模式`
        : "已定格，可打开「显示全部答案与解析」进入解析模式");
      void deriveFromSheet(result.sheet.id);
    } catch (error) {
      if (error instanceof BrowserApiError && error.status === 409) {
        const details = error.details as { unansweredCount?: number; recheckCount?: number } | null;
        if (typeof details?.unansweredCount === "number") {
          setSealUnanswered(details.unansweredCount);
          if (typeof details.recheckCount === "number") setSealRecheck(details.recheckCount);
          return;
        }
      }
      addToast("error", "定格失败，请稍后重试");
    } finally {
      setSealBusy(false);
    }
  }, [sealMode, sealSummary, flushAnswers, deriveFromSheet, addToast]);

  /** 单条历史软删（批次二）：只改历史视图与占位，不动成绩统计口径。 */
  const handleDeleteAttempt = useCallback(async (attemptId: string) => {
    const target = attempts.find((row) => row.id === attemptId);
    try {
      await deleteAttempt(attemptId);
    } catch {
      addToast("error", "删除失败，请稍后重试");
      return;
    }
    setAttempts((prev) => prev.filter((row) => row.id !== attemptId));
    const current = sheetRef.current;
    if (target && current && target.sheet_id === current.id) {
      setClearedQuestions((prev) => new Set(prev).add(target.question_id));
      setSheetStats((prev) => (prev ? { ...prev, cleared: prev.cleared + 1 } : prev));
    }
    addToast("success", "已删除该条作答记录");
  }, [attempts, addToast]);

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

  const attemptsByQuestion = useMemo(() => {
    const grouped: Record<string, L3Attempt[]> = {};
    for (const row of attempts) {
      (grouped[row.question_id] ??= []).push(row);
    }
    for (const list of Object.values(grouped)) {
      list.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    }
    return grouped;
  }, [attempts]);

  /** v2 §4.6：全文栏 passage 标记汇总（含所属题号——浮动条取消反查；渲染只取区间）。 */
  const passageMarks = useMemo(() => {
    const rows: Array<{ questionId: string; start: number; end: number }> = [];
    for (const [questionId, answer] of Object.entries(answers)) {
      for (const mark of answer.marks ?? []) {
        if (mark.scope === "passage") rows.push({ questionId, start: mark.start, end: mark.end });
      }
    }
    return rows;
  }, [answers]);

  const allQuestionsById = useMemo(() => {
    const map = new Map<string, ExamQuestion>();
    for (const section of paper.sections) for (const question of section.questions) map.set(question.id, question);
    return map;
  }, [paper.sections]);

  const historyQuestion = historyQuestionId ? allQuestionsById.get(historyQuestionId) ?? null : null;

  const historyDeepLink = useMemo(() => {
    // file venue：当前页已在题型空间，跳转链接自我指向，无需展示。
    if (fileVenue || !historyQuestionId) return null;
    const section = paper.sections.find((entry) => entry.questionIds.includes(historyQuestionId));
    const fileKey = section?.sourceId ?? section?.fileKey ?? null;
    if (!section || !fileKey) return null;
    return { venue: section.questionType, fileKey };
  }, [fileVenue, historyQuestionId, paper.sections]);

  const pickQuestion = (questionId: string, key: string) => {
    commitAnswer(questionId, { choice: key });
  };

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

  /** file venue：头部题数 chip（paper 模式的"48 题"为卷级静态文案）。 */
  const totalQuestionCount = useMemo(
    () => paper.sections.reduce((sum, section) => sum + section.questions.length, 0),
    [paper.sections],
  );

  /** 定格后卷面只读（作答输入禁用；选择仍显示用于回看）。 */
  const readOnly = sheet !== null && sheet.status !== "draft";

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

  const renderAnalysis = (sectionKey: string, q: ExamQuestion) => (
    <>
      {tagDict && (
        <L3QuestionAnalysis
          question={q}
          annotations={annotationsByQuestion[q.id] ?? []}
          tagDict={tagDict}
          onLocate={(anchor) => setLocate({ sectionKey, ...anchor, nonce: Date.now() })}
          onCreate={handleCreateAnnotation}
          onPatch={handlePatchAnnotation}
          onDelete={handleDeleteAnnotation}
          onSaveTagDict={handleSaveTagDict}
          attempts={(attemptsByQuestion[q.id] ?? []).filter((row) => row.status === "active")}
          onOpenHistory={() => setHistoryQuestionId(q.id)}
        />
      )}
      {/* 批次二增补：评析子区（v2 §11 挂题不挂题纸；与「原文分析」并列）。 */}
      <L3QuestionAssessment questionId={q.id} />
    </>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} className="text-xs text-[var(--color-accent)]">{fileVenue ? "← 返回题型空间" : "← 返回试卷列表"}</button>
      </div>

      {sheet && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-[var(--color-surface)] px-3.5 py-2 text-xs ring-1 ring-[var(--color-border)]">
          <span className="font-semibold">题纸</span>
          <span className="text-[var(--color-ink-soft)]">{fileVenue ? "文件" : "整卷"} · {paper.title}</span>
          <span className="ml-auto">
            {sheet.status === "draft" ? (
              <span className="rounded-full bg-[var(--color-accent-soft,var(--color-surface))] px-2 py-0.5 font-medium text-[var(--color-accent)]">
                {saveState === "saving"
                  ? "草稿 · 保存中…"
                  : saveState === "error"
                    ? "草稿 · 保存失败，将自动重试"
                    : lastSavedAt ? `草稿 · 已保存 ${formatSavedAt(lastSavedAt)}` : "草稿"}
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <span className="rounded-full bg-[var(--color-ink)] px-2 py-0.5 font-medium text-[var(--color-surface)]">
                  {sheet.status === "sealed" ? "已定格" : "已弃档"}
                </span>
                {sheetStats && sheetStats.total > 0 && (
                  <span className="text-[var(--color-ink-soft)]">
                    已录 {sheetStats.total} 条作答{sheetStats.cleared > 0 ? `（含 ${sheetStats.cleared} 条已清理）` : ""}
                  </span>
                )}
              </span>
            )}
          </span>
        </div>
      )}

      <header className="rounded-2xl bg-gradient-to-br from-[var(--color-accent-soft,var(--color-surface))] to-transparent p-5 ring-1 ring-[var(--color-border)]">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--color-accent)]">{fileVenue ? `题型空间 · ${TYPE_SHORT[fileVenue.questionType]}` : "National Postgraduate Entrance Exam"}</p>
        <h2 className="mt-1 text-xl font-bold leading-snug">{paper.title}</h2>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {(fileVenue
            ? [TYPE_SHORT[fileVenue.questionType], `共 ${totalQuestionCount} 题`]
            : [paper.direction, String(paper.metadata.year ?? ""), "满分 100 分", "48 题"]
          ).filter(Boolean).map((chip) => (
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
            答对 <strong className="text-emerald-600">{stats.correct}</strong>
            {fileVenue ? null : <> · 估算 <strong>{stats.score}</strong> 分（客观题满分 60）</>}
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
                      revealAll={revealAll}
                      readOnly={readOnly}
                      cleared={clearedQuestions.has(q.id)}
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
                        passageMarks={passageMarks}
                        onAddPassageMark={addPassageMark}
                        onRemovePassageMark={removePassageMark}
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
                          readOnly={readOnly}
                          cleared={clearedQuestions.has(q.id)}
                          flags={answers[q.id]?.flags}
                          onToggleFlag={(flag) => toggleFlag(q.id, flag)}
                          optionFlags={answers[q.id]?.optionFlags}
                          onToggleOptionDoubt={(key) => toggleOptionDoubt(q.id, key)}
                          stemMarks={(answers[q.id]?.marks ?? []).filter((mark) => mark.scope === "stem")}
                          onToggleStemMark={(anchor) => toggleStemMark(q.id, anchor)}
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
                      readOnly={readOnly}
                      cleared={clearedQuestions.has(q.id)}
                      flags={answers[q.id]?.flags}
                      onToggleFlag={(flag) => toggleFlag(q.id, flag)}
                      optionFlags={answers[q.id]?.optionFlags}
                      onToggleOptionDoubt={(key) => toggleOptionDoubt(q.id, key)}
                      stemMarks={(answers[q.id]?.marks ?? []).filter((mark) => mark.scope === "stem")}
                      onToggleStemMark={(anchor) => toggleStemMark(q.id, anchor)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {sheet && sheet.status === "draft" && (
        <div className="flex justify-end">
          <button type="button" onClick={openSealModal}
            className="rounded-full bg-[var(--color-accent)] px-5 py-2 text-xs font-semibold text-[var(--color-accent-contrast,var(--color-surface))] shadow-sm hover:opacity-90">
            定格题纸
          </button>
        </div>
      )}

      {historyQuestion && (
        <L3AttemptHistoryModal
          question={historyQuestion}
          attempts={(attemptsByQuestion[historyQuestion.id] ?? []).filter((row) => row.status === "active")}
          annotations={annotationsByQuestion[historyQuestion.id] ?? []}
          deepLink={historyDeepLink}
          onClose={() => setHistoryQuestionId(null)}
          onDelete={(attemptId) => { void handleDeleteAttempt(attemptId); }}
        />
      )}

      {sealOpen && sheet && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog" aria-modal="true" aria-label="定格题纸">
          <div className="w-full max-w-md space-y-4 rounded-2xl bg-[var(--color-surface)] p-5 shadow-xl ring-1 ring-[var(--color-border)]">
            <div>
              <h3 className="text-base font-bold">定格题纸</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-soft)]">
                定格后本题纸不可再修改；草稿注记将随题纸提交待检验。
              </p>
            </div>
            <div className="space-y-2">
              {SEAL_MODE_OPTIONS.map((option) => (
                <label key={option.value}
                  className={`flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 transition-colors ${sealMode === option.value ? "border-[var(--color-accent)] bg-[var(--color-accent-soft,var(--color-surface))]" : "border-[var(--color-border)]"}`}>
                  <input type="radio" name="seal-mode" className="mt-0.5" checked={sealMode === option.value}
                    onChange={() => setSealMode(option.value)} />
                  <span>
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--color-ink-soft)]">{option.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {sealMode === "summary" && (
              <textarea rows={3} value={sealSummary} onChange={(e) => setSealSummary(e.target.value)}
                placeholder="写下本次刷题的总结（必填）…"
                className="w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-xs leading-relaxed focus:border-[var(--color-accent)] focus:outline-none" />
            )}
            {sealUnanswered !== null && (
              <div className="rounded-xl border border-amber-400 bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                还有 {sealUnanswered} 题未作答；继续定格将不会记录这些题。
              </div>
            )}
            {sealRecheck > 0 && (
              <div className="rounded-xl border border-sky-300 bg-sky-50 p-2.5 text-xs leading-relaxed text-sky-800 dark:bg-sky-950/30 dark:text-sky-200">
                还有 {sealRecheck} 题标记了「待复查」；仅提示，不影响定格。
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setSealOpen(false); setSealUnanswered(null); }}
                className="rounded-md px-3 py-1.5 text-xs text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]">
                取消
              </button>
              <button type="button"
                disabled={sealBusy || (sealMode === "summary" && sealSummary.trim().length === 0)}
                onClick={() => void submitSeal(sealUnanswered !== null)}
                className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50">
                {sealUnanswered !== null ? "仍要定格" : "确认定格"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
