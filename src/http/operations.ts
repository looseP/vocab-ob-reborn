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

export type ApiAuthPolicy = "metrics" | "optionalSession" | "owner" | "public";
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
  readonly auth: ApiAuthPolicy;
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
  auth: ApiAuthPolicy,
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
    csrf,
    ...(contract ?? {}),
    ...(request ? { request } : {}),
    response: { status, schema: responseSchema, mediaType },
  };
}

export const apiOperations = [
  operation("get", "/healthz", "getLiveness", "public", "none", undefined, 200, livenessResponseSchema),
  operation("get", "/health", "getHealth", "public", "none", undefined, 200, healthResponseSchema),
  operation("get", "/readyz", "getReadiness", "public", "none", undefined, 200, readinessResponseSchema),
  operation("get", "/metrics", "getPrometheusMetrics", "metrics", "none", undefined, 200, z.string(), "text/plain"),
  operation("post", "/api/auth/session", "createAuthSession", "public", "none", { body: authSessionCreateSchema }, 201, authSessionCreatedSchema, "application/json", {
    requestHeaders: [originHeader, requestedWithHeader],
    responseHeaders: {
      201: [cacheControlHeader, setCookieHeader],
      429: [cacheControlHeader, retryAfterHeader],
    },
  }),
  operation("get", "/api/auth/session", "getAuthSession", "owner", "none", undefined, 200, authSessionSchema),
  operation("delete", "/api/auth/session", "deleteAuthSession", "optionalSession", "sessionMutation", undefined, 204, z.null()),
  operation("get", "/api/operations/metrics", "getOperationMetrics", "owner", "none"),
  operation("get", "/api/words", "listWords", "owner", "none", { query: wordsQuerySchema }),
  operation("get", "/api/words/:slug", "getWord", "owner", "none"),
  operation("post", "/api/review/answer", "submitReviewAnswer", "owner", "sessionMutation", { body: reviewAnswerSchema }),
  operation("post", "/api/review/skip", "skipReview", "owner", "sessionMutation", { body: reviewSkipSchema }),
  operation("post", "/api/review/suspend", "suspendReview", "owner", "sessionMutation", { body: reviewSuspendSchema }),
  operation("post", "/api/review/undo", "undoReview", "owner", "sessionMutation", { body: reviewUndoSchema }),
  operation("post", "/api/l2/:slug/draft", "createL2Draft", "owner", "sessionMutation", { body: l2FieldRequestSchema }),
  operation("post", "/api/l2/:slug/external-prompt", "createL2ExternalPrompt", "owner", "sessionMutation", { body: l2FieldRequestSchema }),
  operation("post", "/api/l2/:slug/confirm", "confirmL2Draft", "owner", "sessionMutation", { body: l2ConfirmRequestSchema }),
  operation("post", "/api/l3/sources", "createL3Source", "owner", "sessionMutation", { body: l3SourceCreateSchema }, 201),
  operation("post", "/api/l3/contexts", "createL3Context", "owner", "sessionMutation", { body: l3ContextCreateSchema }, 201),
  operation("post", "/api/l3/occurrences", "createL3Occurrence", "owner", "sessionMutation", { body: l3OccurrenceCreateSchema }, 201),
  operation("post", "/api/l3/context-links", "createL3ContextLink", "owner", "sessionMutation", { body: l3ContextLinkCreateSchema }, 201),
  operation("delete", "/api/l3/occurrences/:id", "deleteL3Occurrence", "owner", "sessionMutation"),
  operation("delete", "/api/l3/context-links/:id", "deleteL3ContextLink", "owner", "sessionMutation"),
  operation("delete", "/api/l3/sources/:id", "deleteL3Source", "owner", "sessionMutation"),
  operation("delete", "/api/l3/contexts/:id", "deleteL3Context", "owner", "sessionMutation"),
  operation("get", "/api/l3/contexts/:id", "getL3Context", "owner", "none"),
  operation("get", "/api/l3/words/:slug/space", "getL3WordSpace", "owner", "none", { query: l3WordSpaceQuerySchema }),
  operation("get", "/api/l3/sources/:id/space", "getL3SourceSpace", "owner", "none", { query: l3SourceSpaceQuerySchema }),
  operation("get", "/api/l3/graph", "getL3Graph", "owner", "none", { query: l3GraphQuerySchema }),
  operation("get", "/api/l3/words/:slug/contexts", "listL3WordContexts", "owner", "none", { query: l3LimitCursorQuerySchema }),
  operation("get", "/api/l3/sources/:id/contexts", "listL3SourceContexts", "owner", "none", { query: l3LimitCursorQuerySchema }),
  operation("post", "/api/l3/imports/raw-text", "createL3RawTextImport", "owner", "sessionMutation", { body: l3RawTextImportCreateSchema }, 201),
  operation("post", "/api/l3/imports/structured", "createL3StructuredImport", "owner", "sessionMutation", { body: l3StructuredImportCreateSchema }, 201),
  operation("post", "/api/l3/proposals", "createL3Proposal", "owner", "sessionMutation", { body: l3ProposalCreateSchema }, 201),
  operation("post", "/api/l3/recommendations/generate", "generateL3Recommendations", "owner", "sessionMutation", { body: l3RecommendationGenerateSchema }, 201),
  operation("get", "/api/l3/recommendations", "listL3Recommendations", "owner", "none", { query: l3RecommendationListQuerySchema }),
  operation("get", "/api/l3/recommendations/:id", "getL3Recommendation", "owner", "none"),
  operation("post", "/api/l3/recommendations/:id/accept", "acceptL3Recommendation", "owner", "sessionMutation"),
  operation("post", "/api/l3/recommendations/:id/reject", "rejectL3Recommendation", "owner", "sessionMutation", { body: l3RecommendationRejectSchema }),
  operation("get", "/api/l3/proposals", "listL3Proposals", "owner", "none", { query: l3ProposalListQuerySchema }),
  operation("get", "/api/l3/proposals/:id", "getL3Proposal", "owner", "none"),
  operation("post", "/api/l3/proposals/:id/validate", "validateL3Proposal", "owner", "sessionMutation"),
  operation("post", "/api/l3/proposals/:id/confirm", "confirmL3Proposal", "owner", "sessionMutation"),
  operation("post", "/api/l3/proposals/:id/reject", "rejectL3Proposal", "owner", "sessionMutation", { body: l3ProposalRejectSchema }),
] as const satisfies readonly ApiOperation[];
