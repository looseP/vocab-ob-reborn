import { z, type ZodType } from "zod";
import {
  l3CapabilitiesResponseSchema,
  l3ContextCreateResponseSchema,
  l3ContextDetailResponseSchema,
  l3ContextLinkCreateResponseSchema,
  l3ContextLinkListResponseSchema,
  l3ContextListResponseSchema,
  l3DeleteResponseSchema,
  l3GraphResponseSchema,
  l3ImportProposalResponseSchema,
  l3OccurrenceCreateResponseSchema,
  l3OccurrenceListResponseSchema,
  l3ProposalBundleResponseSchema,
  l3ProposalConfirmResponseSchema,
  l3ProposalListResponseSchema,
  l3ProposalValidationResponseSchema,
  l3QuickContextResponseSchema,
  l3RecommendationAcceptResponseSchema,
  l3RecommendationBundleResponseSchema,
  l3RecommendationDetailResponseSchema,
  l3RecommendationItemResponseSchema,
  l3RecommendationListResponseSchema,
  l3SelectionCaptureResponseSchema,
  l3SourceCreateResponseSchema,
  l3SourceListResponseSchema,
  l3SourceSpaceResponseSchema,
  l3SourceSpacesReplaceResponseSchema,
  l3WordSpaceResponseSchema,
} from "./l3-response-contract";
import { l3SpaceSummaryResponseSchema } from "./l3-summary-response-contract";
import {
  l3PaperCreateResponseSchema,
  l3PaperUpdateResponseSchema,
  l3PaperDetailResponseSchema,
  l3PaperListResponseSchema,
  l3PracticeFileDetailResponseSchema,
  l3PracticeFileListResponseSchema,
  l3QuestionCreateResponseSchema,
  l3QuestionUpdateResponseSchema,
  l3QuestionDeleteResponseSchema,
  l3PendingQuestionListResponseSchema,
  l3QuestionAcceptResponseSchema,
} from "./l3-paper-response-contract";
import {
  l3AnnotationTagDictResponseSchema,
  l3QuestionAnnotationItemResponseSchema,
  l3QuestionAnnotationListResponseSchema,
} from "./l3-annotation-response-contract";
import { l3UnifiedErrorBookResponseSchema } from "./l3-error-book-response-contract";
import {
  l3AttemptListResponseSchema,
  l3SheetDetailResponseSchema,
  l3SheetItemResponseSchema,
  l3SheetListResponseSchema,
  l3SheetSealResponseSchema,
} from "./l3-sheet-response-contract";
import { l3AssessmentItemResponseSchema } from "./l3-assessment-response-contract";
import {
  l3GradingContextResponseSchema,
  l3GradingResultsResponseSchema,
  l3GradingSubmitResponseSchema,
} from "./l3-grading-response-contract";
import {
  l3WritingDraftCreateResponseSchema,
  l3WritingFeedbackContextResponseSchema,
  l3WritingFeedbackGetResponseSchema,
  l3WritingFeedbackPutResponseSchema,
  l3WritingRevisionListResponseSchema,
  l3WritingQuestionSummariesResponseSchema,
  l3WritingSaveResponseSchema,
  l3WritingSheetDetailResponseSchema,
  l3WritingSheetResponseSchema,
  l3WritingSubmitResponseSchema,
  l3WritingTaskCreateResponseSchema,
  l3WritingTaskDetailResponseSchema,
  l3WritingTaskListResponseSchema,
  l3WritingTaskResponseSchema,
} from "./l3-writing-response-contract";
import {
  l3ReferenceTargetListResponseSchema,
  l3ReferenceTargetPreviewResponseSchema,
  l3StudyBacklinkListResponseSchema,
  l3StudyNoteCreateResponseSchema,
  l3StudyNoteItemResponseSchema,
  l3StudyNoteListResponseSchema,
  l3StudyTopicCreateResponseSchema,
  l3StudyTopicItemResponseSchema,
  l3StudyTopicListResponseSchema,
} from "./l3-study-note-response-contract";
import {
  upgradeWorkOrderCompleteResponseSchema,
  upgradeWorkOrderListResponseSchema,
  upgradeWorkOrderMarkResponseSchema,
  upgradeWorkOrderRowResponseSchema,
} from "./upgrade-work-order-response-contract";
import {
  l3PracticeAttemptPageResponseSchema,
  l3PracticeAttemptRowResponseSchema,
  l3PracticeErrorBookPageResponseSchema,
} from "./l3-practice-response-contract";
import {
  l3SessionRenderDescriptionResponseSchema,
  l3SessionRowResponseSchema,
} from "./l3-session-response-contract";
import {
  forgettingApplyResponseSchema,
  forgettingPreviewResponseSchema,
  forgettingRestoreResponseSchema,
} from "./forgetting-response-contract";
import {
  reviewAnswerResponseSchema,
  reviewDashboardStatsResponseSchema,
  reviewDrillQueueResponseSchema,
  reviewEnqueueCardResponseSchema,
  reviewEnqueueCardsBatchResponseSchema,
  reviewHeatmapResponseSchema,
  reviewLeechesResponseSchema,
  reviewQueueResponseSchema,
  reviewSimpleResponseSchema,
  reviewStatsResponseSchema,
  reviewTimelineResponseSchema,
} from "./review-response-contract";
import {
  noteEntryDeleteResponseSchema,
  noteEntryMutationResponseSchema,
  noteListResponseSchema,
  wordNoteEntriesResponseSchema,
  wordbookDefaultResponseSchema,
  wordbookListResponseSchema,
} from "./note-wordbook-response-contract";
import {
  wordBatchCreateResponseSchema,
  wordDetailResponseSchema,
  wordListResponseSchema,
  wordSuggestResponseSchema,
} from "./words-response-contract";
import {
  plazaCollectionResponseSchema,
  plazaOverviewResponseSchema,
  plazaRootsResponseSchema,
  plazaReviewStatsResponseSchema,
  rootCollectionDetailResponseSchema,
} from "./plaza-response-contract";
import {
  l2ConfirmResponseSchema,
  l2DraftResponseSchema,
  l2ExternalPromptResponseSchema,
  l2LlmStatusResponseSchema,
  l2PromoteResponseSchema,
  l2CandidatesResponseSchema,
  l2CandidateAcceptResponseSchema,
  l2CandidateRejectResponseSchema,
  l2CandidateProposeResponseSchema,
  l2ContentRowsResponseSchema,
  l2ContentRowMutateResponseSchema,
  l2ContentRowItemRemoveResponseSchema,
  l2ContentRowItemHideResponseSchema,
  l2ContentRowItemRestoreResponseSchema,
} from "./l2-response-contract";
import {
  l2DrillQueueResponseSchema,
  l2SelfAssessResponseSchema,
  l2TaskAnswerResponseSchema,
  l2UndoResponseSchema,
} from "./l2-drill-response-contract";
import { captureResponseSchema } from "./capture-response-contract";
import { vocabNotesImportResponseSchema } from "./import-response-contract";
import { operationMetricsResponseSchema } from "./operation-metrics-response-contract";
import {
  l3ContextCreateSchema,
  l3ContextLinkCreateSchema,
  l3ContextLinkListQuerySchema,
  l3GraphQuerySchema,
  l3LimitCursorQuerySchema,
  l3OccurrenceCreateSchema,
  l3OccurrenceListQuerySchema,
  l3PaperCreateSchema,
  l3PaperUpdateSchema,
  l3PaperListQuerySchema,
  l3PracticeFileDetailQuerySchema,
  l3PracticeFileListQuerySchema,
  l3QuestionCreateSchema,
  l3QuestionUpdateSchema,
  l3QuestionAnnotationCreateSchema,
  l3QuestionAnnotationListQuerySchema,
  l3PendingQuestionListQuerySchema,
  l3QuestionAcceptBatchSchema,
  l3QuestionAnnotationPatchSchema,
  l3QuestionAnnotationWithdrawSchema,
  l3AnnotationTagDictSchema,
  l3SheetOpenSchema,
  l3SheetPatchSchema,
  l3SheetSealSchema,
  l3SheetListQuerySchema,
  l3AttemptListQuerySchema,
  l3AssessmentUpsertSchema,
  l3GradingSubmitSchema,
  l3SheetExportQuerySchema,
  l3WritingTaskCreateSchema,
  l3WritingTaskRenameSchema,
  l3WritingTaskListQuerySchema,
  l3WritingRevisionListQuerySchema,
  l3WritingQuestionSummariesQuerySchema,
  l3WritingDraftCreateSchema,
  l3WritingDraftSaveSchema,
  l3WritingSubmitSchema,
  l3WritingFeedbackPutSchema,
  l3StudyNoteCreateSchema,
  l3StudyNoteSaveSchema,
  l3StudyNoteListQuerySchema,
  l3StudyTopicCreateSchema,
  l3StudyTopicSaveSchema,
  l3StudyTopicListQuerySchema,
  l3StudyTopicMemberMoveSchema,
  l3StudyTopicMemberRemoveSchema,
  l3StudyReferenceTargetSchema,
  l3StudyReferenceTargetQuerySchema,
  l3StudyBacklinkQuerySchema,
  l3StudyNoteExportQuerySchema,
  l3ProposalCreateSchema,
  l3ProposalListQuerySchema,
  l3ProposalRejectSchema,
  l3RawTextImportCreateSchema,
  l3RecommendationGenerateSchema,
  l3RecommendationListQuerySchema,
  l3RecommendationRejectSchema,
  l3SourceCreateSchema,
  l3SelectionCaptureSchema,
  l3SourceListQuerySchema,
  l3SourceSpaceQuerySchema,
  l3SourceSpacesReplaceSchema,
  l3SpaceSummaryQuerySchema,
  l3StructuredImportCreateSchema,
  l3WordContextListQuerySchema,
  l3WordSpaceQuerySchema,
  quickL3ContextSchema,
  reviewAnswerSchema,
  reviewSkipSchema,
  reviewSuspendSchema,
  reviewUndoSchema,
  clearL1WeakSignalSchema,
  addToReviewSchema,
  batchAddToReviewSchema,
  captureRequestSchema,
  vocabNotesImportRequestSchema,
  wordBatchCreateSchema,
  wordsQuerySchema,
  wordSuggestQuerySchema,
  plazaQuerySchema,
  plazaRootsQuerySchema,
  l2TaskAnswerSchema,
  l2SelfAssessSchema,
  l2UndoSchema,
  noteEntryUpsertRequestSchema,
  directionSchema,
  upgradeWorkOrderCreateSchema,
  upgradeWorkOrderListQuerySchema,
  l3PracticeAttemptCreateSchema,
  l3PracticeAttemptListQuerySchema,
  l3ErrorBookQuerySchema,
  l3PracticeErrorBookQuerySchema,
  l3SessionCreateSchema,
  l3SessionEndSchema,
  forgettingPreviewQuerySchema,
  forgettingApplySchema,
  forgettingRestoreSchema,
} from "../schemas/http";

export type HttpMethod = "delete" | "get" | "patch" | "post" | "put";

export type ApiAuthPolicy = "metrics" | "optionalSession" | "owner" | "public";
/**
 * 运行时最小角色（ADR-0029 决策 1/2）—— `/api/*` 鉴权的**唯一执行真源**。
 *
 * 词汇分层（雷一前置工程）：本枚举刻意**不含 agent 之外的传输细节**，
 * 且与 `ApiAuthPolicy` 各司其职：
 * - `auth` 只喂 OpenAPI 文档生成（security scheme 描述）；
 * - `minRole` 只喂运行时中间件（`src/http/middleware/api-authorization.ts`）。
 * 两个字段各自只有一个消费者，靠 `authorization-registry.test.ts` 的一致性契约与
 * 消费者断言（openapi.ts 只读 `auth`；运行时中间件只读 `minRole`）钉住。
 *
 * 阶梯为 public < agent < owner（见 `src/http/middleware/auth.ts` 的 roleRank）。
 */
export type ApiMinRole = "public" | "agent" | "owner";
export type ApiCsrfPolicy = "none" | "sessionMutation";

export interface ApiRequestHeader {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface ApiResponseHeader {
  readonly name: string;
  readonly description: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface ApiOperation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
  /** OpenAPI security scheme 描述；**不承载执行语义**。 */
  readonly auth: ApiAuthPolicy;
  /** 运行时最小角色；`/api/*` 中间件据此与 `principal.role` 比较。 */
  readonly minRole: ApiMinRole;
  readonly csrf: ApiCsrfPolicy;
  readonly requestHeaders?: readonly ApiRequestHeader[];
  readonly responseHeaders?: Readonly<Record<number, readonly ApiResponseHeader[]>>;
  readonly request?: {
    readonly body?: ZodType;
    readonly query?: ZodType;
  };
  readonly response: {
    readonly status: number;
    readonly schema: ZodType;
    readonly mediaType: "application/json" | "text/plain" | "text/markdown";
  };
}

const jsonResponseSchema = z.unknown();
export const apiErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  requestId: z.string(),
}).passthrough();
const livenessResponseSchema = z.object({ status: z.literal("ok") });
const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.string(),
  phase: z.string(),
});
const readinessResponseSchema = z.object({ status: z.string() }).passthrough();
const authSessionCreatedSchema = z.object({
  authenticated: z.literal(true),
  actorId: z.string(),
  role: z.string(),
  expiresAt: z.string(),
  csrfToken: z.string(),
});
const authSessionSchema = z.object({
  authenticated: z.literal(true),
  actorId: z.string(),
  role: z.string(),
  authMethod: z.string(),
});
const authSessionCreateSchema = z.object({ ownerToken: z.string().min(1) });
const cacheControlHeader: ApiResponseHeader = {
  name: "Cache-Control",
  description: "Prevents authentication state from being cached.",
  schema: { type: "string" },
};
const setCookieHeader: ApiResponseHeader = {
  name: "Set-Cookie",
  description: "Sets or clears the session and CSRF cookies.",
  schema: { type: "string" },
};
const retryAfterHeader: ApiResponseHeader = {
  name: "Retry-After",
  description: "Seconds before another authentication attempt.",
  schema: { type: "integer", minimum: 1 },
};
const originHeader: ApiRequestHeader = {
  name: "Origin",
  required: true,
  description: "Must match the configured application origin.",
  schema: { type: "string", format: "uri" },
};
const requestedWithHeader: ApiRequestHeader = {
  name: "X-Requested-With",
  required: true,
  description: "Must equal VocabObservatory.",
  schema: { type: "string", const: "VocabObservatory" },
};

const l2FieldRequestSchema = z.object({
  field: z.enum(["collocation", "example", "corpus", "synonym", "antonym"]),
  styleProfileId: z.string().optional(),
  userInstruction: z.string().optional(),
  // ADR-0017 §2：方向变体（升级工作台从工单注入）。显式声明是为了
  // openapi 可见——运行时路由层自行解析校验（l2.ts parseDraftOptions）。
  direction: directionSchema.optional(),
}).passthrough();
const reviewQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  mode: z.enum(["review", "cram", "preview"]).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const reviewLeechesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const reviewTimelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const reviewHeatmapQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(730).optional(),
});
const noteListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const l2ConfirmRequestSchema = l2FieldRequestSchema.extend({
  content: z.unknown().optional(),
  items: z.array(z.unknown()).optional(),
  document: z.unknown().optional(),
  source: z.string().optional(),
  sourceRef: z.string().nullable().optional(),
});
const l2CandidateProposeRequestSchema = l2ConfirmRequestSchema;

function operation(
  method: HttpMethod,
  path: string,
  operationId: string,
  auth: ApiAuthPolicy,
  minRole: ApiMinRole,
  csrf: ApiCsrfPolicy,
  request?: ApiOperation["request"],
  status = 200,
  responseSchema: ZodType = jsonResponseSchema,
  mediaType: "application/json" | "text/plain" | "text/markdown" = "application/json",
  contract?: Pick<ApiOperation, "requestHeaders" | "responseHeaders">,
): ApiOperation {
  return {
    method,
    path,
    operationId,
    auth,
    minRole,
    csrf,
    ...(contract ?? {}),
    ...(request ? { request } : {}),
    response: { status, schema: responseSchema, mediaType },
  };
}

export const apiOperations = [
  operation("get", "/healthz", "getLiveness", "public", "public", "none", undefined, 200, livenessResponseSchema),
  operation("get", "/health", "getHealth", "public", "public", "none", undefined, 200, healthResponseSchema),
  operation("get", "/readyz", "getReadiness", "public", "public", "none", undefined, 200, readinessResponseSchema),
  // /metrics 走独立 bearer（METRICS_BEARER_TOKEN），不进 /api/* 的角色查找表；
  // minRole 填 owner 表示"不经角色阶梯公开"，不参与运行时判定。
  operation("get", "/metrics", "getPrometheusMetrics", "metrics", "owner", "none", undefined, 200, z.string(), "text/plain"),
  operation("post", "/api/auth/session", "createAuthSession", "public", "public", "none", { body: authSessionCreateSchema }, 201, authSessionCreatedSchema, "application/json", {
    requestHeaders: [originHeader, requestedWithHeader],
    responseHeaders: {
      201: [cacheControlHeader, setCookieHeader],
      429: [cacheControlHeader, retryAfterHeader],
    },
  }),
  // /api/auth 是唯一在全局 /api/* 中间件之前挂载的豁免组；GET session 的 owner 门禁
  // 由路由内部自持，故这里 minRole 记 owner（auth 态探针，非语料读面）。
  operation("get", "/api/auth/session", "getAuthSession", "owner", "owner", "none", undefined, 200, authSessionSchema),
  operation("delete", "/api/auth/session", "deleteAuthSession", "optionalSession", "public", "sessionMutation", undefined, 204, z.null()),
  operation("get", "/api/operations/metrics", "getOperationMetrics", "owner", "owner", "none", undefined, 200, operationMetricsResponseSchema),
  operation("get", "/api/words", "listWords", "owner", "agent", "none", { query: wordsQuerySchema }, 200, wordListResponseSchema),
  operation("get", "/api/words/suggest", "suggestWords", "owner", "agent", "none", { query: wordSuggestQuerySchema }, 200, wordSuggestResponseSchema),
  operation("get", "/api/words/:slug", "getWord", "owner", "agent", "none", undefined, 200, wordDetailResponseSchema),
  // 详情页硬删 stub 词条（0023）：sessionMutation + owner，409 blockers 由 service 层抛出
  operation("delete", "/api/words/:slug", "deleteStubWord", "owner", "owner", "sessionMutation", undefined, 200, l3DeleteResponseSchema),
  operation("post", "/api/words/batch", "batchCreateWords", "owner", "owner", "sessionMutation", { body: wordBatchCreateSchema }, 200, wordBatchCreateResponseSchema),
  // 笔记条目(条目制 2026-09-06):GET 词条目列表;POST 新增;PUT 编辑;
  // DELETE 硬删(详情页专属);hide/restore 非破坏管理。
  operation("get", "/api/words/:slug/notes", "getWordNoteEntries", "owner", "agent", "none", undefined, 200, wordNoteEntriesResponseSchema),
  operation("post", "/api/words/:slug/notes/entries", "createWordNoteEntry", "owner", "owner", "sessionMutation", { body: noteEntryUpsertRequestSchema }, 201, noteEntryMutationResponseSchema),
  operation("put", "/api/words/:slug/notes/entries/:entryId", "updateWordNoteEntry", "owner", "owner", "sessionMutation", { body: noteEntryUpsertRequestSchema }, 200, noteEntryMutationResponseSchema),
  operation("delete", "/api/words/:slug/notes/entries/:entryId", "deleteWordNoteEntry", "owner", "owner", "sessionMutation", undefined, 200, noteEntryDeleteResponseSchema),
  operation("post", "/api/words/:slug/notes/entries/:entryId/hide", "hideWordNoteEntry", "owner", "owner", "sessionMutation", undefined, 200, noteEntryMutationResponseSchema),
  operation("post", "/api/words/:slug/notes/entries/:entryId/restore", "restoreWordNoteEntry", "owner", "owner", "sessionMutation", undefined, 200, noteEntryMutationResponseSchema),
  operation("get", "/api/plaza", "getPlazaOverview", "owner", "agent", "none", { query: plazaQuerySchema }, 200, plazaOverviewResponseSchema),
  operation("get", "/api/plaza/collections/:slug", "getPlazaCollection", "owner", "agent", "none", undefined, 200, plazaCollectionResponseSchema),
  operation("get", "/api/plaza/roots", "getPlazaRootsOverview", "owner", "agent", "none", { query: plazaRootsQuerySchema }, 200, plazaRootsResponseSchema),
  operation("get", "/api/plaza/roots/:slug", "getPlazaRootCollection", "owner", "agent", "none", undefined, 200, rootCollectionDetailResponseSchema),
  operation("get", "/api/plaza/review-stats/:slug", "getPlazaReviewStats", "owner", "agent", "none", undefined, 200, plazaReviewStatsResponseSchema),
  operation("get", "/api/notes", "listNotes", "owner", "agent", "none", { query: noteListQuerySchema }, 200, noteListResponseSchema),
  operation("get", "/api/wordbooks", "listWordbooks", "owner", "agent", "none", undefined, 200, wordbookListResponseSchema),
  // 语义上是"取默认词书"，实现为 get-or-create；agent 触发的默认词书创建是无害的按需初始化。
  operation("get", "/api/wordbooks/default", "getOrCreateDefaultWordbook", "owner", "agent", "none", undefined, 200, wordbookDefaultResponseSchema),
  operation("get", "/api/review/queue", "getReviewQueue", "owner", "agent", "none", { query: reviewQueueQuerySchema }, 200, reviewQueueResponseSchema),
  operation("get", "/api/review/stats", "getReviewStats", "owner", "agent", "none", undefined, 200, reviewStatsResponseSchema),
  operation("get", "/api/review/stats/dashboard", "getReviewDashboardStats", "owner", "agent", "none", undefined, 200, reviewDashboardStatsResponseSchema),
  operation("get", "/api/review/leeches", "listReviewLeeches", "owner", "agent", "none", { query: reviewLeechesQuerySchema }, 200, reviewLeechesResponseSchema),
  operation("get", "/api/review/timeline", "listReviewTimeline", "owner", "agent", "none", { query: reviewTimelineQuerySchema }, 200, reviewTimelineResponseSchema),
  operation("get", "/api/review/heatmap", "getReviewHeatmap", "owner", "agent", "none", { query: reviewHeatmapQuerySchema }, 200, reviewHeatmapResponseSchema),
  operation("post", "/api/review/answer", "submitReviewAnswer", "owner", "owner", "sessionMutation", { body: reviewAnswerSchema }, 200, reviewAnswerResponseSchema),
  operation("post", "/api/review/skip", "skipReview", "owner", "owner", "sessionMutation", { body: reviewSkipSchema }, 200, reviewSimpleResponseSchema),
  operation("post", "/api/review/suspend", "suspendReview", "owner", "owner", "sessionMutation", { body: reviewSuspendSchema }, 200, reviewSimpleResponseSchema),
  operation("post", "/api/review/undo", "undoReview", "owner", "owner", "sessionMutation", { body: reviewUndoSchema }, 200, reviewSimpleResponseSchema),
  operation("post", "/api/review/weak-signal/clear", "clearL1WeakSignal", "owner", "owner", "sessionMutation", { body: clearL1WeakSignalSchema }, 200, reviewSimpleResponseSchema),
  operation("post", "/api/review/cards", "enqueueReviewCard", "owner", "owner", "sessionMutation", { body: addToReviewSchema }, 201, reviewEnqueueCardResponseSchema),
  operation("post", "/api/review/cards/batch", "enqueueReviewCardsBatch", "owner", "owner", "sessionMutation", { body: batchAddToReviewSchema }, 200, reviewEnqueueCardsBatchResponseSchema),
  operation("get", "/api/review/drill/queue", "getReviewDrillQueue", "owner", "agent", "none", { query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional().default(20) }) }, 200, reviewDrillQueueResponseSchema),
  operation("post", "/api/capture", "createCapture", "owner", "owner", "sessionMutation", { body: captureRequestSchema }, 201, captureResponseSchema),
  operation("post", "/api/imports/vocab-notes", "importVocabNotes", "owner", "owner", "sessionMutation", { body: vocabNotesImportRequestSchema }, 200, vocabNotesImportResponseSchema),
  // llm-status 是预算水位（agent 需据此决定是否构建生成请求）——读面，非语料。
  operation("get", "/api/l2/llm-status", "getL2LlmStatus", "owner", "agent", "none", undefined, 200, l2LlmStatusResponseSchema),
  // promote 直接写权威 L2 内容（升级动作）→ owner。
  operation("post", "/api/l2/:slug/promote", "promoteL2", "owner", "owner", "sessionMutation", undefined, 200, l2PromoteResponseSchema),
  operation("get", "/api/l2/:slug/candidates", "listL2Candidates", "owner", "agent", "none", undefined, 200, l2CandidatesResponseSchema),
  // ★ Proposal-only write：agent 可送候选（is_active=false，等人工采纳）。
  operation("post", "/api/l2/:slug/candidates", "proposeL2Candidate", "owner", "agent", "sessionMutation", { body: l2CandidateProposeRequestSchema }, 200, l2CandidateProposeResponseSchema),
  operation("post", "/api/l2/:slug/candidates/:candidateId/accept", "acceptL2Candidate", "owner", "owner", "sessionMutation", { body: z.object({ itemIndexes: z.array(z.coerce.number().int().min(0)).optional(), mode: z.enum(["append", "replace"]).optional() }).optional() }, 200, l2CandidateAcceptResponseSchema),
  operation("post", "/api/l2/:slug/candidates/:candidateId/reject", "rejectL2Candidate", "owner", "owner", "sessionMutation", undefined, 200, l2CandidateRejectResponseSchema),
  operation("get", "/api/l2/:slug/l2-rows", "listL2ContentRows", "owner", "agent", "none", undefined, 200, l2ContentRowsResponseSchema),
  operation("post", "/api/l2/:slug/l2-rows/:rowId/deactivate", "deactivateL2ContentRow", "owner", "owner", "sessionMutation", undefined, 200, l2ContentRowMutateResponseSchema),
  operation("delete", "/api/l2/:slug/l2-rows/:rowId", "deleteL2ContentRow", "owner", "owner", "sessionMutation", undefined, 200, l2ContentRowMutateResponseSchema),
  operation("delete", "/api/l2/:slug/l2-rows/:rowId/items/:index", "removeL2ContentRowItem", "owner", "owner", "sessionMutation", undefined, 200, l2ContentRowItemRemoveResponseSchema),
  operation("post", "/api/l2/:slug/l2-rows/:rowId/items/:index/hide", "hideL2ContentRowItem", "owner", "owner", "sessionMutation", undefined, 200, l2ContentRowItemHideResponseSchema),
  operation("post", "/api/l2/:slug/l2-rows/:rowId/hidden/:index/restore", "restoreL2ContentRowItem", "owner", "owner", "sessionMutation", undefined, 200, l2ContentRowItemRestoreResponseSchema),
  // draft 消耗 LLM 预算并落草稿，非 proposal-only 写入 → owner（T13a 取 fail-closed；若后续
  // 确认草稿不进权威数据，可在 T13b 复核为 agent）。
  operation("post", "/api/l2/:slug/draft", "createL2Draft", "owner", "owner", "sessionMutation", { body: l2FieldRequestSchema }, 200, l2DraftResponseSchema),
  // external-prompt 是纯提示词组装（不耗预算、不写库），语义上是"提案载荷的准备阶段"，
  // 属 ADR-0029 的 agent 可写面 → agent（T13a-fix）。auth 保持 owner（仅 OpenAPI 描述）。
  operation("post", "/api/l2/:slug/external-prompt", "createL2ExternalPrompt", "owner", "agent", "sessionMutation", { body: l2FieldRequestSchema }, 200, l2ExternalPromptResponseSchema),
  // L2 confirm：直接写 is_active=true，跳过候选池（ADR-0029 决策 2 点名的空档）→ owner。
  operation("post", "/api/l2/:slug/confirm", "confirmL2Draft", "owner", "owner", "sessionMutation", { body: l2ConfirmRequestSchema }, 200, l2ConfirmResponseSchema),
  operation("get", "/api/l2-drill/queue", "getL2DrillQueue", "owner", "agent", "none", { query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional().default(20) }) }, 200, l2DrillQueueResponseSchema),
  operation("post", "/api/l2-drill/task/answer", "submitL2TaskAnswer", "owner", "owner", "sessionMutation", { body: l2TaskAnswerSchema }, 200, l2TaskAnswerResponseSchema),
  operation("post", "/api/l2-drill/self-assess", "submitL2SelfAssessment", "owner", "owner", "sessionMutation", { body: l2SelfAssessSchema }, 200, l2SelfAssessResponseSchema),
  operation("post", "/api/l2-drill/undo", "undoL2Drill", "owner", "owner", "sessionMutation", { body: l2UndoSchema }, 200, l2UndoResponseSchema),
  operation("post", "/api/l3/sources", "createL3Source", "owner", "owner", "sessionMutation", { body: l3SourceCreateSchema }, 201, l3SourceCreateResponseSchema),
  operation("put", "/api/l3/sources/:id/spaces", "replaceL3SourceSpaces", "owner", "owner", "sessionMutation", { body: l3SourceSpacesReplaceSchema }, 200, l3SourceSpacesReplaceResponseSchema),
  operation("post", "/api/l3/sources/:id/captures", "createL3SelectionCapture", "owner", "owner", "sessionMutation", { body: l3SelectionCaptureSchema }, 201, l3SelectionCaptureResponseSchema),
  // ADR-0030：题目/试卷（V1 owner 入库面；读面对 agent 开放，与 sources 读面同口径）。
  //
  // ⚠️ ADR-0037（2026-09-26）：录题写面 minRole 由 owner 放宽为 **agent**，但
  // 「可写」≠「可写 active」——agent 的产物一律落 status='pending'、created_by=agentId，
  // 由 owner 在待录面逐条核对后采纳（见下方 accept/reject 四个 owner-only 端点）。
  // 判据是「答案键一旦被作答即永久不可改」，闸门必须落在采纳之前。
  // 删题仍 owner-only：agent 只能订正，不能销毁（ADR-0030 §5 红线）。
  operation("post", "/api/l3/papers", "createL3Paper", "owner", "agent", "sessionMutation", { body: l3PaperCreateSchema }, 201, l3PaperCreateResponseSchema),
  // 改卷（2026-09-26）仍 **owner-only**：agent 只建卷，卷内题强制 pending，
  // 没有"改 active 卷"这件事给 agent（ADR-0037 补记一）。
  operation("patch", "/api/l3/papers/:id", "updateL3Paper", "owner", "owner", "sessionMutation", { body: l3PaperUpdateSchema }, 200, l3PaperUpdateResponseSchema),
  operation("get", "/api/l3/papers", "listL3Papers", "owner", "agent", "none", { query: l3PaperListQuerySchema }, 200, l3PaperListResponseSchema),
  operation("get", "/api/l3/papers/:id", "getL3Paper", "owner", "agent", "none", undefined, 200, l3PaperDetailResponseSchema),
  operation("post", "/api/l3/questions", "createL3Question", "owner", "agent", "sessionMutation", { body: l3QuestionCreateSchema }, 201, l3QuestionCreateResponseSchema),
  // 改题面：agent 开放但**只能改 pending**（service 按角色给可改状态集合，落 UPDATE 谓词）。
  operation("patch", "/api/l3/questions/:id", "updateL3Question", "owner", "agent", "sessionMutation", { body: l3QuestionUpdateSchema }, 200, l3QuestionUpdateResponseSchema),
  operation("delete", "/api/l3/questions/:id", "deleteL3Question", "owner", "owner", "sessionMutation", undefined, 200, l3QuestionDeleteResponseSchema),
  // ADR-0037 评审面（**全 owner-only**）：待录是 owner 的核对责任，agent 看自己的产物无意义。
  operation("get", "/api/l3/questions", "listPendingL3Questions", "owner", "owner", "none", { query: l3PendingQuestionListQuerySchema }, 200, l3PendingQuestionListResponseSchema),
  operation("post", "/api/l3/questions/:id/accept", "acceptL3Question", "owner", "owner", "sessionMutation", undefined, 200, l3QuestionAcceptResponseSchema),
  operation("post", "/api/l3/questions/:id/reject", "rejectL3Question", "owner", "owner", "sessionMutation", undefined, 200, l3QuestionUpdateResponseSchema),
  operation("post", "/api/l3/questions/accept-batch", "acceptL3QuestionsBatch", "owner", "owner", "sessionMutation", { body: l3QuestionAcceptBatchSchema }, 200, l3QuestionAcceptResponseSchema),
  // 批次一：做题注记（原文分析条目）纯 owner 做题面，锚点幂等命中 200/新建 201；软删 204。
  operation("get", "/api/l3/question-annotations", "listQuestionAnnotations", "owner", "owner", "none", { query: l3QuestionAnnotationListQuerySchema }, 200, l3QuestionAnnotationListResponseSchema),
  operation("post", "/api/l3/question-annotations", "createQuestionAnnotation", "owner", "owner", "sessionMutation", { body: l3QuestionAnnotationCreateSchema }, 201, l3QuestionAnnotationItemResponseSchema),
  operation("patch", "/api/l3/question-annotations/:id", "patchQuestionAnnotation", "owner", "owner", "sessionMutation", { body: l3QuestionAnnotationPatchSchema }, 200, l3QuestionAnnotationItemResponseSchema),
  operation("delete", "/api/l3/question-annotations/:id", "deleteQuestionAnnotation", "owner", "owner", "sessionMutation", undefined, 204, z.null()),
  // v2 §4.7 撤回：submitted→draft（重挂题纸；owner-only 做题台面）。
  operation("post", "/api/l3/question-annotations/:id/withdraw", "withdrawQuestionAnnotation", "owner", "owner", "sessionMutation", { body: l3QuestionAnnotationWithdrawSchema }, 200, l3QuestionAnnotationItemResponseSchema),
  // 批次二增补：评析区（agent 首个可写持久区，Amends ADR-0029）——owner/agent 双身份。
  operation("get", "/api/l3/questions/:id/assessment", "getL3QuestionAssessment", "owner", "agent", "none", undefined, 200, l3AssessmentItemResponseSchema),
  operation("put", "/api/l3/questions/:id/assessment", "putL3QuestionAssessment", "owner", "agent", "sessionMutation", { body: l3AssessmentUpsertSchema }, 200, l3AssessmentItemResponseSchema),
  // 批次三①：评卷执行面（ADR-0035）——agent 读 face grading-context 含标准答案
  // （D8 唯一显式例外：仅 sealed + agent 面，前端永不消费）；grading 提交为 agent
  // 写面（graded_by 服务端从 bearer agentId 认定）；解析模式读面 owner-only。
  operation("get", "/api/l3/sheets/:id/grading-context", "getL3GradingContext", "owner", "agent", "none", undefined, 200, l3GradingContextResponseSchema),
  operation("post", "/api/l3/sheets/:id/grading", "submitL3Grading", "owner", "agent", "sessionMutation", { body: l3GradingSubmitSchema }, 200, l3GradingSubmitResponseSchema),
  operation("get", "/api/l3/sheets/:id/grading", "getL3GradingResults", "owner", "owner", "none", undefined, 200, l3GradingResultsResponseSchema),
  // D18：owner 处置（submitted→confirmed）；「撤回改写」走既有 withdraw 通道。
  operation("post", "/api/l3/annotations/:id/confirm", "confirmL3QuestionAnnotation", "owner", "owner", "sessionMutation", undefined, 200, l3QuestionAnnotationItemResponseSchema),
  operation("get", "/api/l3/annotation-tags", "getAnnotationTags", "owner", "owner", "none", undefined, 200, l3AnnotationTagDictResponseSchema),
  operation("put", "/api/l3/annotation-tags", "replaceAnnotationTags", "owner", "owner", "sessionMutation", { body: l3AnnotationTagDictSchema }, 200, l3AnnotationTagDictResponseSchema),
  // 批次二：题纸与作答历史（owner-only——做题台面是私人数据，读也不开放给 agent）。
  // 开纸幂等（复用 200 / 新建 201）；seal 未答软确认 409；attempts 软删 204。
  operation("post", "/api/l3/sheets", "openL3Sheet", "owner", "owner", "sessionMutation", { body: l3SheetOpenSchema }, 201, l3SheetItemResponseSchema),
  operation("get", "/api/l3/sheets/:id", "getL3Sheet", "owner", "owner", "none", undefined, 200, l3SheetDetailResponseSchema),
  operation("patch", "/api/l3/sheets/:id", "patchL3Sheet", "owner", "owner", "sessionMutation", { body: l3SheetPatchSchema }, 200, l3SheetItemResponseSchema),
  operation("post", "/api/l3/sheets/:id/seal", "sealL3Sheet", "owner", "owner", "sessionMutation", { body: l3SheetSealSchema }, 200, l3SheetSealResponseSchema),
  // F-1 回看闭环：题纸档案列表（owner-only；sheetId 深链入口数据源）。
  operation("get", "/api/l3/sheets", "listL3Sheets", "owner", "owner", "none", { query: l3SheetListQuerySchema }, 200, l3SheetListResponseSchema),
  operation("get", "/api/l3/attempts", "listL3Attempts", "owner", "owner", "none", { query: l3AttemptListQuerySchema }, 200, l3AttemptListResponseSchema),
  operation("delete", "/api/l3/attempts/:id", "deleteL3Attempt", "owner", "owner", "sessionMutation", undefined, 204, z.null()),
  // 作文子空间 v1（W6，ADR《writing-workspace》§6）：任务/稿件/反馈，基路径
  // /api/l3/writing。owner-only 写面（私人写作工作台）；agent 开口仅
  // feedback-context 读 + feedback 写两处；单稿导出端点属 W9（本轮未注册）。
  operation("post", "/api/l3/writing/tasks", "createL3WritingTask", "owner", "owner", "sessionMutation", { body: l3WritingTaskCreateSchema }, 201, l3WritingTaskCreateResponseSchema),
  operation("get", "/api/l3/writing/tasks", "listL3WritingTasks", "owner", "owner", "none", { query: l3WritingTaskListQuerySchema }, 200, l3WritingTaskListResponseSchema),
  operation("get", "/api/l3/writing/tasks/:taskId", "getL3WritingTask", "owner", "owner", "none", undefined, 200, l3WritingTaskDetailResponseSchema),
  operation("patch", "/api/l3/writing/tasks/:taskId", "patchL3WritingTask", "owner", "owner", "sessionMutation", { body: l3WritingTaskRenameSchema }, 200, l3WritingTaskResponseSchema),
  operation("post", "/api/l3/writing/tasks/:taskId/archive", "archiveL3WritingTask", "owner", "owner", "sessionMutation", undefined, 200, l3WritingTaskResponseSchema),
  operation("post", "/api/l3/writing/tasks/:taskId/restore", "restoreL3WritingTask", "owner", "owner", "sessionMutation", undefined, 200, l3WritingTaskResponseSchema),
  operation("get", "/api/l3/writing/tasks/:taskId/revisions", "listL3WritingRevisions", "owner", "owner", "none", { query: l3WritingRevisionListQuerySchema }, 200, l3WritingRevisionListResponseSchema),
  operation("get", "/api/l3/writing/tasks/:taskId/sheets/:sheetId", "getL3WritingSheet", "owner", "owner", "none", undefined, 200, l3WritingSheetDetailResponseSchema),
  operation("post", "/api/l3/writing/tasks/:taskId/drafts", "createL3WritingDraft", "owner", "owner", "sessionMutation", { body: l3WritingDraftCreateSchema }, 201, l3WritingDraftCreateResponseSchema),
  operation("patch", "/api/l3/writing/tasks/:taskId/sheets/:sheetId", "saveL3WritingDraft", "owner", "owner", "sessionMutation", { body: l3WritingDraftSaveSchema }, 200, l3WritingSaveResponseSchema),
  operation("post", "/api/l3/writing/tasks/:taskId/sheets/:sheetId/submit", "submitL3WritingSheet", "owner", "owner", "sessionMutation", { body: l3WritingSubmitSchema }, 200, l3WritingSubmitResponseSchema),
  operation("post", "/api/l3/writing/tasks/:taskId/sheets/:sheetId/discard", "discardL3WritingSheet", "owner", "owner", "sessionMutation", { body: l3WritingSubmitSchema }, 200, l3WritingSheetResponseSchema),
  operation("get", "/api/l3/writing/tasks/:taskId/sheets/:sheetId/feedback", "getL3WritingFeedback", "owner", "owner", "none", undefined, 200, l3WritingFeedbackGetResponseSchema),
  // agent 开口（ADR-0029 Amends：第 3/4 处）——只读指定 sealed 稿 context +
  // 写该稿 feedback（lastEditor 服务端认定；作文 feedback 是该稿唯一质量反馈源）。
  operation("get", "/api/l3/writing/tasks/:taskId/sheets/:sheetId/feedback-context", "getL3WritingFeedbackContext", "owner", "agent", "none", undefined, 200, l3WritingFeedbackContextResponseSchema),
  operation("put", "/api/l3/writing/tasks/:taskId/sheets/:sheetId/feedback", "putL3WritingFeedback", "owner", "agent", "sessionMutation", { body: l3WritingFeedbackPutSchema }, 200, l3WritingFeedbackPutResponseSchema),
  // W9（ADR《writing-workspace》§7）：单稿导出（owner-only；text/markdown + 版本/sha256
  // 响应头，对齐题纸导出先例）与正文清理（soft-delete attempt + 同事务删反馈；
  // sealed 限定、幂等；agent 无导出权限）。
  operation("get", "/api/l3/writing/tasks/:taskId/sheets/:sheetId/export", "exportL3WritingSheet", "owner", "owner", "none", undefined, 200, z.string(), "text/markdown"),
  operation("delete", "/api/l3/writing/tasks/:taskId/sheets/:sheetId/content", "clearL3WritingSheetContent", "owner", "owner", "sessionMutation", undefined, 200, l3WritingSheetResponseSchema),
  // A2（2026-09-19）：按题批量进度读面（owner-only 只读；静态路径先于 /tasks/:taskId 注册；
  // 原始 questionId 重复参数 ≤100、去重后单条集合查询；无匹配 = 空数组，不代挑任务）。
  operation("get", "/api/l3/writing/tasks/question-summaries", "listL3WritingQuestionSummaries", "owner", "owner", "none", { query: l3WritingQuestionSummariesQuerySchema }, 200, l3WritingQuestionSummariesResponseSchema),
  // 学习笔记（N1，ADR《study-notes-workspace》/ 设计 §7）：笔记/专题/引用三组，
  // **全部 owner-only**（agent 一律 403；未认证 401；他人资源 404；零写 GET）。
  // 固定路径（reference-targets / reference-preview / backlinks）先于 /:noteId 动态段注册。
  operation("post", "/api/l3/study-notes", "createL3StudyNote", "owner", "owner", "sessionMutation", { body: l3StudyNoteCreateSchema }, 201, l3StudyNoteCreateResponseSchema),
  operation("get", "/api/l3/study-notes", "listL3StudyNotes", "owner", "owner", "none", { query: l3StudyNoteListQuerySchema }, 200, l3StudyNoteListResponseSchema),
  operation("get", "/api/l3/study-notes/reference-targets", "searchL3ReferenceTargets", "owner", "owner", "none", { query: l3StudyReferenceTargetQuerySchema }, 200, l3ReferenceTargetListResponseSchema),
  operation("post", "/api/l3/study-notes/reference-preview", "previewL3ReferenceTarget", "owner", "owner", "sessionMutation", { body: l3StudyReferenceTargetSchema }, 200, l3ReferenceTargetPreviewResponseSchema),
  operation("get", "/api/l3/study-notes/backlinks", "listL3StudyBacklinks", "owner", "owner", "none", { query: l3StudyBacklinkQuerySchema }, 200, l3StudyBacklinkListResponseSchema),
  // N1/Task 10：笔记导出（只出不进；text/markdown + 版本/schema/sha256 响应头，
  // 对齐题纸/作文导出先例）。登记于固定路径之后、/:noteId 动态段之前；实际路由由
  // study-notes-export.ts 在 server.ts 中先于 study-notes.ts 挂载（见 server.ts 注释）。
  operation("get", "/api/l3/study-notes/:noteId/export", "exportL3StudyNote", "owner", "owner", "none", { query: l3StudyNoteExportQuerySchema }, 200, z.string(), "text/markdown"),
  operation("get", "/api/l3/study-notes/:noteId", "getL3StudyNote", "owner", "owner", "none", undefined, 200, l3StudyNoteItemResponseSchema),
  operation("put", "/api/l3/study-notes/:noteId", "saveL3StudyNote", "owner", "owner", "sessionMutation", { body: l3StudyNoteSaveSchema }, 200, l3StudyNoteItemResponseSchema),
  operation("post", "/api/l3/study-topics", "createL3StudyTopic", "owner", "owner", "sessionMutation", { body: l3StudyTopicCreateSchema }, 201, l3StudyTopicCreateResponseSchema),
  operation("get", "/api/l3/study-topics", "listL3StudyTopics", "owner", "owner", "none", { query: l3StudyTopicListQuerySchema }, 200, l3StudyTopicListResponseSchema),
  operation("put", "/api/l3/study-topics/:topicId", "saveL3StudyTopic", "owner", "owner", "sessionMutation", { body: l3StudyTopicSaveSchema }, 200, l3StudyTopicItemResponseSchema),
  operation("put", "/api/l3/study-topics/:topicId/members/:noteId", "moveL3StudyTopicMember", "owner", "owner", "sessionMutation", { body: l3StudyTopicMemberMoveSchema }, 200, l3StudyTopicItemResponseSchema),
  operation("delete", "/api/l3/study-topics/:topicId/members/:noteId", "removeL3StudyTopicMember", "owner", "owner", "sessionMutation", { body: l3StudyTopicMemberRemoveSchema }, 200, l3StudyTopicItemResponseSchema),
  // 批次二收官：冻结导出（只出不进；Content-Disposition + 版本/sha256 响应头）。
  operation("get", "/api/l3/sheets/:id/export", "exportL3Sheet", "owner", "owner", "none", { query: l3SheetExportQuerySchema }, 200, z.string(), "text/markdown"),
  operation("get", "/api/l3/practice-files", "listL3PracticeFiles", "owner", "agent", "none", { query: l3PracticeFileListQuerySchema }, 200, l3PracticeFileListResponseSchema),
  operation("get", "/api/l3/practice-files/detail", "getL3PracticeFile", "owner", "agent", "none", { query: l3PracticeFileDetailQuerySchema }, 200, l3PracticeFileDetailResponseSchema),
  operation("post", "/api/l3/contexts", "createL3Context", "owner", "owner", "sessionMutation", { body: l3ContextCreateSchema }, 201, l3ContextCreateResponseSchema),
  operation("post", "/api/l3/quick-context", "createL3QuickContext", "owner", "owner", "sessionMutation", { body: quickL3ContextSchema }, 201, l3QuickContextResponseSchema),
  operation("post", "/api/l3/occurrences", "createL3Occurrence", "owner", "owner", "sessionMutation", { body: l3OccurrenceCreateSchema }, 201, l3OccurrenceCreateResponseSchema),
  operation("post", "/api/l3/context-links", "createL3ContextLink", "owner", "owner", "sessionMutation", { body: l3ContextLinkCreateSchema }, 201, l3ContextLinkCreateResponseSchema),
  operation("delete", "/api/l3/occurrences/:id", "deleteL3Occurrence", "owner", "owner", "sessionMutation", undefined, 200, l3DeleteResponseSchema),
  operation("delete", "/api/l3/context-links/:id", "deleteL3ContextLink", "owner", "owner", "sessionMutation", undefined, 200, l3DeleteResponseSchema),
  operation("delete", "/api/l3/sources/:id", "deleteL3Source", "owner", "owner", "sessionMutation", undefined, 200, l3DeleteResponseSchema),
  operation("delete", "/api/l3/contexts/:id", "deleteL3Context", "owner", "owner", "sessionMutation", undefined, 200, l3DeleteResponseSchema),
  operation("get", "/api/l3/contexts/:id", "getL3Context", "owner", "agent", "none", undefined, 200, l3ContextDetailResponseSchema),
  operation("get", "/api/l3/words/:slug/space", "getL3WordSpace", "owner", "agent", "none", { query: l3WordSpaceQuerySchema }, 200, l3WordSpaceResponseSchema),
  operation("get", "/api/l3/sources", "listL3Sources", "owner", "agent", "none", { query: l3SourceListQuerySchema }, 200, l3SourceListResponseSchema),
  operation("get", "/api/l3/sources/:id/space", "getL3SourceSpace", "owner", "agent", "none", { query: l3SourceSpaceQuerySchema }, 200, l3SourceSpaceResponseSchema),
  operation("get", "/api/l3/graph", "getL3Graph", "owner", "agent", "none", { query: l3GraphQuerySchema }, 200, l3GraphResponseSchema),
  operation("get", "/api/l3/words/:slug/contexts", "listL3WordContexts", "owner", "agent", "none", { query: l3WordContextListQuerySchema }, 200, l3ContextListResponseSchema),
  operation("get", "/api/l3/sources/:id/contexts", "listL3SourceContexts", "owner", "agent", "none", { query: l3LimitCursorQuerySchema }, 200, l3ContextListResponseSchema),
  // ADR-0029 §6①：读面补缺——occurrences / context-links 的只读列表（cursor 分页，
  // 可按词、语境与空间/方向两轴过滤；路由实现在 routes/l3/lists.ts）。
  operation("get", "/api/l3/occurrences", "listL3Occurrences", "owner", "agent", "none", { query: l3OccurrenceListQuerySchema }, 200, l3OccurrenceListResponseSchema),
  operation("get", "/api/l3/context-links", "listL3ContextLinks", "owner", "agent", "none", { query: l3ContextLinkListQuerySchema }, 200, l3ContextLinkListResponseSchema),
  // ADR-0029 §8②：能力发现——agent 可读面/预算上限/error code 词表（单一真源引用）。
  operation("get", "/api/l3/capabilities", "getL3Capabilities", "owner", "agent", "none", undefined, 200, l3CapabilitiesResponseSchema),
  // B1 素材宇宙：空间汇总读面（全量计数 + 生长趋势；只读，与 graph/sources 同族 agent 可读）。
  operation("get", "/api/l3/space-summary", "getL3SpaceSummary", "owner", "agent", "none", { query: l3SpaceSummaryQuerySchema }, 200, l3SpaceSummaryResponseSchema),
  // import 落 job 后产出 proposal bundle（响应即 ProposalBundle），不写 active L3、不耗 LLM →
  // 与 proposal 入口同族，对 agent 开放（2026-09-12 裁决）。
  operation("post", "/api/l3/imports/raw-text", "createL3RawTextImport", "owner", "agent", "sessionMutation", { body: l3RawTextImportCreateSchema }, 201, l3ImportProposalResponseSchema),
  operation("post", "/api/l3/imports/structured", "createL3StructuredImport", "owner", "agent", "sessionMutation", { body: l3StructuredImportCreateSchema }, 201, l3ImportProposalResponseSchema),
  // ★ Proposal-only write：L3 proposal 三件套的创造入口；validate/confirm/reject 是升级动作 → owner。
  operation("post", "/api/l3/proposals", "createL3Proposal", "owner", "agent", "sessionMutation", { body: l3ProposalCreateSchema }, 201, l3ProposalBundleResponseSchema),
  // generate 消耗 LLM 预算产出推荐集；非 proposal-only 写入 → owner（见报告残余风险）。
  operation("post", "/api/l3/recommendations/generate", "generateL3Recommendations", "owner", "owner", "sessionMutation", { body: l3RecommendationGenerateSchema }, 201, l3RecommendationBundleResponseSchema),
  operation("get", "/api/l3/recommendations", "listL3Recommendations", "owner", "agent", "none", { query: l3RecommendationListQuerySchema }, 200, l3RecommendationListResponseSchema),
  operation("get", "/api/l3/recommendations/:id", "getL3Recommendation", "owner", "agent", "none", undefined, 200, l3RecommendationDetailResponseSchema),
  operation("post", "/api/l3/recommendations/:id/accept", "acceptL3Recommendation", "owner", "owner", "sessionMutation", undefined, 200, l3RecommendationAcceptResponseSchema),
  operation("post", "/api/l3/recommendations/:id/reject", "rejectL3Recommendation", "owner", "owner", "sessionMutation", { body: l3RecommendationRejectSchema }, 200, l3RecommendationItemResponseSchema),
  operation("get", "/api/l3/proposals", "listL3Proposals", "owner", "agent", "none", { query: l3ProposalListQuerySchema }, 200, l3ProposalListResponseSchema),
  operation("get", "/api/l3/proposals/:id", "getL3Proposal", "owner", "agent", "none", undefined, 200, l3ProposalBundleResponseSchema),
  operation("post", "/api/l3/proposals/:id/validate", "validateL3Proposal", "owner", "owner", "sessionMutation", undefined, 200, l3ProposalValidationResponseSchema),
  operation("post", "/api/l3/proposals/:id/confirm", "confirmL3Proposal", "owner", "owner", "sessionMutation", undefined, 200, l3ProposalConfirmResponseSchema),
  operation("post", "/api/l3/proposals/:id/reject", "rejectL3Proposal", "owner", "owner", "sessionMutation", { body: l3ProposalRejectSchema }, 200, l3ProposalBundleResponseSchema),
  // ── Upgrade work orders (ADR-0018) ──────────────────────────────────────
  operation("post", "/api/upgrade-work-orders", "markUpgradeWorkOrder", "owner", "owner", "sessionMutation", { body: upgradeWorkOrderCreateSchema }, 201, upgradeWorkOrderMarkResponseSchema),
  operation("get", "/api/upgrade-work-orders", "listUpgradeWorkOrders", "owner", "agent", "none", { query: upgradeWorkOrderListQuerySchema }, 200, upgradeWorkOrderListResponseSchema),
  operation("post", "/api/upgrade-work-orders/:id/start", "startUpgradeWorkOrder", "owner", "owner", "sessionMutation", undefined, 200, upgradeWorkOrderRowResponseSchema),
  operation("post", "/api/upgrade-work-orders/:id/cancel", "cancelUpgradeWorkOrder", "owner", "owner", "sessionMutation", undefined, 200, upgradeWorkOrderRowResponseSchema),
  operation("post", "/api/upgrade-work-orders/:id/complete", "completeUpgradeWorkOrder", "owner", "owner", "sessionMutation", undefined, 200, upgradeWorkOrderCompleteResponseSchema),
  // ── L3 practice attempts / error book (ADR-0019 §1/§3) ──────────────────
  operation("post", "/api/l3-practice/attempts", "recordL3PracticeAttempt", "owner", "owner", "sessionMutation", { body: l3PracticeAttemptCreateSchema }, 201, l3PracticeAttemptRowResponseSchema),
  operation("get", "/api/l3-practice/attempts", "listL3PracticeAttempts", "owner", "agent", "none", { query: l3PracticeAttemptListQuerySchema }, 200, l3PracticeAttemptPageResponseSchema),
  // 错题库（T11 加固）：条目附服务端聚合（wrongCount/latestOutcome/latestAt），
  // cursor 纯新增、offset 保留（共存时 cursor 为准）→ 专属响应页 schema。
  operation("get", "/api/l3-practice/error-book", "listL3PracticeErrorBook", "owner", "agent", "none", { query: l3PracticeErrorBookQuerySchema }, 200, l3PracticeErrorBookPageResponseSchema),
  // 错题库统一投影（2026-09-26）：句级 wrong + 题级 wrong/partial 合并，消费方按
  // kind 分区。纯读派生（不建表），取代上方单腿端点的错题库口径。
  operation("get", "/api/l3/error-book", "listL3ErrorBook", "owner", "agent", "none", { query: l3ErrorBookQuerySchema }, 200, l3UnifiedErrorBookResponseSchema),
  // ── L3 sessions (ADR-0019 §2) ───────────────────────────────────────────
  operation("post", "/api/l3-sessions", "createL3Session", "owner", "owner", "sessionMutation", { body: l3SessionCreateSchema }, 201, l3SessionRowResponseSchema),
  operation("get", "/api/l3-sessions/:id", "getL3Session", "owner", "agent", "none", undefined, 200, l3SessionRenderDescriptionResponseSchema),
  operation("post", "/api/l3-sessions/:id/end", "endL3Session", "owner", "owner", "sessionMutation", { body: l3SessionEndSchema }, 200, l3SessionRowResponseSchema),
  // ── One-click forgetting (ADR-0020) ─────────────────────────────────────
  operation("get", "/api/forgetting/preview", "previewForgetting", "owner", "agent", "none", { query: forgettingPreviewQuerySchema }, 200, forgettingPreviewResponseSchema),
  operation("post", "/api/forgetting/apply", "applyForgetting", "owner", "owner", "sessionMutation", { body: forgettingApplySchema }, 200, forgettingApplyResponseSchema),
  operation("post", "/api/forgetting/restore", "restoreForgetting", "owner", "owner", "sessionMutation", { body: forgettingRestoreSchema }, 200, forgettingRestoreResponseSchema),
] as const satisfies readonly ApiOperation[];
