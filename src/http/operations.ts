import { z, type ZodType } from "zod";
import {
  l3ContextCreateSchema,
  l3ContextLinkCreateSchema,
  l3GraphQuerySchema,
  l3LimitCursorQuerySchema,
  l3OccurrenceCreateSchema,
  l3ProposalCreateSchema,
  l3ProposalListQuerySchema,
  l3ProposalRejectSchema,
  l3RawTextImportCreateSchema,
  l3RecommendationGenerateSchema,
  l3RecommendationListQuerySchema,
  l3RecommendationRejectSchema,
  l3SourceCreateSchema,
  l3SourceSpaceQuerySchema,
  l3StructuredImportCreateSchema,
  l3WordSpaceQuerySchema,
  reviewAnswerSchema,
  reviewSkipSchema,
  reviewSuspendSchema,
  reviewUndoSchema,
  wordsQuerySchema,
} from "../schemas/http";

export type HttpMethod = "delete" | "get" | "patch" | "post" | "put";

export interface ApiOperation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
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
const l2FieldRequestSchema = z.object({
  field: z.enum(["collocation", "example", "corpus", "synonym", "antonym"]),
  styleProfileId: z.string().optional(),
  userInstruction: z.string().optional(),
}).passthrough();
const l2ConfirmRequestSchema = l2FieldRequestSchema.extend({
  content: z.unknown().optional(),
  items: z.array(z.unknown()).optional(),
  document: z.unknown().optional(),
  source: z.string().optional(),
  sourceRef: z.string().nullable().optional(),
});

function operation(
  method: HttpMethod,
  path: string,
  operationId: string,
  request?: ApiOperation["request"],
  status = 200,
  responseSchema: ZodType = jsonResponseSchema,
  mediaType: "application/json" | "text/plain" = "application/json",
): ApiOperation {
  return {
    method,
    path,
    operationId,
    ...(request ? { request } : {}),
    response: { status, schema: responseSchema, mediaType },
  };
}

export const apiOperations = [
  operation("get", "/healthz", "getLiveness", undefined, 200, livenessResponseSchema),
  operation("get", "/health", "getHealth", undefined, 200, healthResponseSchema),
  operation("get", "/readyz", "getReadiness", undefined, 200, readinessResponseSchema),
  operation("get", "/metrics", "getPrometheusMetrics", undefined, 200, z.string(), "text/plain"),
  operation("post", "/api/auth/session", "createAuthSession", { body: authSessionCreateSchema }, 201, authSessionCreatedSchema),
  operation("get", "/api/auth/session", "getAuthSession", undefined, 200, authSessionSchema),
  operation("delete", "/api/auth/session", "deleteAuthSession", undefined, 204, z.null()),
  operation("get", "/api/operations/metrics", "getOperationMetrics"),
  operation("get", "/api/words", "listWords", { query: wordsQuerySchema }),
  operation("get", "/api/words/:slug", "getWord"),
  operation("post", "/api/review/answer", "submitReviewAnswer", { body: reviewAnswerSchema }),
  operation("post", "/api/review/skip", "skipReview", { body: reviewSkipSchema }),
  operation("post", "/api/review/suspend", "suspendReview", { body: reviewSuspendSchema }),
  operation("post", "/api/review/undo", "undoReview", { body: reviewUndoSchema }),
  operation("post", "/api/l2/:slug/draft", "createL2Draft", { body: l2FieldRequestSchema }),
  operation("post", "/api/l2/:slug/external-prompt", "createL2ExternalPrompt", { body: l2FieldRequestSchema }),
  operation("post", "/api/l2/:slug/confirm", "confirmL2Draft", { body: l2ConfirmRequestSchema }),
  operation("post", "/api/l3/sources", "createL3Source", { body: l3SourceCreateSchema }, 201),
  operation("post", "/api/l3/contexts", "createL3Context", { body: l3ContextCreateSchema }, 201),
  operation("post", "/api/l3/occurrences", "createL3Occurrence", { body: l3OccurrenceCreateSchema }, 201),
  operation("post", "/api/l3/context-links", "createL3ContextLink", { body: l3ContextLinkCreateSchema }, 201),
  operation("delete", "/api/l3/occurrences/:id", "deleteL3Occurrence"),
  operation("delete", "/api/l3/context-links/:id", "deleteL3ContextLink"),
  operation("delete", "/api/l3/sources/:id", "deleteL3Source"),
  operation("delete", "/api/l3/contexts/:id", "deleteL3Context"),
  operation("get", "/api/l3/contexts/:id", "getL3Context"),
  operation("get", "/api/l3/words/:slug/space", "getL3WordSpace", { query: l3WordSpaceQuerySchema }),
  operation("get", "/api/l3/sources/:id/space", "getL3SourceSpace", { query: l3SourceSpaceQuerySchema }),
  operation("get", "/api/l3/graph", "getL3Graph", { query: l3GraphQuerySchema }),
  operation("get", "/api/l3/words/:slug/contexts", "listL3WordContexts", { query: l3LimitCursorQuerySchema }),
  operation("get", "/api/l3/sources/:id/contexts", "listL3SourceContexts", { query: l3LimitCursorQuerySchema }),
  operation("post", "/api/l3/imports/raw-text", "createL3RawTextImport", { body: l3RawTextImportCreateSchema }, 201),
  operation("post", "/api/l3/imports/structured", "createL3StructuredImport", { body: l3StructuredImportCreateSchema }, 201),
  operation("post", "/api/l3/proposals", "createL3Proposal", { body: l3ProposalCreateSchema }, 201),
  operation("post", "/api/l3/recommendations/generate", "generateL3Recommendations", { body: l3RecommendationGenerateSchema }, 201),
  operation("get", "/api/l3/recommendations", "listL3Recommendations", { query: l3RecommendationListQuerySchema }),
  operation("get", "/api/l3/recommendations/:id", "getL3Recommendation"),
  operation("post", "/api/l3/recommendations/:id/accept", "acceptL3Recommendation"),
  operation("post", "/api/l3/recommendations/:id/reject", "rejectL3Recommendation", { body: l3RecommendationRejectSchema }),
  operation("get", "/api/l3/proposals", "listL3Proposals", { query: l3ProposalListQuerySchema }),
  operation("get", "/api/l3/proposals/:id", "getL3Proposal"),
  operation("post", "/api/l3/proposals/:id/validate", "validateL3Proposal"),
  operation("post", "/api/l3/proposals/:id/confirm", "confirmL3Proposal"),
  operation("post", "/api/l3/proposals/:id/reject", "rejectL3Proposal", { body: l3ProposalRejectSchema }),
] as const satisfies readonly ApiOperation[];
