/**
 * 作文子空间 v1 HTTP 响应契约（W6，ADR《writing-workspace》§6）——S§6 逐端点形状。
 *
 * DTO 为 camelCase（domain 显式映射，不暴露 DB row）；`.strict()` fail-closed；
 * 所有响应经 operations 注册表中间件按本契约运行时校验。
 * 与 W1 `sheetAnswerSchema` 无关：作文正文契约是专用 `writingDraftInputSchema`。
 */
import { z } from "zod";
import {
  WRITING_DIRECTIONS,
  WRITING_KINDS,
  writingFeedbackSchema,
} from "@/domain/l3-writing";

const writingKindSchema = z.enum(WRITING_KINDS);
const writingDirectionSchema = z.enum(WRITING_DIRECTIONS);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** WritingTaskDto（题面引用式：prompt 来自 question.stem）。 */
export const l3WritingTaskResponseSchema = z.object({
  id: z.string().uuid(),
  questionId: z.string().uuid(),
  title: z.string(),
  prompt: z.string(),
  kind: writingKindSchema,
  direction: writingDirectionSchema,
  status: z.enum(["active", "archived"]),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

/** WritingSheetDto（稿次；draft/sealed/discarded）。 */
export const l3WritingSheetResponseSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  status: z.enum(["draft", "sealed", "discarded"]),
  draftVersion: z.number().int().nonnegative(),
  revisionNo: z.number().int().positive().nullable(),
  parentSheetId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sealedAt: z.string().nullable(),
}).strict();

/** WritingFeedbackRecord（feedback 结构按 S§5 逐字段强校验）。 */
export const l3WritingFeedbackRecordResponseSchema = z.object({
  feedback: writingFeedbackSchema,
  version: z.number().int().positive(),
  textSha256: sha256Schema,
  lastEditor: z.string().min(1).max(64),
  updatedAt: z.string(),
}).strict();

/** POST /tasks：201 新建 / 200 复用（draft 可为 null——复用已提交且无草稿任务）。 */
export const l3WritingTaskCreateResponseSchema = z.object({
  task: l3WritingTaskResponseSchema,
  draft: l3WritingSheetResponseSchema.nullable(),
  created: z.boolean(),
}).strict();

const l3WritingTaskSummaryResponseSchema = z.object({
  task: l3WritingTaskResponseSchema.omit({ prompt: true }),
  draftSheetId: z.string().uuid().nullable(),
  lastSheetId: z.string().uuid().nullable(),
  latestRevisionNo: z.number().int().positive().nullable(),
}).strict();

/** GET /tasks（keyset 分页；summary 不含正文与题面全文——题面在 detail）。 */
export const l3WritingTaskListResponseSchema = z.object({
  items: z.array(l3WritingTaskSummaryResponseSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
}).strict();

/** GET /tasks/:taskId。 */
export const l3WritingTaskDetailResponseSchema = z.object({
  task: l3WritingTaskResponseSchema,
  draftSummary: l3WritingSheetResponseSchema.nullable(),
  revisionCount: z.number().int().nonnegative(),
  latestSubmittedSheetId: z.string().uuid().nullable(),
}).strict();

const l3WritingRevisionSummaryResponseSchema = z.object({
  sheet: l3WritingSheetResponseSchema,
  contentStatus: z.enum(["available", "cleared"]),
  feedbackState: z.enum(["pending", "ready", "unavailable"]),
}).strict();

/** GET /tasks/:taskId/revisions（sealed/discarded 历史）。 */
export const l3WritingRevisionListResponseSchema = z.object({
  items: z.array(l3WritingRevisionSummaryResponseSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
}).strict();

/** GET /tasks/:taskId/sheets/:sheetId（含反馈组合；cleared=占位语义）。 */
export const l3WritingSheetDetailResponseSchema = z.object({
  sheet: l3WritingSheetResponseSchema,
  text: z.string().nullable(),
  textSha256: sha256Schema.nullable(),
  wordCount: z.number().int().nonnegative(),
  contentStatus: z.enum(["available", "cleared"]),
  feedback: l3WritingFeedbackRecordResponseSchema.nullable(),
}).strict();

/** POST /tasks/:taskId/drafts（201 新建 / 200 复用同 parent 草稿）。 */
export const l3WritingDraftCreateResponseSchema = z.object({
  sheet: l3WritingSheetResponseSchema,
  created: z.boolean(),
}).strict();

/** PATCH /tasks/:taskId/sheets/:sheetId（CAS 保存回执）。 */
export const l3WritingSaveResponseSchema = z.object({
  sheet: l3WritingSheetResponseSchema,
  textSha256: sha256Schema,
}).strict();

/** POST /tasks/:taskId/sheets/:sheetId/submit（幂等：重放返回同 attemptId）。 */
export const l3WritingSubmitResponseSchema = z.object({
  sheet: l3WritingSheetResponseSchema,
  attemptId: z.string().uuid(),
}).strict();

/** GET /tasks/:taskId/sheets/:sheetId/feedback（pending=尚无反馈，正常态）。 */
export const l3WritingFeedbackGetResponseSchema = z.object({
  state: z.enum(["pending", "ready"]),
  feedback: l3WritingFeedbackRecordResponseSchema.nullable(),
}).strict();

/** GET /tasks/:taskId/sheets/:sheetId/feedback-context（agent 面；只含指定稿）。 */
export const l3WritingFeedbackContextResponseSchema = z.object({
  taskId: z.string().uuid(),
  sheetId: z.string().uuid(),
  revisionNo: z.number().int().positive(),
  kind: writingKindSchema,
  direction: writingDirectionSchema,
  prompt: z.string(),
  text: z.string(),
  textSha256: sha256Schema,
  wordCount: z.number().int().nonnegative(),
  /** 0 = 尚未有反馈（与首次提交 expectedVersion=0 一致）。 */
  feedbackVersion: z.number().int().nonnegative(),
  feedbackSchemaVersion: z.number().int().positive(),
}).strict();

/** PUT /tasks/:taskId/sheets/:sheetId/feedback（owner/agent；lastEditor 服务端认定）。 */
export const l3WritingFeedbackPutResponseSchema = l3WritingFeedbackRecordResponseSchema;
