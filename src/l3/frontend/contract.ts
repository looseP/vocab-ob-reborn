import type {
  Json,
  L3ContextDetail,
  L3GraphReadModel,
  L3ProposalBundle,
  L3ProposalConfirmResult,
  L3ProposalValidationResult,
  L3RecommendationAcceptResult,
  L3RecommendationBundle,
  L3RecommendationItemRow,
  L3SourceSpace,
  L3WordSpace,
} from "@/domain";

export type L3HttpMethod = "GET" | "POST";
export type L3ErrorStatus = 400 | 404 | 409 | 422 | 500;
export type L3RetryHint = "fix-input" | "refresh" | "review-items" | "retry";
export type L3ImportFlowState =
  | "idle"
  | "editing"
  | "submitting"
  | "proposalCreated"
  | "submitFailed"
  | "reviewingProposal"
  | "confirmed"
  | "rejected";
export type L3ProposalReviewState =
  | "needsValidation"
  | "valid"
  | "invalid"
  | "validating"
  | "confirming"
  | "confirmed"
  | "rejecting"
  | "rejected"
  | "conflict";
export type L3RecommendationReviewState =
  | "pending"
  | "accepting"
  | "accepted"
  | "rejecting"
  | "rejected"
  | "dismissed"
  | "expired"
  | "conflict";
export type L3GraphReadState = "idle" | "loading" | "loaded" | "empty" | "failed" | "staleAfterConfirm";

export interface NormalizedL3Error {
  status: L3ErrorStatus;
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
  itemErrors?: Array<{ itemId?: string; ordinal?: number; field?: string; message: string }>;
  retryHint: L3RetryHint;
  raw?: unknown;
}

export interface L3ApiErrorBody {
  error?: string;
  code?: string;
  message?: string;
  details?: unknown;
}

export interface L3ParseStats {
  contextCount: number;
  occurrenceCount: number;
  linkCount: number;
  skippedContextCount: number;
  warnings: string[];
}

export interface L3ImportProposalResponse {
  importJob: Record<string, unknown> & { id?: string; status?: string };
  proposal: Record<string, unknown> & { id?: string; status?: string; title?: string | null };
  items: unknown[];
  parseStats: L3ParseStats;
}

export interface L3PaginatedResponse<T> {
  items: T[];
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
}

export interface L3RawTextImportInput {
  wordbookId?: string | null;
  source: {
    sourceType: "article" | "book" | "video" | "audio" | "chat" | "manual" | "web" | "other";
    title: string;
    author?: string | null;
    url?: string | null;
    language?: string | null;
    metadata?: Record<string, unknown>;
  };
  text: string;
  targetWords?: Array<{ wordId?: string; slug?: string }>;
  options?: {
    contextType?: "sentence" | "paragraph";
    maxContexts?: number;
    minContextLength?: number;
    maxOccurrencesPerWordPerContext?: number;
  };
  provenance?: Record<string, unknown>;
}

export interface L3StructuredImportInput {
  wordbookId?: string | null;
  source: L3RawTextImportInput["source"];
  contexts: Array<{
    clientRef?: string | null;
    contextType: "sentence" | "paragraph" | "excerpt" | "dialogue" | "note";
    text: string;
    normalizedText?: string | null;
    language?: string | null;
    position?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    occurrences?: Array<{
      wordId?: string;
      slug?: string;
      surface: string;
      lemma?: string | null;
      startOffset?: number | null;
      endOffset?: number | null;
      confidence?: number | null;
      evidence?: Record<string, unknown>;
    }>;
    links?: Array<{
      wordId?: string | null;
      linkType:
        | "supports"
        | "illustrates"
        | "contrasts"
        | "collocates_with"
        | "synonym_of"
        | "antonym_of"
        | "derived_from"
        | "topic_related"
        | "manual_link";
      targetType: "word" | "l2_item" | "context" | "source" | "topic" | "external";
      targetId?: string | null;
      targetRef?: Record<string, unknown>;
      confidence?: number | null;
      provenance?: Record<string, unknown>;
    }>;
  }>;
  provenance?: Record<string, unknown>;
}

export interface L3ProposalCreateInput {
  wordbookId?: string | null;
  sourceType: "agent" | "import" | "external_tool" | "manual_draft" | "mcp_future" | "other";
  title?: string | null;
  summary?: string | null;
  inputHash?: string | null;
  proposedBy?: string | null;
  provenance?: Record<string, unknown>;
  items: Array<{
    itemType: "source" | "context" | "occurrence" | "context_link";
    clientRef?: string | null;
    payload: Record<string, unknown>;
  }>;
}

export interface L3RecommendationGenerateInput {
  wordbookId?: string | null;
  mode: "review_pack" | "learn_next" | "gap_scan" | "link_suggestions";
  seedSlug?: string | null;
  limit?: number | null;
  horizonDays?: number | null;
  dryRun?: boolean | null;
}

export interface L3ListProposalsParams {
  status?: "pending" | "confirmed" | "rejected" | "canceled";
  limit?: number;
  cursor?: string;
}

export interface L3ListRecommendationsParams {
  status?: "pending" | "accepted" | "rejected" | "dismissed" | "expired";
  recommendationType?: "review_pack" | "learn_next" | "link_gap" | "context_gap" | "l2_gap" | "weak_word" | "related_word";
  limit?: number;
  cursor?: string;
}

export interface L3GraphParams {
  wordbookId?: string;
  slug?: string;
  sourceId?: string;
  depth?: number;
  limit?: number;
  cursor?: string;
}

export interface L3SpaceParams {
  wordbookId?: string;
  limit?: number;
  cursor?: string;
}

export interface L3SourceSpaceParams {
  limit?: number;
  cursor?: string;
}

export interface L3ClientTransport {
  fetch(input: string, init?: { method?: L3HttpMethod; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

export interface L3FrontendClient {
  createRawTextImport(input: L3RawTextImportInput): Promise<L3ImportProposalResponse>;
  createStructuredImport(input: L3StructuredImportInput): Promise<L3ImportProposalResponse>;
  createProposal(input: L3ProposalCreateInput): Promise<L3ProposalBundle>;
  listProposals(params?: L3ListProposalsParams): Promise<L3PaginatedResponse<L3ProposalBundle["proposal"]>>;
  getProposal(id: string): Promise<L3ProposalBundle>;
  validateProposal(id: string): Promise<L3ProposalValidationResult>;
  confirmProposal(id: string): Promise<L3ProposalConfirmResult>;
  rejectProposal(id: string, reviewNote?: string | null): Promise<L3ProposalBundle>;
  generateRecommendations(input: L3RecommendationGenerateInput): Promise<L3RecommendationBundle>;
  listRecommendations(params?: L3ListRecommendationsParams): Promise<L3PaginatedResponse<L3RecommendationItemRow>>;
  getRecommendation(id: string): Promise<L3RecommendationItemRow>;
  acceptRecommendation(id: string): Promise<L3RecommendationAcceptResult>;
  rejectRecommendation(id: string, reviewNote?: string | null): Promise<L3RecommendationItemRow>;
  getContextDetail(id: string): Promise<L3ContextDetail>;
  getWordSpace(slug: string, params?: L3SpaceParams): Promise<L3WordSpace>;
  getSourceSpace(sourceId: string, params?: L3SourceSpaceParams): Promise<L3SourceSpace>;
  getGraph(params?: L3GraphParams): Promise<L3GraphReadModel>;
}

export interface L3CommandResult<T> {
  data: T;
  nextState: string;
  message?: string;
  invalidate: string[];
  refreshGraph: boolean;
  createsActiveL3: boolean;
}

export const L3_UI_COPY = {
  importCreatedProposal: "已生成待审核 proposal，确认后才会写入 L3",
  recommendationAcceptedProposal: "已生成待确认 proposal，确认后才会创建 active link",
  stateChanged: "状态已变化，请刷新后重试",
  proposalValidationFailed: "候选内容未通过校验，请查看具体条目",
  notFound: "资源不存在、已删除或无权限访问",
  unexpected: "操作失败，请稍后重试",
} as const;

const DEFAULT_HEADERS = { "Content-Type": "application/json" };

function appendQuery(path: string, params?: object): string {
  if (!params) return path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function extractFieldErrors(details: unknown): Record<string, string[]> | undefined {
  if (!details || typeof details !== "object") return undefined;
  const fieldErrors = (details as { fieldErrors?: unknown }).fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== "object") return undefined;

  const result: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(fieldErrors as Record<string, unknown>)) {
    if (Array.isArray(messages)) result[field] = messages.filter((message): message is string => typeof message === "string");
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractItemErrors(body: L3ApiErrorBody): NormalizedL3Error["itemErrors"] {
  const errors = (body.details as { errors?: unknown } | undefined)?.errors ?? (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return undefined;
  return errors
    .map((item) => {
      if (typeof item === "string") return { message: item };
      if (!item || typeof item !== "object") return null;
      const issue = item as Record<string, unknown>;
      const message = typeof issue.message === "string" ? issue.message : undefined;
      if (!message) return null;
      return {
        ...(typeof issue.itemId === "string" ? { itemId: issue.itemId } : {}),
        ...(typeof issue.ordinal === "number" ? { ordinal: issue.ordinal } : {}),
        ...(typeof issue.field === "string" ? { field: issue.field } : {}),
        message,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

export function normalizeL3Error(status: number, body: L3ApiErrorBody = {}): NormalizedL3Error {
  const safeStatus = (status === 400 || status === 404 || status === 409 || status === 422 || status === 500 ? status : 500) as L3ErrorStatus;
  const code = body.code ?? body.error ?? "INTERNAL";
  const rawMessage = body.message ?? body.error;

  if (safeStatus === 400) {
    return {
      status: safeStatus,
      code,
      message: rawMessage || "Request validation failed.",
      fieldErrors: extractFieldErrors(body.details),
      retryHint: "fix-input",
      raw: body,
    };
  }
  if (safeStatus === 404) {
    return {
      status: safeStatus,
      code,
      message: L3_UI_COPY.notFound,
      retryHint: "refresh",
      raw: body,
    };
  }
  if (safeStatus === 409) {
    return {
      status: safeStatus,
      code,
      message: L3_UI_COPY.stateChanged,
      retryHint: "refresh",
      raw: body,
    };
  }
  if (safeStatus === 422) {
    return {
      status: safeStatus,
      code,
      message: rawMessage || L3_UI_COPY.proposalValidationFailed,
      fieldErrors: extractFieldErrors(body.details),
      itemErrors: extractItemErrors(body),
      retryHint: "review-items",
      raw: body,
    };
  }
  return {
    status: safeStatus,
    code,
    message: L3_UI_COPY.unexpected,
    retryHint: "retry",
    raw: body,
  };
}

async function requestJson<T>(
  transport: L3ClientTransport,
  method: L3HttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await transport.fetch(path, {
    method,
    headers: DEFAULT_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw normalizeL3Error(response.status, payload as L3ApiErrorBody);
  return payload as T;
}

export function createL3FrontendClient(transport: L3ClientTransport): L3FrontendClient {
  return {
    createRawTextImport: (input) => requestJson(transport, "POST", "/api/l3/imports/raw-text", input),
    createStructuredImport: (input) => requestJson(transport, "POST", "/api/l3/imports/structured", input),
    createProposal: (input) => requestJson(transport, "POST", "/api/l3/proposals", input),
    listProposals: (params) => requestJson(transport, "GET", appendQuery("/api/l3/proposals", params)),
    getProposal: (id) => requestJson(transport, "GET", `/api/l3/proposals/${encodeURIComponent(id)}`),
    validateProposal: (id) => requestJson(transport, "POST", `/api/l3/proposals/${encodeURIComponent(id)}/validate`),
    confirmProposal: (id) => requestJson(transport, "POST", `/api/l3/proposals/${encodeURIComponent(id)}/confirm`),
    rejectProposal: (id, reviewNote) => requestJson(transport, "POST", `/api/l3/proposals/${encodeURIComponent(id)}/reject`, { reviewNote: reviewNote ?? null }),
    generateRecommendations: (input) => requestJson(transport, "POST", "/api/l3/recommendations/generate", input),
    listRecommendations: (params) => requestJson(transport, "GET", appendQuery("/api/l3/recommendations", params)),
    getRecommendation: (id) => requestJson(transport, "GET", `/api/l3/recommendations/${encodeURIComponent(id)}`),
    acceptRecommendation: (id) => requestJson(transport, "POST", `/api/l3/recommendations/${encodeURIComponent(id)}/accept`),
    rejectRecommendation: (id, reviewNote) => requestJson(transport, "POST", `/api/l3/recommendations/${encodeURIComponent(id)}/reject`, { reviewNote: reviewNote ?? null }),
    getContextDetail: (id) => requestJson(transport, "GET", `/api/l3/contexts/${encodeURIComponent(id)}`),
    getWordSpace: (slug, params) => requestJson(transport, "GET", appendQuery(`/api/l3/words/${encodeURIComponent(slug)}/space`, params)),
    getSourceSpace: (sourceId, params) => requestJson(transport, "GET", appendQuery(`/api/l3/sources/${encodeURIComponent(sourceId)}/space`, params)),
    getGraph: (params) => requestJson(transport, "GET", appendQuery("/api/l3/graph", validateGraphParams(params))),
  };
}

export function parseTargetWordInput(value: string): Array<{ slug: string }> {
  return value
    .split(/[\n,]+/g)
    .map((slug) => slug.trim())
    .filter((slug, index, slugs) => slug.length > 0 && slugs.indexOf(slug) === index)
    .map((slug) => ({ slug }));
}

export function validateGraphParams(params: L3GraphParams = {}): L3GraphParams {
  if (params.depth !== undefined && (!Number.isInteger(params.depth) || params.depth < 1 || params.depth > 2)) {
    throw normalizeL3Error(400, { error: "VALIDATION_ERROR", details: { fieldErrors: { depth: ["Depth must be 1 or 2."] } } });
  }
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 300)) {
    throw normalizeL3Error(400, { error: "VALIDATION_ERROR", details: { fieldErrors: { limit: ["Limit must be between 1 and 300."] } } });
  }
  return params;
}

export function applyImportSuccess<T extends L3ImportProposalResponse>(data: T): L3CommandResult<T> {
  return {
    data,
    nextState: "proposalCreated" satisfies L3ImportFlowState,
    message: L3_UI_COPY.importCreatedProposal,
    invalidate: ["l3.proposals.list"],
    refreshGraph: false,
    createsActiveL3: false,
  };
}

export function applyProposalValidationResult<T extends L3ProposalValidationResult>(data: T): L3CommandResult<T> {
  return {
    data,
    nextState: (data.valid ? "valid" : "invalid") satisfies L3ProposalReviewState,
    invalidate: ["l3.proposals.detail"],
    refreshGraph: false,
    createsActiveL3: false,
  };
}

export function applyProposalConfirmSuccess<T extends L3ProposalConfirmResult>(data: T): L3CommandResult<T> {
  return {
    data,
    nextState: "confirmed" satisfies L3ProposalReviewState,
    invalidate: ["l3.proposals.detail", "l3.proposals.list", "l3.graph", "l3.context.detail", "l3.word.space", "l3.source.space"],
    refreshGraph: true,
    createsActiveL3: true,
  };
}

export function applyProposalRejectSuccess<T extends L3ProposalBundle>(data: T): L3CommandResult<T> {
  return {
    data,
    nextState: "rejected" satisfies L3ProposalReviewState,
    invalidate: ["l3.proposals.detail", "l3.proposals.list"],
    refreshGraph: false,
    createsActiveL3: false,
  };
}

export function applyRecommendationAcceptSuccess<T extends L3RecommendationAcceptResult>(data: T): L3CommandResult<T> {
  return {
    data,
    nextState: "accepted" satisfies L3RecommendationReviewState,
    message: data.proposal ? L3_UI_COPY.recommendationAcceptedProposal : undefined,
    invalidate: data.proposal
      ? ["l3.recommendations.detail", "l3.recommendations.list", "l3.proposals.list"]
      : ["l3.recommendations.detail", "l3.recommendations.list"],
    refreshGraph: false,
    createsActiveL3: false,
  };
}

export function applyRecommendationRejectSuccess<T extends L3RecommendationItemRow>(data: T): L3CommandResult<T> {
  return {
    data,
    nextState: "rejected" satisfies L3RecommendationReviewState,
    invalidate: ["l3.recommendations.detail", "l3.recommendations.list"],
    refreshGraph: false,
    createsActiveL3: false,
  };
}

export function graphStateFromRead(data: L3GraphReadModel): L3GraphReadState {
  return data.nodes.length === 0 ? "empty" : "loaded";
}

export function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
