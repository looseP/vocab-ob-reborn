/**
 * L3 题型轴与试卷 payload（ADR-0030）——纯常量/纯函数，零出向、零 IO、确定性。
 *
 * 双层分类（设计卡 §2.1）：能力域 space 挂材料（ADR-0019，domain/index.ts），
 * question_type 挂题（本文件）。题型 → 能力域自动映射，录入时由 service 落标，
 * 用户不需要做两次分类。做题文件是派生视图（不建文件表）：
 *   - 有正文：(source_id, question_type) 题组聚合即一个文件；
 *   - 无正文（翻译/作文）：file_key 题组定界。
 * 试卷结构 = l3_papers.payload 内的有序 sections（引用题 id，现拉现渲染）。
 */

export const L3_QUESTION_TYPES = [
  "cloze",
  "reading_choice",
  "new_question",
  "sentence_translation",
  "short_essay",
  "long_essay",
  "grammar_blank",
] as const;

export type L3QuestionType = (typeof L3_QUESTION_TYPES)[number];

export const L3_QUESTION_TYPE_LABELS: Record<L3QuestionType, string> = {
  cloze: "完型",
  reading_choice: "阅读选择",
  new_question: "新题型",
  sentence_translation: "句译",
  short_essay: "小作文",
  long_essay: "大作文",
  grammar_blank: "语法填空",
};

export const L3_QUESTION_STATUSES = ["pending", "active", "rejected"] as const;
export type L3QuestionStatus = (typeof L3_QUESTION_STATUSES)[number];

export const L3_PAPER_STATUSES = ["draft", "active", "archived"] as const;
export type L3PaperStatus = (typeof L3_PAPER_STATUSES)[number];

/**
 * 题型 → 能力域自动映射（设计卡 §2.1 定案）：
 * cloze/reading_choice/new_question→阅读；sentence_translation→翻译；
 * short_essay/long_essay→作文；grammar_blank→语法。
 * 返回值与 L3SubSpace 五值枚举同构（结构类型，无需循环 import）。
 */
const QUESTION_TYPE_SPACE_MAP = {
  cloze: "阅读",
  reading_choice: "阅读",
  new_question: "阅读",
  sentence_translation: "翻译",
  short_essay: "作文",
  long_essay: "作文",
  grammar_blank: "语法",
} as const satisfies Record<L3QuestionType, string>;

export function questionTypeSpace(questionType: L3QuestionType): (typeof QUESTION_TYPE_SPACE_MAP)[L3QuestionType] {
  return QUESTION_TYPE_SPACE_MAP[questionType];
}

/** 无正文材料的题型（题面即材料，文件由 file_key 题组构成）。 */
const SOURCELESS_QUESTION_TYPES = new Set<L3QuestionType>([
  "sentence_translation",
  "short_essay",
  "long_essay",
]);

export function isSourcelessQuestionType(questionType: L3QuestionType): boolean {
  return SOURCELESS_QUESTION_TYPES.has(questionType);
}

/** 题可以不挂正文材料的题型（翻译/作文题面自足；其余必须有 source）。 */
export function questionTypeAllowsSourceless(questionType: L3QuestionType): boolean {
  return isSourcelessQuestionType(questionType);
}

// ── 题目 jsonb 结构（options/answer/evidence 的服务端契约形态）──────────────

/** 选择题选项（key 通常 A–G，new_question 的七选五可能到 G）。 */
export interface L3QuestionOption {
  key: string;
  text: string;
}

/** 标准答案证据锚点：指向 source.content_text 的 [start,end) 区间 + 题号标签。 */
export interface L3EvidenceAnchor {
  start: number;
  end: number;
  label: string;
}

/**
 * 标准答案（按题型分化，字段可缺省但对象恒在）：
 *  - choice：单选 key（cloze/reading_choice）；
 *  - choices：多空/配对答案（new_question 七选五、grammar_blank）；
 *  - text：参考译文/范文（句译/作文）；
 *  - points：评分要点；sample：范文。
 */
export interface L3QuestionAnswer {
  choice?: string;
  choices?: string[];
  text?: string;
  sample?: string;
  points?: string[];
}

// ── 试卷 payload（l3_papers.payload，学 l3_sessions.plan 的引用哲学）──────────

export const PAPER_PAYLOAD_VERSION = 1 as const;

/** payload 内一个有序 section = 对一个做题文件的有序引用。 */
export interface L3PaperSection {
  key: string;
  title: string;
  questionType: L3QuestionType;
  /** 有正文文件：引用的阅读材料（l3_sources.id）。 */
  sourceId: string | null;
  /** 无正文文件：题组键。与 sourceId 至少居其一。 */
  fileKey: string | null;
  /** 有序题目 id（l3_questions.id）；全局不重复（每题在卷内只出现一次）。 */
  questionIds: string[];
}

export interface L3PaperPayload {
  version: typeof PAPER_PAYLOAD_VERSION;
  sections: L3PaperSection[];
}

/** 调用方（service/HTTP）喂进来的未校验形状。 */
export type L3PaperPayloadInput = {
  version?: unknown;
  sections?: Array<{
    key?: unknown;
    title?: unknown;
    questionType?: unknown;
    sourceId?: unknown;
    fileKey?: unknown;
    questionIds?: unknown;
  }>;
};

function fail(message: string): never {
  throw new Error(message);
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`paper payload field ${field} must be a non-empty string`);
  }
  return value.trim();
}

function asOptionalTrimmedString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") fail(`paper payload field ${field} must be a string or null`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * 纯结构校验（ADR-0030 §2 护栏①的结构部分）：
 * version 钉版本、section key 唯一、题型合法、文件身份齐整、题 id 全局唯一。
 * 归属与题型一致性（题是否属于该 user / source / questionType）是 DB 事实，
 * 由 service 在事务内校验，纯函数不做 IO。
 */
export function validatePaperPayloadShape(input: L3PaperPayloadInput | null | undefined): L3PaperPayload {
  if (!input || typeof input !== "object") fail("paper payload must be an object");
  if (input.version !== PAPER_PAYLOAD_VERSION) {
    fail(`unsupported paper payload version: ${String(input.version)}`);
  }
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    fail("paper payload requires at least one section");
  }

  const sectionKeys = new Set<string>();
  const questionIds = new Set<string>();
  const sections: L3PaperSection[] = input.sections.map((raw, index) => {
    const where = `sections[${index}]`;
    const key = asNonEmptyString(raw.key, `${where}.key`);
    if (sectionKeys.has(key)) fail(`duplicate section key: ${key}`);
    sectionKeys.add(key);

    const title = asNonEmptyString(raw.title, `${where}.title`);
    const questionType = asNonEmptyString(raw.questionType, `${where}.questionType`);
    if (!L3_QUESTION_TYPES.includes(questionType as L3QuestionType)) {
      fail(`invalid question_type in ${where}: ${questionType}`);
    }
    const sourceId = asOptionalTrimmedString(raw.sourceId, `${where}.sourceId`);
    const fileKey = asOptionalTrimmedString(raw.fileKey, `${where}.fileKey`);
    if (!sourceId && !fileKey) {
      fail(`${where} requires sourceId or fileKey (a practice file identity)`);
    }

    if (!Array.isArray(raw.questionIds) || raw.questionIds.length === 0) {
      fail(`${where}.questionIds must be a non-empty array`);
    }
    const ids = raw.questionIds.map((id, qIndex) => {
      const normalized = asNonEmptyString(id, `${where}.questionIds[${qIndex}]`);
      if (questionIds.has(normalized)) fail(`question ${normalized} referenced more than once`);
      questionIds.add(normalized);
      return normalized;
    });

    return { key, title, questionType: questionType as L3QuestionType, sourceId, fileKey, questionIds: ids };
  });

  return { version: PAPER_PAYLOAD_VERSION, sections };
}
