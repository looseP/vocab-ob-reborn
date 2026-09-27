/**
 * 「录题」页签（2026-09-27，执行文档 B2 / 缺口 A）—— owner 手录**单题**。
 *
 * 为什么单题也要一个面：此前题只能**整卷附带**录入（`POST /l3/papers` 的
 * `sections[].questions[]`，见粘贴建卷）。想给某个来源补一道题、或先录一道题再决定
 * 放进哪张卷，都做不到 —— 题库进不来，做题回路的原料就断。
 *
 * 题目字段在 `QuestionFieldsEditor`（与粘贴建卷共用，见执行文档 D-3）；本页只管
 * **归属**（题型 + 来源/题组键）与**提交**。
 *
 * 落库走 ADR-0037 决策 2：owner 直写 `active`（不落 pending、不进「待录」）。
 * 本页**不提供**「存为待录」—— 那要让 owner 自己录的题再走一遍自己的采纳门，
 * 是仪式没有安全收益；真要改这条得重开 ADR-0037。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createL3Question } from "@/frontend/api/l3Client";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { isSourcelessQuestionType, L3_QUESTION_TYPES, type L3QuestionType } from "@/domain/l3-question-types";
import {
  emptyQuestion,
  QuestionFieldsEditor,
  type DraftQuestion,
} from "./QuestionFieldsEditor";

const TYPE_LABELS: Record<L3QuestionType, string> = {
  cloze: "完型",
  reading_choice: "阅读选择",
  new_question: "新题型",
  sentence_translation: "句译",
  short_essay: "小作文",
  long_essay: "大作文",
  grammar_blank: "语法填空",
};

const OPTION_KEYS = ["A", "B", "C", "D"] as const;

interface SourceOption { id: string; title: string }

export interface RecordTabProps {
  onToast: (kind: "success" | "error", msg: string) => void;
  /** 录成之后通知宿主（用于刷新题型空间的文件计数等派生视图）。 */
  onRecorded?: () => void;
}

export function RecordTab({ onToast, onRecorded }: RecordTabProps) {
  const [questionType, setQuestionType] = useState<L3QuestionType>("reading_choice");
  const [sourceId, setSourceId] = useState("");
  const [fileKey, setFileKey] = useState("");
  const [draft, setDraft] = useState<DraftQuestion>(emptyQuestion);
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const sourceless = isSourcelessQuestionType(questionType);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ items: SourceOption[] }>("/l3/sources?limit=100&sort=recent")
      .then((page) => { if (!cancelled) setSources(page.items); })
      .catch(() => { if (!cancelled) setSources([]); });
    return () => { cancelled = true; };
  }, []);

  /** 换题型：来源形态与答案形态都变 ⇒ 整体重置草稿（沿 BuildTab 的语义）。 */
  const switchType = useCallback((next: L3QuestionType) => {
    setQuestionType(next);
    setDraft(emptyQuestion());
    setProblem(null);
  }, []);

  /**
   * G-A1：选择题的答案键必须是**已填选项之一**。
   *
   * 为什么要客户端挡：答案键为空或指向空选项，服务端 schema 只会说「choice 是 1–20 字符的
   * 字符串」—— 它**不知道**哪个选项被填了。而「答案键指向空选项」在判卷时表现为
   「这道题没有正确答案」，不报错、只是永远判错。故在提交前说清楚。
   */
  const answerKeyProblem = useMemo((): string | null => {
    const filled = OPTION_KEYS.filter((key) => (draft.options[key] ?? "").trim().length > 0);
    if (filled.length < 2) return "选择题至少要填两个选项";
    if (!draft.answer) return "请指定正确答案（点选项左侧的圆点）";
    if (!filled.includes(draft.answer as typeof OPTION_KEYS[number])) {
      return `答案键 ${draft.answer} 对应的选项还没填内容`;
    }
    return null;
  }, [draft.answer, draft.options]);

  const submit = async () => {
    const stem = draft.stem.trim();
    // G-A3：空题干不提交（提交空题干 = 在题库里造一条永远不能做的题）。
    if (stem.length === 0) {
      setProblem("题干不能为空");
      return;
    }
    // 归属：source 与 fileKey 至少居其一（schema 的 refine 也判，但错误信息不可读）。
    if (!sourceless && !sourceId) {
      setProblem("请选择阅读材料（先在书架导入正文）");
      return;
    }
    if (sourceless && fileKey.trim().length === 0) {
      setProblem("翻译/作文题请给一个题组键（同一题组复用同名键）");
      return;
    }
    const choice = !sourceless;
    if (choice && answerKeyProblem) {
      setProblem(answerKeyProblem);
      return;
    }
    if (!choice && draft.answerText.trim().length === 0) {
      setProblem("请填参考译文 / 范文与评分要点");
      return;
    }

    setSaving(true);
    setProblem(null);
    try {
      const options = choice
        ? OPTION_KEYS
          .map((key) => ({ key, text: (draft.options[key] ?? "").trim() }))
          .filter((option) => option.text.length > 0)
        : undefined;
      const question = await createL3Question({
        questionType,
        sourceId: sourceless ? null : sourceId,
        fileKey: sourceless ? fileKey.trim() : null,
        stem,
        // G-A2：空值不提交 —— 提交空串等于把「没有解析」写成「解析是空的」，
        // 将来改题时更会把它当成「用户清空过」而无法区分。
        ...(options && options.length > 0 ? { options } : {}),
        ...(choice
          ? { answer: { choice: draft.answer } }
          : { answer: { text: draft.answerText.trim() } }),
        ...(draft.explanation.trim() ? { explanation: draft.explanation.trim() } : {}),
        ...(draft.evidence.length > 0 ? { evidence: draft.evidence } : {}),
      });
      onToast("success", `已录题：${stem.slice(0, 20)}${stem.length > 20 ? "…" : ""}（${TYPE_LABELS[questionType]}，已生效）`);
      // 录完清空题干与答案键，但**保留题型与来源** —— 连续录同一文件的多道题是常见节奏，
      // 让用户每录一道都要重选来源是把「录题」变成折磨。
      setDraft(emptyQuestion());
      onRecorded?.();
    } catch (err) {
      // G-B3 同款：失败保留输入（用户在题上花的时间不能白花），就地报错而不是清空重来。
      onToast("error", err instanceof BrowserApiError ? err.message : "录题失败，请稍后重试");
      setProblem("录题失败，上面的内容已保留，可改后重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--color-ink-soft)]">
        录一道题。录成即<b>生效</b>（不进「待录」—— 那是 agent 录题的核对面）。
        想批量录一整卷用「粘贴建卷」。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={questionType} onChange={(e) => switchType(e.target.value as L3QuestionType)}
          data-testid="record-question-type"
          className="rounded border border-[var(--color-border)] px-2 py-1 text-sm">
          {L3_QUESTION_TYPES.map((type: L3QuestionType) => <option key={type} value={type}>{TYPE_LABELS[type]}</option>)}
        </select>
        {sourceless ? (
          <input value={fileKey} onChange={(e) => setFileKey(e.target.value)}
            placeholder="题组键（同一题组复用同名键）"
            data-testid="record-file-key"
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs" />
        ) : (
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}
            data-testid="record-source"
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs">
            <option value="">选择阅读材料（先在书架导入正文）…</option>
            {sources.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}
          </select>
        )}
      </div>

      <QuestionFieldsEditor
        value={draft}
        onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
        questionType={questionType}
        sourceId={sourceless ? null : sourceId || null}
        fileKey={sourceless ? fileKey || null : null}
        radioName="record-answer"
        explanationTestId="record-explanation"
        onError={(message) => onToast("error", message)}
      />

      {answerKeyProblem && !sourceless && (
        <p className="text-[11px] text-[var(--color-ink-soft)]" data-testid="record-answer-hint">
          {answerKeyProblem}
        </p>
      )}
      {problem && (
        <p className="text-[11px] text-[var(--color-danger,#dc2626)]" data-testid="record-problem">{problem}</p>
      )}

      <div className="flex items-center gap-2">
        <button type="button" disabled={saving} onClick={() => void submit()} data-testid="record-submit"
          className="rounded bg-[var(--color-accent)] px-4 py-1.5 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50">
          {saving ? "提交中…" : "录题"}
        </button>
        {draft.stem.trim().length > 0 && (
          <button type="button" onClick={() => { setDraft(emptyQuestion()); setProblem(null); }}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-ink-soft)]">
            清空
          </button>
        )}
      </div>
    </div>
  );
}
