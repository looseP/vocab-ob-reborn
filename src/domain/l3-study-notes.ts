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

// ── 枚举（单一真源；与 DB CHECK 同步）───────────────────────────────────────

export const STUDY_NOTE_STATUSES = ["active", "archived"] as const;
export type StudyNoteStatus = (typeof STUDY_NOTE_STATUSES)[number];

export const STUDY_TOPIC_STATUSES = ["active", "archived"] as const;
export type StudyTopicStatus = (typeof STUDY_TOPIC_STATUSES)[number];

/** 五种引用严格枚举（N1 不预留可任意写 JSON 的后门）。 */
export const REFERENCE_KINDS = [
  "source",
  "source_quote",
  "question",
  "stem_quote",
  "option_quote",
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

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
    };

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

export type ReferenceDisplaySnapshot =
  | SourceReferenceSnapshot
  | SourceQuoteReferenceSnapshot
  | QuestionReferenceSnapshot
  | StemQuoteReferenceSnapshot
  | OptionQuoteReferenceSnapshot;

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

// ── marker 解析（marked 顶层 paragraph 完全相等识别）───────────────────────

const UUID_SCHEMA = z.string().uuid();
const REF_MARKER_SHAPE = /^\[\[ref:([\s\S]*)\]\]$/;

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
    const match = REF_MARKER_SHAPE.exec(text);
    if (!match) continue;
    const parsed = UUID_SCHEMA.safeParse(match[1]);
    if (!parsed.success) {
      throw new ReferenceContractError(
        "正文中存在未知引用标记 [[ref:…]]：标记内容必须是合法 UUID",
      );
    }
    ids.push(parsed.data.toLowerCase());
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
 * 引用目标（设计 §3）。五种 kind 严格枚举：
 * source / source_quote / question / stem_quote / option_quote。
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
