import { z, type ZodType } from "zod";
import {
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
  l3WordSpaceResponseSchema,
} from "./l3-response-contract";
import {
  upgradeWorkOrderCompleteResponseSchema,
  upgradeWorkOrderListResponseSchema,
  upgradeWorkOrderMarkResponseSchema,
  upgradeWorkOrderRowResponseSchema,
} from "./upgrade-work-order-response-contract";
import {
  l3PracticeAttemptPageResponseSchema,
  l3PracticeAttemptRowResponseSchema,
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
    readonly mediaType: "application/json" | "text/plain";
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
  mediaType: "application/json" | "text/plain" = "application/json",
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
  operation("post", "/api/l3/sources/:id/captures", "createL3SelectionCapture", "owner", "owner", "sessionMutation", { body: l3SelectionCaptureSchema }, 201, l3SelectionCaptureResponseSchema),
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
  operation("get", "/api/l3-practice/error-book", "listL3PracticeErrorBook", "owner", "agent", "none", { query: l3PracticeErrorBookQuerySchema }, 200, l3PracticeAttemptPageResponseSchema),
  // ── L3 sessions (ADR-0019 §2) ───────────────────────────────────────────
  operation("post", "/api/l3-sessions", "createL3Session", "owner", "owner", "sessionMutation", { body: l3SessionCreateSchema }, 201, l3SessionRowResponseSchema),
  operation("get", "/api/l3-sessions/:id", "getL3Session", "owner", "agent", "none", undefined, 200, l3SessionRenderDescriptionResponseSchema),
  operation("post", "/api/l3-sessions/:id/end", "endL3Session", "owner", "owner", "sessionMutation", { body: l3SessionEndSchema }, 200, l3SessionRowResponseSchema),
  // ── One-click forgetting (ADR-0020) ─────────────────────────────────────
  operation("get", "/api/forgetting/preview", "previewForgetting", "owner", "agent", "none", { query: forgettingPreviewQuerySchema }, 200, forgettingPreviewResponseSchema),
  operation("post", "/api/forgetting/apply", "applyForgetting", "owner", "owner", "sessionMutation", { body: forgettingApplySchema }, 200, forgettingApplyResponseSchema),
  operation("post", "/api/forgetting/restore", "restoreForgetting", "owner", "owner", "sessionMutation", { body: forgettingRestoreSchema }, 200, forgettingRestoreResponseSchema),
] as const satisfies readonly ApiOperation[];
