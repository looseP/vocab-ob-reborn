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
