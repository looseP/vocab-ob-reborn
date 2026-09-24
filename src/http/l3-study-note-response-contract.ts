/**
 * 学习笔记（N1）HTTP 响应契约——设计 §7 逐端点形状。
 *
 * DTO camelCase、`.strict()` fail-closed；所有响应经 operations 注册表
 * 按本契约运行时校验（同一 schema 兼作 OpenAPI 文档源）。
 * 引用 target/快照的判别式 union 与 domain 输入侧同构（响应不出现 userId/hash）。
 */
import { z } from "zod";
import { L3_QUESTION_TYPES } from "@/domain/l3-question-types";
import {
  REFERENCE_STATUSES,
  STUDY_NOTE_STATUSES,
  STUDY_TOPIC_STATUSES,
} from "@/domain/l3-study-notes";

const venueSchema = z.enum(L3_QUESTION_TYPES);

// ── 引用 target / 展示快照（判别式 union）──────────────────────────────────

const referenceTargetResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), sourceId: z.string().uuid() }).strict(),
  z.object({
    kind: z.literal("source_quote"),
    sourceId: z.string().uuid(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string(),
  }).strict(),
  z.object({ kind: z.literal("question"), questionId: z.string().uuid() }).strict(),
  z.object({
    kind: z.literal("stem_quote"),
    questionId: z.string().uuid(),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("option_quote"),
    questionId: z.string().uuid(),
    optionKey: z.string().min(1).max(8),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    quote: z.string(),
  }).strict(),
  // N2：评析——assessmentId 才是被引用行的身份，questionId 给上下文。
  z.object({
    kind: z.literal("assessment"),
    questionId: z.string().uuid(),
    assessmentId: z.string().uuid(),
  }).strict(),
  // N2 第二条链：笔记互链——noteId 即目标笔记身份（不按标题/序号兜底）。
  z.object({
    kind: z.literal("note"),
    noteId: z.string().uuid(),
  }).strict(),
  // N2 第三条链：sheet = sealed 稿次；revisionNo 显式可空（writing 稿次为 >0 整数）。
  z.object({
    kind: z.literal("sheet"),
    submissionId: z.string().uuid(),
    revisionNo: z.number().int().positive().nullable(),
  }).strict(),
  // N2 第三条链：attempt = 作答记录，单值身份（K9）。
  z.object({
    kind: z.literal("attempt"),
    attemptId: z.string().uuid(),
  }).strict(),
]);

const optionSchema = z.object({ key: z.string(), text: z.string() }).strict();

const referenceDisplaySnapshotSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source"), title: z.string(), excerpt: z.string() }).strict(),
  z.object({ kind: z.literal("source_quote"), title: z.string(), quote: z.string() }).strict(),
  z.object({
    kind: z.literal("question"),
    stem: z.string(),
    options: z.array(optionSchema),
    questionType: venueSchema,
    sourceTitle: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal("stem_quote"),
    quote: z.string(),
    questionType: venueSchema,
    sourceTitle: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal("option_quote"),
    optionKey: z.string().min(1).max(8),
    quote: z.string(),
    questionType: venueSchema,
    sourceTitle: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal("assessment"),
    excerpt: z.string(),
    questionType: venueSchema,
    sourceTitle: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal("note"),
    title: z.string(),
    excerpt: z.string(),
  }).strict(),
  // N2 第三条链：稿次快照只有 scope + 小结摘录（不含 answers / 评卷字段，K7 / K14）。
  z.object({
    kind: z.literal("sheet"),
    scope: z.string(),
    summaryExcerpt: z.string(),
  }).strict(),
  // N2 第三条链：作答快照只有 venue + 作答摘录。
  z.object({
    kind: z.literal("attempt"),
    venue: z.string(),
    answerExcerpt: z.string(),
  }).strict(),
]);

/** 引用预览（详情/反向引用共用）。 */
export const l3ReferencePreviewResponseSchema = z.object({
  id: z.string().uuid(),
  target: referenceTargetResponseSchema,
  status: z.enum(REFERENCE_STATUSES),
  capturedAt: z.string(),
  displaySnapshot: referenceDisplaySnapshotSchema,
  liveTitle: z.string().nullable(),
}).strict();

// ── 笔记 ───────────────────────────────────────────────────────────────────

const studyNoteSummaryResponseSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  venues: z.array(venueSchema),
  pinned: z.boolean(),
  status: z.enum(STUDY_NOTE_STATUSES),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

/** StudyNoteDto（详情：含正文与引用预览）。 */
export const l3StudyNoteResponseSchema = studyNoteSummaryResponseSchema.extend({
  bodyMd: z.string(),
  references: z.array(l3ReferencePreviewResponseSchema),
}).strict();

/** POST /（201 新建 / 200 幂等复用）。 */
export const l3StudyNoteCreateResponseSchema = z.object({
  item: l3StudyNoteResponseSchema,
  created: z.boolean(),
}).strict();

/** GET /:noteId 与 PUT /:noteId。 */
export const l3StudyNoteItemResponseSchema = z.object({
  item: l3StudyNoteResponseSchema,
}).strict();

/** GET /（keyset 分页；summary 不含正文与引用）。 */
export const l3StudyNoteListResponseSchema = z.object({
  items: z.array(studyNoteSummaryResponseSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
}).strict();

// ── 专题 ───────────────────────────────────────────────────────────────────

export const l3StudyTopicResponseSchema = z.object({
  id: z.string().uuid(),
  questionType: venueSchema,
  title: z.string().min(1),
  status: z.enum(STUDY_TOPIC_STATUSES),
  version: z.number().int().positive(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export const l3StudyTopicCreateResponseSchema = z.object({
  item: l3StudyTopicResponseSchema,
  created: z.boolean(),
}).strict();

export const l3StudyTopicItemResponseSchema = z.object({
  item: l3StudyTopicResponseSchema,
}).strict();

export const l3StudyTopicListResponseSchema = z.object({
  items: z.array(l3StudyTopicResponseSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
}).strict();

// ── 引用目标搜索 / 只读预览 / 反向引用 ─────────────────────────────────────

const sourceTargetItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  createdAt: z.string(),
}).strict();

const questionTargetItemSchema = z.object({
  id: z.string().uuid(),
  stem: z.string(),
  questionType: venueSchema,
  createdAt: z.string(),
}).strict();

/** GET /reference-targets（单 kind 摘要；判别式 union 与查询 kind 一致）。 */
export const l3ReferenceTargetListResponseSchema = z.object({
  items: z.array(z.union([sourceTargetItemSchema, questionTargetItemSchema])),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
}).strict();

/** POST /reference-preview（只读；目标无效直接 404/422，不走 200 空对象）。 */
export const l3ReferenceTargetPreviewResponseSchema = z.object({
  preview: z.object({
    target: referenceTargetResponseSchema,
    displaySnapshot: referenceDisplaySnapshotSchema,
    liveTitle: z.string().nullable(),
  }).strict(),
}).strict();

/** GET /backlinks（按 note 去重聚合）。 */
export const l3StudyBacklinkListResponseSchema = z.object({
  items: z.array(z.object({
    noteId: z.string().uuid(),
    title: z.string(),
    status: z.enum(STUDY_NOTE_STATUSES),
    referenceCount: z.number().int().nonnegative(),
    refIds: z.array(z.string().uuid()),
  }).strict()),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
}).strict();
