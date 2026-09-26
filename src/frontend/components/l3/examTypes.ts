/**
 * 卷面共享类型（ADR-0030 / 批次一）。
 *
 * 独立成文件以切断 L3ExamPaper ↔ L3QuestionAnalysis 的循环依赖：
 * 题卡子组件只依赖题型，不依赖卷面组件本身。
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

export type ExamQuestionType =
  | "cloze" | "reading_choice" | "new_question" | "sentence_translation"
  | "short_essay" | "long_essay" | "grammar_blank";

export interface ExamSection {
  key: string;
  title: string;
  questionType: ExamQuestionType;
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

/**
 * 题单快照裁剪（2026-09-26）：服务端在开纸时把作用域题集定格进
 * `sheet.question_ids`；交卷物化与评卷读面都以它为唯一题集。若前端仍按自己
 * 拉到的题组渲染，用户就能答到定格之外的题——那些作答会在交卷时被**静默丢弃**。
 * 故渲染范围必须与快照一致：题组里多出来的题不渲染（并如实告知），快照里有
 * 而题组没有的题不虚构（快照只缩不换）。
 *
 * `frozenIds` 为空/未定格 → 原样返回（历史题纸与写作草稿沿用旧行为）。
 * section 顺序按快照顺序重排（快照即卷面顺序）；空 section 整节移除。
 */
export function scopePaperToFrozenList(paper: ExamPaper, frozenIds: readonly string[] | null | undefined): ExamPaper {
  if (!frozenIds || frozenIds.length === 0) return paper;
  const wanted = new Set(frozenIds);
  const rank = new Map(frozenIds.map((id, index) => [id, index]));
  const sections = paper.sections
    .map((section) => {
      const ordered = [...section.questionIds]
        .filter((id) => wanted.has(id))
        .sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
      const byId = new Map(section.questions.map((question) => [question.id, question]));
      return {
        ...section,
        questionIds: ordered,
        questions: ordered.map((id) => byId.get(id)).filter((q): q is ExamQuestion => Boolean(q)),
      };
    })
    .filter((section) => section.questionIds.length > 0);
  return { ...paper, sections };
}

/** 题组多出来、未进入本卷快照的题数（如实告知用；0 = 无裁剪）。 */
export function countQuestionsOutsideFrozenList(paper: ExamPaper, frozenIds: readonly string[] | null | undefined): number {
  if (!frozenIds || frozenIds.length === 0) return 0;
  const wanted = new Set(frozenIds);
  return paper.sections.reduce(
    (total, section) => total + section.questionIds.filter((id) => !wanted.has(id)).length,
    0,
  );
}
