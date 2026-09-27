/**
 * 题目字段编辑器（2026-09-27，执行文档 `l3-question-authoring-ui-execution-2026-09-27.md` D-3）。
 *
 * **为什么抽出来**：题目字段（题干/选项/答案键/官方解析/官方证据）此前只在「粘贴建卷」
 * 里存在一套。加一个「录题」入口若各写一份，就是同一份字段定义的两个实现 ——
 * 漂移的方向几乎必然是「改题面支持了新题型，录题面没跟上」，而答案键的题型分支错了
 * 不会报错、只会静默录错题。故字段**只有这一处**。
 *
 * 纯受控组件：自己**不持有**任何题目状态，只把变更报给 `onChange`。这样「粘贴建卷」
 * 的草稿数组与「录题」的草稿各自仍是唯一真源（换题型要整体重置答案键时，宿主能看见
 * 完整的一次 patch，而不是组件内部悄悄改掉一半）。
 *
 * 字段矩阵见执行文档 §三：选择题渲染 A–D 与单选答案键；翻译/作文渲染文本答案
 * （不渲染选项与 choice —— 不是全渲染再隐藏，隐藏的输入框仍会被填进去）。
 */
import { QuestionEvidenceEditor, type EvidenceAnchor } from "./QuestionEvidenceEditor";
import type { L3QuestionType } from "@/domain";

/** 草稿题（录题与建卷共用的形状；与 `POST /papers` 的 questions[] 一一对应）。 */
export interface DraftQuestion {
  stem: string;
  /** 选项文本按键存（选择题 A–D；未填的键不进提交体）。 */
  options: Record<string, string>;
  /** 选择题答案键（单选）。 */
  answer: string;
  /** 翻译答案 / 作文范文与评分要点（非选择题）。 */
  answerText: string;
  /** 官方解析（判卷读面 grading-context 依赖它；空则不提交）。 */
  explanation: string;
  /** 官方证据锚点（原文 UTF-16 区间）。 */
  evidence: EvidenceAnchor[];
}

export const emptyQuestion = (): DraftQuestion => ({
  stem: "", options: {}, answer: "", answerText: "", explanation: "", evidence: [],
});

/** 选择题题型（与 L3PapersPage 的 CHOICE_TYPES 同款分组；此处自持一份以免组件互相依赖）。 */
const CHOICE_TYPES: readonly L3QuestionType[] = ["cloze", "reading_choice", "new_question", "grammar_blank"];

const OPTION_KEYS = ["A", "B", "C", "D"] as const;

export function QuestionFieldsEditor({
  value,
  onChange,
  questionType,
  sourceId,
  fileKey,
  /** 同一页多题时**必须**各不相同：同 name 的 radio 会互相取消选中（静默丢答案键）。 */
  radioName,
  /** 解析框的完整 testid（宿主各有自己的命名，既有断言不能被打断）。 */
  explanationTestId,
  onError,
}: {
  value: DraftQuestion;
  onChange(patch: Partial<DraftQuestion>): void;
  questionType: L3QuestionType;
  sourceId: string | null;
  fileKey: string | null;
  radioName: string;
  explanationTestId: string;
  onError(message: string): void;
}) {
  const choice = CHOICE_TYPES.includes(questionType);
  return (
    <div className="space-y-1.5">
      <textarea value={value.stem} onChange={(e) => onChange({ stem: e.target.value })}
        rows={2} placeholder="题干"
        className="min-w-0 w-full rounded border border-[var(--color-border)] px-2 py-1 text-sm" />
      {choice ? (
        <div className="grid gap-1 sm:grid-cols-2">
          {OPTION_KEYS.map((key) => (
            <label key={key} className="flex items-center gap-1.5 text-xs">
              <input type="radio" name={radioName} value={key} checked={value.answer === key}
                onChange={() => onChange({ answer: key })} />
              <span>{key}.</span>
              <input value={value.options[key] ?? ""} onChange={(e) => onChange({ options: { ...value.options, [key]: e.target.value } })}
                placeholder={`选项 ${key}`}
                className="min-w-0 flex-1 rounded border border-[var(--color-border)] px-1.5 py-1" />
            </label>
          ))}
        </div>
      ) : (
        <textarea value={value.answerText} onChange={(e) => onChange({ answerText: e.target.value })}
          rows={3} placeholder="参考译文 / 范文与评分要点"
          className="w-full rounded border border-[var(--color-border)] px-2 py-1 text-xs" />
      )}
      <textarea
        value={value.explanation}
        onChange={(e) => onChange({ explanation: e.target.value })}
        rows={2}
        placeholder="官方解析（可空）：为什么选它 / 错在哪"
        data-testid={explanationTestId}
        className="w-full rounded border border-[var(--color-border)] px-2 py-1 text-xs"
      />
      <QuestionEvidenceEditor
        sourceId={sourceId}
        fileKey={fileKey}
        questionType={questionType}
        anchors={value.evidence}
        onChange={(next) => onChange({ evidence: next })}
        onError={onError}
      />
    </div>
  );
}
