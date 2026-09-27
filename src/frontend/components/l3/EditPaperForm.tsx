/**
 * 改卷表单（2026-09-27，执行文档 B4 / 缺口 C / D-5）—— 编辑既有试卷。
 *
 * **与建卷的形状差别**（§1.6b）：这里不定义题，只**引用**既有题
 * （`sections[].questionIds`）。所以它是「选题」表单而不是「录题」表单 ——
 * 把两种形状塞进一个组件会得到一个「有时有题体、有时只有 id」的表单。
 *
 * 选题的候选来自 `GET /practice-files/detail`（B3 已给它加上 `editable`，这里只用
 * 它的题面与 id，不用可编辑性 —— 引用不需要改写权限）。
 *
 * G-C1：改题集前必须告知「已开题纸的题单不变」—— 题单冻结是既有口径（迁移 0046），
 * 改卷**不动**已定格题纸。不告知的话，用户会以为改了卷，之前做过的题纸也跟着变。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { updateL3Paper, type L3PracticeFileQuestion } from "@/frontend/api/l3Client";
import { apiFetch } from "@/frontend/api/client";
import { L3_QUESTION_TYPES, isSourcelessQuestionType, type L3QuestionType } from "@/domain/l3-question-types";
import type { ExamPaper } from "./L3ExamPaper";

const TYPE_LABELS: Record<L3QuestionType, string> = {
  cloze: "完型",
  reading_choice: "阅读选择",
  new_question: "新题型",
  sentence_translation: "句译",
  short_essay: "小作文",
  long_essay: "大作文",
  grammar_blank: "语法填空",
};

const DIRECTIONS = ["通用", "考研", "雅思"] as const;

interface EditableSection {
  key: string;
  title: string;
  questionType: L3QuestionType;
  sourceId: string | null;
  fileKey: string | null;
  questionIds: string[];
}

export function EditPaperForm({
  paper,
  onDone,
  onCancel,
  onToast,
}: {
  paper: ExamPaper;
  onDone: () => void;
  onCancel: () => void;
  onToast: (kind: "success" | "error", msg: string) => void;
}) {
  const [title, setTitle] = useState(paper.title);
  const [direction, setDirection] = useState<string>(paper.direction ?? "");
  const [sections, setSections] = useState<EditableSection[]>(() =>
    paper.sections.map((section) => ({
      key: section.key,
      title: section.title,
      questionType: section.questionType,
      sourceId: section.sourceId ?? null,
      fileKey: section.fileKey ?? null,
      questionIds: [...section.questionIds],
    })));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** 原来的题集指纹：用来判断「这次改卷动了题集」⇒ G-C1 的提示只在真的动了时出现。 */
  const originalQuestionIds = useMemo(
    () => paper.sections.flatMap((section) => [...section.questionIds]).sort().join(","),
    [paper.sections],
  );
  const currentQuestionIds = useMemo(
    () => sections.flatMap((section) => [...section.questionIds]).sort().join(","),
    [sections],
  );
  const questionSetChanged = originalQuestionIds !== currentQuestionIds;

  const patchSection = (index: number, patch: Partial<EditableSection>) =>
    setSections((prev) => prev.map((section, i) => (i === index ? { ...section, ...patch } : section)));

  const toggleQuestion = (index: number, questionId: string) => {
    setSections((prev) => prev.map((section, i) => {
      if (i !== index) return section;
      const has = section.questionIds.includes(questionId);
      return {
        ...section,
        questionIds: has
          ? section.questionIds.filter((id) => id !== questionId)
          : [...section.questionIds, questionId],
      };
    }));
  };

  const submit = async () => {
    if (title.trim().length === 0) {
      setProblem("试卷标题不能为空");
      return;
    }
    for (const [index, section] of sections.entries()) {
      if (section.questionIds.length === 0) {
        setProblem(`第 ${index + 1} 节没有选题 —— 空节会让整卷少一段可做的内容`);
        return;
      }
      // 同一题不能跨节重复引用（payload 校验会拒，但那条错误不可读）
      const seen = new Set<string>();
      for (const id of section.questionIds) {
        if (seen.has(id)) {
          setProblem(`第 ${index + 1} 节里同一题出现了两次`);
          return;
        }
        seen.add(id);
      }
    }
    const duplicated = sections.some((section, i) =>
      sections.some((other, j) => j > i && other.questionIds.some((id) => section.questionIds.includes(id))));
    if (duplicated) {
      setProblem("同一题不能跨节重复引用（每题在卷内只出现一次）");
      return;
    }

    setSaving(true);
    setProblem(null);
    try {
      const result = await updateL3Paper(paper.id, {
        title: title.trim(),
        direction: direction || null,
        sections: sections.map((section) => ({
          key: section.key,
          title: section.title.trim(),
          questionType: section.questionType,
          sourceId: section.sourceId,
          fileKey: section.fileKey,
          questionIds: section.questionIds,
        })),
      });
      onToast("success", `已保存改卷（${result.questionCount} 题）`);
      onDone();
    } catch (err) {
      // G-C2：按 updatePaper **自己的**两组判据归因（卷非 active 409 / 题不属主或非 active 422），
      // 不套用 updateQuestion 的 409 文案 —— 那两组是不同的事。
      const message = err instanceof BrowserApiError ? err.message : "";
      if (/active papers|archived|draft/i.test(message)) {
        setProblem("只有已生效（active）的试卷能改 —— 归档卷不可编辑。");
      } else if (/active|属主|owned|sections/i.test(message)) {
        setProblem(message.length > 0 ? message : "引用的题不存在、已删除或不属主 —— 请重新选题。");
      } else {
        onToast("error", message.length > 0 ? message : "改卷失败，请稍后重试");
        setProblem("改卷失败，上面的内容已保留，可改后重试");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--color-ink-soft)]">
        改「{paper.title}」。这里**引用**既有题，不改题面 —— 要改题面去「录题」页签。
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input value={title} onChange={(event) => setTitle(event.target.value)}
          placeholder="试卷标题"
          data-testid="edit-paper-title"
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] px-2 py-1 text-sm" />
        <select value={direction} onChange={(event) => setDirection(event.target.value)}
          data-testid="edit-paper-direction"
          className="rounded border border-[var(--color-border)] px-2 py-1 text-sm">
          <option value="">方向（不限）</option>
          {DIRECTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div>

      {sections.map((section, index) => (
        <SectionEditor
          key={section.key}
          section={section}
          index={index}
          onPatch={(patch) => patchSection(index, patch)}
          onToggleQuestion={(questionId) => toggleQuestion(index, questionId)}
          onRemove={sections.length > 1
            ? () => setSections((prev) => prev.filter((_, i) => i !== index))
            : undefined}
        />
      ))}

      {questionSetChanged && (
        <p className="rounded border border-amber-400 bg-amber-50 p-2 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
          data-testid="edit-paper-questionset-warning">
          你改了卷内题集。**已经开过的题纸不受影响** —— 题单在开纸时就冻结了（题单是那一卷
          定格时的快照），改卷只对之后新开的题纸生效。
        </p>
      )}
      {problem && (
        <p className="text-[11px] text-[var(--color-danger,#dc2626)]" data-testid="edit-paper-problem">{problem}</p>
      )}

      <div className="flex items-center gap-2">
        <button type="button" disabled={saving} onClick={() => void submit()} data-testid="edit-paper-submit"
          className="rounded bg-[var(--color-accent)] px-4 py-1.5 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50">
          {saving ? "保存中…" : "保存改卷"}
        </button>
        <button type="button" onClick={onCancel} data-testid="edit-paper-cancel"
          className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-ink-soft)]">
          取消
        </button>
      </div>
    </div>
  );
}

function SectionEditor({
  section,
  index,
  onPatch,
  onToggleQuestion,
  onRemove,
}: {
  section: EditableSection;
  index: number;
  onPatch(patch: Partial<EditableSection>): void;
  onToggleQuestion(questionId: string): void;
  onRemove?: () => void;
}) {
  const [candidates, setCandidates] = useState<L3PracticeFileQuestion[] | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!section.sourceId && !section.fileKey) {
      setCandidates(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ questionType: section.questionType });
    if (section.sourceId) params.set("sourceId", section.sourceId);
    if (section.fileKey) params.set("fileKey", section.fileKey);
    setCandidates(null);
    apiFetch<{ questions?: L3PracticeFileQuestion[] }>(`/l3/practice-files/detail?${params.toString()}`)
      .then((body) => { if (!cancelled) setCandidates(body.questions ?? []); })
      .catch(() => { if (!cancelled) setCandidates([]); });
    return () => { cancelled = true; };
  }, [section.sourceId, section.fileKey, section.questionType, nonce]);

  const sourceless = isSourcelessQuestionType(section.questionType);

  return (
    <section className="space-y-1.5 rounded-xl border border-[var(--color-border)] p-3" data-testid={`edit-paper-section-${index}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--color-ink-soft)]">第 {index + 1} 节</span>
        <input value={section.title} onChange={(event) => onPatch({ title: event.target.value })}
          placeholder="节标题"
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] px-2 py-1 text-sm" />
        <select value={section.questionType} onChange={(event) => onPatch({ questionType: event.target.value as L3QuestionType })}
          className="rounded border border-[var(--color-border)] px-2 py-1 text-sm">
          {L3_QUESTION_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
        </select>
        {onRemove && (
          <button type="button" onClick={onRemove} className="text-xs text-[var(--color-danger,#dc2626)]">删节</button>
        )}
      </div>

      {/*
        来源/题组键是**只读展示**而不是可改控件：改节归属等于换文件身份，而文件的身份是
        `(question_type, source_id | file_key)`（ADR-0030）—— 换身份会让这一节引用的题
        与文件对不上。改归属的正确做法是新建一节。
      */}
      <p className="text-[10px] text-[var(--color-ink-soft)]">
        归属：{sourceless ? `题组键 ${section.fileKey ?? "（无）"}` : `来源 ${section.sourceId ?? "（无）"}`}
        （归属不可改 —— 换归属请新建一节）
      </p>

      {candidates === null ? (
        <p className="text-[11px] text-[var(--color-ink-soft)]">候选题加载中…</p>
      ) : candidates.length === 0 ? (
        <p className="text-[11px] text-[var(--color-ink-soft)]">这个文件下没有可引用的题（去「录题」页签录几道）。</p>
      ) : (
        <ul className="space-y-1">
          {candidates.map((row) => {
            const picked = section.questionIds.includes(row.id);
            return (
              <li key={row.id}>
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" checked={picked} onChange={() => onToggleQuestion(row.id)}
                    data-testid={`edit-paper-pick-${row.id}`}
                    className="mt-0.5" />
                  <span className="min-w-0 flex-1 break-words">{row.stem}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[10px] text-[var(--color-ink-soft)]">本节已选 {section.questionIds.length} 题</p>
      {candidates !== null && section.questionIds.length > 0 && (
        <button type="button" onClick={() => setNonce((n) => n + 1)} className="text-[10px] text-[var(--color-ink-soft)] hover:text-[var(--color-accent)]">
          刷新候选
        </button>
      )}
    </section>
  );
}
