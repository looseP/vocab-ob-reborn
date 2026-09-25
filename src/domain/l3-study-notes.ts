/**
 * 学习笔记（N1）domain —— 类型、输入契约、marker 解析与锚点纯校验。
 * 合同来源：docs/plan/study-notes-design-2026-09-18.md §3/§5/§6/§7。
 *
 * 纯函数、零 IO、零出向（不 import db/repositories/services/errors/schemas）——
 * ADR-001 domain 层红线。服务端判定错误由本层抛 ReferenceContractError，
 * service 收口转译为 422（ValidationError）。
 *
 * 关键语义：
 * - 正文标记 `[[ref:<uuid>]]` 仅在 marked lexer **顶层 paragraph token 的 text
 *   完全等于标记**时识别；代码围栏 / inline code / 引用块 / 标题 / 列表内的
 *   同形文本按普通 Markdown 显示（不识别、不报错）。顶层段落形如标记但内容
 *   非法（非 UUID）→ 明确报错（手写未知标记不得静默）。
 * - 锚点坐标一律为数据库原字符串的 UTF-16 code unit；选区不 trim、不做
 *   Unicode normalization、不按显示序号定位；端点不得切进代理对内部。
 * - 标记集合必须与 ReferenceWrite.id 集合完全相等且无重复（保存时服务端校验）。
 */

import { z } from "zod";
import { lexer } from "marked";
import {
  L3_QUESTION_TYPES,
  type L3QuestionOption,
  type L3QuestionType,
} from "./l3-question-types";

// ── 限额（设计 §3/§5/§7；全部为 UTF-16 code units 或计数）───────────────────

/** 笔记标题上限（UTF-16 code units；空标题合法，界面显示「无标题笔记」）。 */
export const STUDY_NOTE_TITLE_MAX = 120;
/** 笔记正文上限（UTF-16 code units）。 */
export const STUDY_NOTE_BODY_MAX = 100_000;
/** 每篇笔记引用上限。 */
export const STUDY_REFERENCE_MAX_PER_NOTE = 100;
/** 引用摘录 quote 上限。 */
export const STUDY_QUOTE_MAX = 4000;
/** optionKey 长度上限（A–G 等，留余量）。 */
export const STUDY_OPTION_KEY_MAX = 8;
/** 专题标题 1–120。 */
export const STUDY_TOPIC_TITLE_MAX = 120;
/** 专题成员上限（超出 422；列表仍分页）。 */
export const STUDY_TOPIC_MEMBER_MAX = 500;
/** 全部 snapshot 序列化总量上限（UTF-8 bytes；超出 422）。 */
export const STUDY_SNAPSHOT_BYTES_MAX = 2 * 1024 * 1024;
/** 列表分页 limit 默认 20、最大 50。 */
export const STUDY_PAGE_LIMIT_DEFAULT = 20;
export const STUDY_PAGE_LIMIT_MAX = 50;
/** 搜索 q 上限（用户 % _ 按文字转义）。 */
export const STUDY_SEARCH_Q_MAX = 100;
/** 来源整体快照摘要长度（前 280 code units）。 */
export const STUDY_SOURCE_EXCERPT_MAX = 280;
/** N2：评析展示快照的摘录上限（评析比来源正文更聚焦，取同一量级）。 */
export const STUDY_ASSESSMENT_EXCERPT_MAX = 280;
/**
 * N2 第二条链：笔记互链展示快照的摘录上限。
 *
 * 沿用来源/评析的**同量级摘录口径**（280）——不新增存储限制、不改动 API；
 * 笔记正文本身的上限仍是 `STUDY_NOTE_BODY_MAX`，快照总量另有
 * `STUDY_SNAPSHOT_BYTES_MAX` 兜底。
 */
export const STUDY_NOTE_EXCERPT_MAX = 280;
/**
 * N2 第三条链：sheet（sealed 稿次）展示快照的摘录上限。
 *
 * 沿用同一量级（280）——不新增存储限制、不改动 `STUDY_NOTE_BODY_MAX` 与
 * `STUDY_SNAPSHOT_BYTES_MAX`（K13）。
 */
export const STUDY_SHEET_EXCERPT_MAX = 280;
/** N2 第三条链：attempt（作答记录）展示快照的摘录上限（同量级 280）。 */
export const STUDY_ATTEMPT_EXCERPT_MAX = 280;

// ── 枚举（单一真源；与 DB CHECK 同步）───────────────────────────────────────

export const STUDY_NOTE_STATUSES = ["active", "archived"] as const;
export type StudyNoteStatus = (typeof STUDY_NOTE_STATUSES)[number];

export const STUDY_TOPIC_STATUSES = ["active", "archived"] as const;
export type StudyTopicStatus = (typeof STUDY_TOPIC_STATUSES)[number];

/**
 * 五种引用严格枚举（N1 不预留可任意写 JSON 的后门）。
 *
 * N2 第一条垂直链新增 `assessment`（评析），沿用同一套列式 target + CHECK 收口，
 * 不引入自由 JSON。评析是 `UNIQUE(user_id, question_id)` 的 latest-wins 记录
 * （任务书 §5.1 D3-1），因此 target 必须同时带 questionId 与 assessmentId——
 * 后者才是可被核验的具体身份，只允许 questionId 会退化成「引用某题的当前评析」。
 *
 * N2 第二条链新增 `note`（笔记互链）；第三条链新增 `sheet`（= `l3_submissions`
 * 的 **sealed** 稿次）与 `attempt`（= `l3_question_attempts` 的作答记录）。
 */
export const REFERENCE_KINDS = [
  "source",
  "source_quote",
  "question",
  "stem_quote",
  "option_quote",
  "assessment",
  "note",
  "sheet",
  "attempt",
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** N1 冻结的五种（导出 v1 只允许这五种出现在 payload 里；见 P4-1）。 */
export const N1_REFERENCE_KINDS = [
  "source",
  "source_quote",
  "question",
  "stem_quote",
  "option_quote",
] as const;
export type N1ReferenceKind = (typeof N1_REFERENCE_KINDS)[number];

/** 引用状态：字段 hash 不同 → changed；直接数据库越过应用的缺失 → unavailable。 */
export const REFERENCE_STATUSES = ["current", "changed", "unavailable"] as const;
export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number];

// ── 引用目标与写入（设计 §3 输入契约，camelCase）────────────────────────────

export type ReferenceTarget =
  | { kind: "source"; sourceId: string }
  | { kind: "source_quote"; sourceId: string; start: number; end: number; quote: string }
  | { kind: "question"; questionId: string }
  | { kind: "stem_quote"; questionId: string; start: number; end: number; quote: string }
  | {
      kind: "option_quote";
      questionId: string;
      optionKey: string;
      start: number;
      end: number;
      quote: string;
    }
  /** N2 第一条链：评析（`l3_question_assessments` 的某一行，非「某题当前评析」）。 */
  | { kind: "assessment"; questionId: string; assessmentId: string }
  /**
   * N2 第二条链：笔记互链（`l3_study_notes` 的某一行）。
   *
   * 身份就是目标笔记自身 id——不按标题、不按展示序号、不按专题位置兜底。
   * 只允许引用**当前用户且 active** 的目标；目标之后归档不撤销引用。
   */
  | { kind: "note"; noteId: string }
  /**
   * N2 第三条链：sheet = `l3_submissions` 的 **sealed 稿次**（D1-a / K1）。
   *
   * 身份遵循 K3：writing 稿次 = `{ submissionId, revisionNo }`（`revisionNo` 必填
   * 且 >0）；非 writing（file / paper）= `{ submissionId }`，`revisionNo` 为 NULL。
   * `draft_version` 不进身份（K4），也不按 writing task / parent sheet / 题目 /
   * 最近一次稿次兜底匹配（K5）。
   */
  | { kind: "sheet"; submissionId: string; revisionNo?: number | null }
  /**
   * N2 第三条链：attempt = `l3_question_attempts` 的作答记录。
   *
   * 身份是 `{ attemptId }` **单值**（K9）——不拼 question / sheet / venue，也不存在
   * 「按题目找最新一次 attempt」的回退路径。
   */
  | { kind: "attempt"; attemptId: string };

/** 前端构建 capture 载荷用（与 ReferenceWrite 的 capture 分支同构）。 */
export interface ReferenceInput {
  id: string;
  target: ReferenceTarget;
}

/** 保存时对引用集合的动作：keep 只保留原摘录；capture 新建或显式更新。 */
export type ReferenceWrite =
  | { id: string; action: "keep" }
  | { id: string; action: "capture"; target: ReferenceTarget };

// ── 保存输入（设计 §6：完整笔记状态）───────────────────────────────────────

export interface SaveNoteInput {
  expectedVersion: number;
  requestId: string;
  title: string;
  bodyMd: string;
  venues: L3QuestionType[];
  pinned: boolean;
  status: StudyNoteStatus;
  references: ReferenceWrite[];
}

// ── 响应 DTO（设计 §7；隐藏 userId/hash/requestId）─────────────────────────

/** 服务端白名单组装的展示快照（不含标准答案/explanation/evidence）。 */
export interface SourceReferenceSnapshot {
  kind: "source";
  title: string;
  excerpt: string;
}

export interface SourceQuoteReferenceSnapshot {
  kind: "source_quote";
  title: string;
  quote: string;
}

export interface QuestionReferenceSnapshot {
  kind: "question";
  stem: string;
  options: L3QuestionOption[];
  questionType: L3QuestionType;
  sourceTitle: string | null;
}

export interface StemQuoteReferenceSnapshot {
  kind: "stem_quote";
  quote: string;
  questionType: L3QuestionType;
  sourceTitle: string | null;
}

export interface OptionQuoteReferenceSnapshot {
  kind: "option_quote";
  optionKey: string;
  quote: string;
  questionType: L3QuestionType;
  sourceTitle: string | null;
}

/**
 * N2：评析引用快照。只放 capture 当时摘录的 `excerpt`（不含完整 contentMd），
 * 评析被覆写后它**保持不变**，状态由 `changed` 表达（D3-2）。
 */
export interface AssessmentReferenceSnapshot {
  kind: "assessment";
  excerpt: string;
  questionType: L3QuestionType;
  sourceTitle: string | null;
}

/**
 * N2 第二条链：笔记引用快照。
 *
 * 只放 capture 当时的**标题 + 正文摘录**（280 上限）。**不展开目标笔记内部引用**
 * ——快照/引用卡片/导出一律只解一层，避免递归与体积失控。
 */
export interface NoteReferenceSnapshot {
  kind: "note";
  title: string;
  excerpt: string;
}

/**
 * N2 第三条链：sheet 引用快照 = `{ scope, summaryExcerpt }`（K14）。
 *
 * **不含** `answers`、题目答案 / 解析 / evidence，也不含任何评卷字段（K7）。
 */
export interface SheetReferenceSnapshot {
  kind: "sheet";
  scope: string;
  summaryExcerpt: string;
}

/**
 * N2 第三条链：attempt 引用快照 = `{ venue, answerExcerpt }`（K14）。
 *
 * `answerExcerpt` 是 attempt 自有作答 JSON 的规范化文本截断；attempt 行不可变
 * （K12），故 `changed` 不可达。
 */
export interface AttemptReferenceSnapshot {
  kind: "attempt";
  venue: string;
  answerExcerpt: string;
}

export type ReferenceDisplaySnapshot =
  | SourceReferenceSnapshot
  | SourceQuoteReferenceSnapshot
  | QuestionReferenceSnapshot
  | StemQuoteReferenceSnapshot
  | OptionQuoteReferenceSnapshot
  | AssessmentReferenceSnapshot
  | NoteReferenceSnapshot
  | SheetReferenceSnapshot
  | AttemptReferenceSnapshot;

/** 引用预览（详情/导出/反向引用共用；不泄露 service 端 hash 与请求键）。 */
export interface ReferencePreview {
  id: string;
  target: ReferenceTarget;
  status: ReferenceStatus;
  capturedAt: string;
  displaySnapshot: ReferenceDisplaySnapshot;
  /** 目标当前标题（changed 时对照；unavailable 为 null）。 */
  liveTitle: string | null;
}

/** POST /reference-preview 的只读预览（不持久化；目标无效直接 404/422）。 */
export interface ReferenceTargetPreview {
  target: ReferenceTarget;
  /** 将生成的展示快照（与 capture 同口径；供 UI 预展示）。 */
  displaySnapshot: ReferenceDisplaySnapshot;
  liveTitle: string | null;
}

export interface StudyNoteSummary {
  id: string;
  title: string;
  venues: L3QuestionType[];
  pinned: boolean;
  status: StudyNoteStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudyNoteDto extends StudyNoteSummary {
  bodyMd: string;
  references: ReferencePreview[];
}

export interface StudyTopicDto {
  id: string;
  questionType: L3QuestionType;
  title: string;
  status: StudyTopicStatus;
  version: number;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudyPage<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

/** 目标搜索项（source kind；摘要不含正文全文）。 */
export interface StudySourceTargetItem {
  id: string;
  title: string;
  createdAt: string;
}

/** 目标搜索项（question kind；摘要不含答案/解析/evidence）。 */
export interface StudyQuestionTargetItem {
  id: string;
  stem: string;
  questionType: L3QuestionType;
  createdAt: string;
}

/** 反向引用项（按 note 去重聚合；默认不含归档）。 */
export interface StudyBacklinkItem {
  noteId: string;
  title: string;
  status: StudyNoteStatus;
  referenceCount: number;
  refIds: string[];
}

// ── 合同错误（service 收口转 422；domain 不依赖 errors 层）──────────────────

export class ReferenceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceContractError";
  }
}

// ── UUID 身份规范化（F5）────────────────────────────────────────────────────

/**
 * 合法 UUID 的身份规范化：大小写不敏感（PG 的 uuid 类型返回规范小写，
 * JS 侧比较/Map 查找/幂等键/锁键必须使用同一规范形态）。
 *
 * 边界纪律：仅在既有校验器（zod uuid / 路径参数合同 / PG 22P02）已判定
 * 合法性之后使用；本函数不新增校验，非法输入按原样返回（错误面不变）。
 * 不得用于正文、quote、optionKey 等文本字段。
 */
export function normalizeStudyUuid(value: string): string {
  return value.toLowerCase();
}

// ── marker 解析（marked 顶层 paragraph 完全相等识别）───────────────────────

const UUID_SCHEMA = z.string().uuid();
const REF_MARKER_SHAPE = /^\[\[ref:([\s\S]*)\]\]$/;

/**
 * 单个段落文本与引用标记形状的匹配结果（**单真源**：`parseReferenceIds` 与前端预览共用）：
 * - `none`：不是标记形状；
 * - `marker`：合法标记（refId 已归一为小写）；
 * - `invalid`：形如标记但内容不是合法 UUID（域合同下为错误，由调用方决定抛错或按普通文本处理）。
 */
export type ReferenceMarkerMatch =
  | { kind: "none" }
  | { kind: "marker"; refId: string }
  | { kind: "invalid" };

/** 判定「顶层 paragraph 的 text」是否为引用标记（与 parseReferenceIds 同一语义）。 */
export function matchReferenceMarkerText(text: string): ReferenceMarkerMatch {
  const match = REF_MARKER_SHAPE.exec(text);
  if (!match) return { kind: "none" };
  const parsed = UUID_SCHEMA.safeParse(match[1]);
  if (!parsed.success) return { kind: "invalid" };
  return { kind: "marker", refId: parsed.data.toLowerCase() };
}

/**
 * 解析正文中的引用标记 id（按出现顺序；合法 UUID 归一为小写）。
 * - 仅识别 marked lexer 顶层 paragraph token 且 text 完全等于标记的文本；
 * - 顶层段落形如标记但内容非法 UUID → 抛 ReferenceContractError（未知标记）；
 * - 其余位置（代码/行内代码/引用块/标题/列表/内嵌）一律按普通文本，不识别不报错。
 */
export function parseReferenceIds(bodyMd: string): string[] {
  if (typeof bodyMd !== "string" || bodyMd.length === 0) return [];
  const ids: string[] = [];
  for (const token of lexer(bodyMd)) {
    if (token.type !== "paragraph") continue;
    const text = (token as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const match = matchReferenceMarkerText(text);
    if (match.kind === "none") continue;
    if (match.kind === "invalid") {
      throw new ReferenceContractError(
        "正文中存在未知引用标记 [[ref:…]]：标记内容必须是合法 UUID",
      );
    }
    ids.push(match.refId);
  }
  return ids;
}

/**
 * 校验 marker 集合与 ReferenceWrite.id 集合完全相等且无重复（设计 §3）。
 * 缺失或多余引用、重复 marker、重复 id 均抛 ReferenceContractError。
 */
export function assertReferenceSet(
  bodyMd: string,
  references: readonly ReferenceWrite[],
): void {
  const markerIds = parseReferenceIds(bodyMd);
  const markerSet = new Set<string>();
  for (const id of markerIds) {
    if (markerSet.has(id)) {
      throw new ReferenceContractError("同一引用标记在正文中重复出现（每个引用应当只用一次）");
    }
    markerSet.add(id);
  }
  const writeSet = new Set<string>();
  for (const write of references) {
    const id = typeof write?.id === "string" ? write.id.toLowerCase() : "";
    if (writeSet.has(id)) {
      throw new ReferenceContractError("引用 id 重复");
    }
    writeSet.add(id);
  }
  for (const id of markerSet) {
    if (!writeSet.has(id)) {
      throw new ReferenceContractError("正文标记缺少对应引用（引用集合与正文不一致）");
    }
  }
  for (const id of writeSet) {
    if (!markerSet.has(id)) {
      throw new ReferenceContractError("引用缺少对应正文标记（引用集合与正文不一致）");
    }
  }
}

// ── UTF-16 锚点纯校验 ──────────────────────────────────────────────────────

/** index 是否为 UTF-16 代码单元边界（端点不得切进代理对内部）。 */
function isUtf16Boundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true;
  const prev = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  const splitsPair =
    prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  return !splitsPair;
}

/**
 * quote 必须严格等于 text.slice(start, end)（不 trim、不归一化）；
 * start/end 为非负整数、end > start、不得切进代理对内部。
 */
export function validateQuote(
  text: string,
  start: number,
  end: number,
  quote: string,
): boolean {
  if (typeof text !== "string" || typeof quote !== "string") return false;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
  if (start < 0 || end <= start || end > text.length) return false;
  if (!isUtf16Boundary(text, start) || !isUtf16Boundary(text, end)) return false;
  return text.slice(start, end) === quote;
}

// ── 输入 schema（body 契约；strict 全部收口）───────────────────────────────

const quoteFields = {
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  quote: z.string().min(1).max(STUDY_QUOTE_MAX),
};

/**
 * 引用目标（设计 §3）。严格枚举（N1 五种 + N2 评析 / 笔记 / sheet / attempt）。
 *
 * 判别式 union `.strict()`：新两型同样**不**接受其它型的字段——sheet 不得夹带
 * questionId / attemptId，attempt 不得夹带 questionId / submissionId（K5 / K9
 * 无身份兜底）。
 */
export const referenceTargetSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("source"), sourceId: z.string().uuid() }).strict(),
    z
      .object({
        kind: z.literal("source_quote"),
        sourceId: z.string().uuid(),
        ...quoteFields,
      })
      .strict(),
    z.object({ kind: z.literal("question"), questionId: z.string().uuid() }).strict(),
    z
      .object({
        kind: z.literal("stem_quote"),
        questionId: z.string().uuid(),
        ...quoteFields,
      })
      .strict(),
    z
      .object({
        kind: z.literal("option_quote"),
        questionId: z.string().uuid(),
        optionKey: z.string().min(1).max(STUDY_OPTION_KEY_MAX),
        ...quoteFields,
      })
      .strict(),
    // N2：评析——questionId 给出上下文/属主链，assessmentId 才是被引用行的身份。
    z
      .object({
        kind: z.literal("assessment"),
        questionId: z.string().uuid(),
        assessmentId: z.string().uuid(),
      })
      .strict(),
    // N2 第三条链：sheet（sealed 稿次）。revisionNo 仅 writing 稿次携带且必须 >0
    // （DB `revision_no_check` 同口径）；非 writing 省略或显式 null。
    z
      .object({
        kind: z.literal("sheet"),
        submissionId: z.string().uuid(),
        revisionNo: z.number().int().positive().nullable().optional(),
      })
      .strict(),
    // N2 第三条链：attempt（作答记录）——单值身份，不拼 question / sheet / venue。
    z.object({ kind: z.literal("attempt"), attemptId: z.string().uuid() }).strict(),
  ])
  .superRefine((value, ctx) => {
    if ("start" in value && "end" in value && value.end <= value.start) {
      ctx.addIssue({ code: "custom", message: "end 必须大于 start", path: ["end"] });
    }
  });

export const referenceWriteSchema = z
  .discriminatedUnion("action", [
    z.object({ id: z.string().uuid(), action: z.literal("keep") }).strict(),
    z
      .object({
        id: z.string().uuid(),
        action: z.literal("capture"),
        target: referenceTargetSchema,
      })
      .strict(),
  ]);

/** PUT /:noteId 保存输入（设计 §6 SaveNoteInput 的 HTTP 形态）。 */
export const saveStudyNoteSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    requestId: z.string().uuid(),
    title: z.string().max(STUDY_NOTE_TITLE_MAX),
    bodyMd: z.string().max(STUDY_NOTE_BODY_MAX),
    venues: z
      .array(z.enum(L3_QUESTION_TYPES))
      .min(1)
      .max(L3_QUESTION_TYPES.length)
      .refine((venues) => new Set(venues).size === venues.length, {
        message: "venues 不得重复",
      }),
    pinned: z.boolean(),
    status: z.enum(STUDY_NOTE_STATUSES),
    references: z.array(referenceWriteSchema).max(STUDY_REFERENCE_MAX_PER_NOTE),
  })
  .strict();

/** POST / 创建输入（幂等 requestId + 首归属题型）。 */
export const createStudyNoteSchema = z
  .object({
    requestId: z.string().uuid(),
    venue: z.enum(L3_QUESTION_TYPES),
  })
  .strict();

/** POST **专题** / 创建输入。 */
export const createStudyTopicSchema = z
  .object({
    requestId: z.string().uuid(),
    venue: z.enum(L3_QUESTION_TYPES),
    title: z.string().trim().min(1).max(STUDY_TOPIC_TITLE_MAX),
  })
  .strict();

/** PUT /:topicId 保存输入（元数据 + 归档/恢复共享版本）。 */
export const saveStudyTopicSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    title: z.string().trim().min(1).max(STUDY_TOPIC_TITLE_MAX),
    status: z.enum(STUDY_TOPIC_STATUSES),
  })
  .strict();

/** PUT /:topicId/members/:noteId —— 加入或移动（beforeNoteId=null 表示移到末尾）。 */
export const moveStudyTopicMemberSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    beforeNoteId: z.string().uuid().nullable(),
  })
  .strict();

/** DELETE /:topicId/members/:noteId 的 JSON body。 */
export const removeStudyTopicMemberSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
  })
  .strict();
