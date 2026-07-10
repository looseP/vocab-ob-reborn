import type {
  Json,
  L3ContextDetail,
  L3ContextLinkRow,
  L3ContextLinkTargetType,
  L3ContextLinkType,
  L3ContextRow,
  L3ContextType,
  L3GraphReadModel,
  L3OccurrenceRow,
  L3ProposalBundle,
  L3ProposalConfirmResult,
  L3ProposalValidationResult,
  L3RecommendationAcceptResult,
  L3RecommendationBundle,
  L3RecommendationItemRow,
  L3SourceRow,
  L3SourceSpace,
  L3SourceType,
  L3WordSpace,
} from "@/domain";

export type L3HttpMethod = "GET" | "POST" | "DELETE";
export type L3ErrorStatus = 0 | 400 | 404 | 409 | 422 | 500;
export type L3ErrorKind =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "validation"
  | "unexpected"
  | "network"
  | "aborted";
export type L3RetryHint = "fix-input" | "refresh" | "review-items" | "retry" | "none";
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
  | "pending"
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
  | "proposalBridgeCreated"
  | "futureAction"
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
  kind: L3ErrorKind;
  fieldErrors?: Record<string, string[]>;
  itemErrors?: Array<{ itemId?: string; ordinal?: number; field?: string; message: string }>;
  retryHint: L3RetryHint;
  details?: unknown;
  raw?: unknown;
}

export interface L3ApiErrorBody {
  error?: string | { code?: string; message?: string; details?: unknown; errors?: unknown; fieldErrors?: unknown; itemErrors?: unknown };
  code?: string;
  message?: string;
  details?: unknown;
  errors?: unknown;
  fieldErrors?: unknown;
  itemErrors?: unknown;
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
  limit?: number | null;
  cursor?: string | null;
}

export interface L3ListRecommendationsParams {
  status?: "pending" | "accepted" | "rejected" | "dismissed" | "expired";
  recommendationType?: "review_pack" | "learn_next" | "link_gap" | "context_gap" | "l2_gap" | "weak_word" | "related_word";
  limit?: number | null;
  cursor?: string | null;
}

export interface L3GraphParams {
  wordbookId?: string | null;
  slug?: string | null;
  sourceId?: string | null;
  depth?: number | null;
  limit?: number | null;
  cursor?: string | null;
}

export interface L3SpaceParams {
  wordbookId?: string | null;
  limit?: number | null;
  cursor?: string | null;
}

export interface L3SourceSpaceParams {
  limit?: number | null;
  cursor?: string | null;
}

export interface L3ManualSourceCreateInput {
  wordbookId?: string | null;
  sourceType: L3SourceType;
  title: string;
  author?: string | null;
  url?: string | null;
  language?: string | null;
  metadata?: Record<string, unknown>;
}

export interface L3ManualContextCreateInput {
  sourceId: string;
  contextType: L3ContextType;
  text: string;
  normalizedText?: string | null;
  language?: string | null;
  position?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface L3ManualOccurrenceCreateInput {
  contextId: string;
  wordId?: string;
  slug?: string;
  surface: string;
  lemma?: string | null;
  startOffset?: number | null;
  endOffset?: number | null;
  confidence?: number | null;
  evidence?: Record<string, unknown>;
}

export interface L3ManualContextLinkCreateInput {
  contextId?: string | null;
  wordId?: string | null;
  linkType: L3ContextLinkType;
  targetType: L3ContextLinkTargetType;
  targetId?: string | null;
  targetRef?: Record<string, unknown>;
  confidence?: number | null;
  provenance?: Record<string, unknown>;
}

export interface L3ManualSourceCreateResponse {
  source: L3SourceRow;
}

export interface L3ManualContextCreateResponse {
  context: L3ContextRow;
}

export interface L3ManualOccurrenceCreateResponse {
  occurrence: L3OccurrenceRow;
}

export interface L3ManualContextLinkCreateResponse {
  link: L3ContextLinkRow;
}

export interface L3ManualDeleteResponse {
  deleted: {
    entityType: "source" | "context" | "occurrence" | "context_link";
    id: string;
  };
  activeReadInvalidation: true;
}

export interface L3ClientTransport {
  fetch(input: string, init?: { method?: L3HttpMethod; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

export interface L3FrontendClient {
  createSource(input: L3ManualSourceCreateInput): Promise<L3ManualSourceCreateResponse>;
  createContext(input: L3ManualContextCreateInput): Promise<L3ManualContextCreateResponse>;
  createOccurrence(input: L3ManualOccurrenceCreateInput): Promise<L3ManualOccurrenceCreateResponse>;
  createContextLink(input: L3ManualContextLinkCreateInput): Promise<L3ManualContextLinkCreateResponse>;
  deleteOccurrence(id: string): Promise<L3ManualDeleteResponse>;
  deleteContextLink(id: string): Promise<L3ManualDeleteResponse>;
  deleteSource(id: string): Promise<L3ManualDeleteResponse>;
  deleteContext(id: string): Promise<L3ManualDeleteResponse>;
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

export interface L3CacheSignal {
  keys: string[];
  activeReadInvalidation: boolean;
  proposalInvalidation: boolean;
  recommendationInvalidation: boolean;
  reason: string;
  nextSuggestedAction?: string;
}

export interface L3CommandResult<T> {
  data: T;
  nextState: string;
  message?: string;
  invalidate: string[];
  refreshGraph: boolean;
  createsActiveL3: boolean;
  cache: L3CacheSignal;
}

export const L3_UI_COPY = {
  importCreatedProposal: "Import created a proposal. Confirm it before active L3 changes.",
  recommendationAcceptedProposal: "Recommendation created a proposal. Confirm it before creating the active link.",
  stateChanged: "State changed. Refresh and retry.",
  proposalValidationFailed: "Proposal validation failed. Review item-level feedback.",
  notFound: "Resource is missing, deleted, or outside your scope.",
  unexpected: "Operation failed. Retry later.",
  network: "Network request failed. Check connectivity and retry.",
  aborted: "Request was cancelled.",
} as const;

const DEFAULT_HEADERS = { "Content-Type": "application/json" };
const SPACE_LIMIT_MAX = 100;
const GRAPH_LIMIT_MAX = 300;
const RECOMMENDATION_LIMIT_MAX = 100;
const RECOMMENDATION_HORIZON_MAX = 90;

function appendQuery(path: string, params?: object): string {
  if (!params) return path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function compactKeys(keys: string[]): string[] {
  return [...new Set(keys)];
}

function cacheSignal(input: {
  keys: string[];
  activeReadInvalidation?: boolean;
  proposalInvalidation?: boolean;
  recommendationInvalidation?: boolean;
  reason: string;
  nextSuggestedAction?: string;
}): L3CacheSignal {
  return {
    keys: compactKeys(input.keys),
    activeReadInvalidation: input.activeReadInvalidation ?? false,
    proposalInvalidation: input.proposalInvalidation ?? false,
    recommendationInvalidation: input.recommendationInvalidation ?? false,
    reason: input.reason,
    ...(input.nextSuggestedAction ? { nextSuggestedAction: input.nextSuggestedAction } : {}),
  };
}

function frontendValidationError(field: string, message: string): NormalizedL3Error {
  return normalizeL3Error(400, {
    code: "FRONTEND_VALIDATION_ERROR",
    message: "Request validation failed.",
    details: { fieldErrors: { [field]: [message] } },
  });
}

function requireNonEmptyText(value: string | null | undefined, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw frontendValidationError(field, `${field} cannot be empty.`);
  }
}

function validateExplicitId(id: string): string {
  requireNonEmptyText(id, "id");
  return id.trim();
}

function validateLimit(value: number | null | undefined, max: number, field = "limit"): void {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw frontendValidationError(field, `${field} must be between 1 and ${max}.`);
  }
}

function normalizeErrorBody(body: unknown): {
  code?: string;
  message?: string;
  details?: unknown;
  errors?: unknown;
  fieldErrors?: unknown;
  itemErrors?: unknown;
  raw: unknown;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return typeof body === "string" && body.trim().length > 0
      ? { message: body, raw: body }
      : { raw: body };
  }
  const record = body as L3ApiErrorBody;
  if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
    const error = record.error;
    return {
      code: error.code ?? record.code,
      message: error.message ?? record.message,
      details: error.details ?? record.details,
      errors: error.errors ?? record.errors,
      fieldErrors: error.fieldErrors ?? record.fieldErrors,
      itemErrors: error.itemErrors ?? record.itemErrors,
      raw: body,
    };
  }
  return {
    code: record.code,
    message: typeof record.error === "string" ? record.error : record.message,
    details: record.details,
    errors: record.errors,
    fieldErrors: record.fieldErrors,
    itemErrors: record.itemErrors,
    raw: body,
  };
}

function extractFieldErrors(details: unknown, bodyFieldErrors?: unknown): Record<string, string[]> | undefined {
  const fieldErrors =
    (details && typeof details === "object" && !Array.isArray(details)
      ? (details as { fieldErrors?: unknown }).fieldErrors
      : undefined) ?? bodyFieldErrors;
  if (!fieldErrors || typeof fieldErrors !== "object" || Array.isArray(fieldErrors)) return undefined;

  const result: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(fieldErrors as Record<string, unknown>)) {
    if (Array.isArray(messages)) {
      const filtered = messages.filter((message): message is string => typeof message === "string");
      if (filtered.length > 0) result[field] = filtered;
    } else if (typeof messages === "string") {
      result[field] = [messages];
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractItemErrors(normalized: ReturnType<typeof normalizeErrorBody>): NormalizedL3Error["itemErrors"] {
  const errors =
    (normalized.details && typeof normalized.details === "object" && !Array.isArray(normalized.details)
      ? (normalized.details as { errors?: unknown; itemErrors?: unknown }).itemErrors ??
        (normalized.details as { errors?: unknown; itemErrors?: unknown }).errors
      : undefined) ??
    normalized.itemErrors ??
    normalized.errors;
  if (!Array.isArray(errors)) return undefined;
  const result = errors
    .map((item) => {
      if (typeof item === "string") return { message: item };
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
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
  return result.length > 0 ? result : undefined;
}

function kindForStatus(status: L3ErrorStatus): L3ErrorKind {
  if (status === 400) return "bad_request";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422) return "validation";
  return "unexpected";
}

function retryHintForKind(kind: L3ErrorKind): L3RetryHint {
  if (kind === "bad_request") return "fix-input";
  if (kind === "not_found" || kind === "conflict") return "refresh";
  if (kind === "validation") return "review-items";
  if (kind === "aborted") return "none";
  return "retry";
}

function messageForKind(kind: L3ErrorKind, fallback?: string): string {
  if (kind === "not_found") return fallback || L3_UI_COPY.notFound;
  if (kind === "conflict") return fallback || L3_UI_COPY.stateChanged;
  if (kind === "validation") return fallback || L3_UI_COPY.proposalValidationFailed;
  if (kind === "network") return fallback || L3_UI_COPY.network;
  if (kind === "aborted") return fallback || L3_UI_COPY.aborted;
  if (kind === "bad_request") return fallback || "Request validation failed.";
  return fallback || L3_UI_COPY.unexpected;
}

export function normalizeL3Error(status: number, body: L3ApiErrorBody | string | null | undefined = {}): NormalizedL3Error {
  const safeStatus = (status === 400 || status === 404 || status === 409 || status === 422 || status === 500 ? status : 500) as L3ErrorStatus;
  const normalized = normalizeErrorBody(body ?? {});
  const kind = kindForStatus(safeStatus);
  const code = normalized.code ?? (kind === "unexpected" ? "INTERNAL" : kind.toUpperCase());
  return {
    status: safeStatus,
    code,
    message: messageForKind(kind, normalized.message),
    kind,
    fieldErrors: extractFieldErrors(normalized.details, normalized.fieldErrors),
    itemErrors: extractItemErrors(normalized),
    retryHint: retryHintForKind(kind),
    details: normalized.details,
    raw: normalized.raw,
  };
}

export function normalizeL3TransportError(error: unknown): NormalizedL3Error {
  const maybeError = error as { name?: unknown; message?: unknown };
  const aborted = maybeError?.name === "AbortError";
  const kind: L3ErrorKind = aborted ? "aborted" : "network";
  return {
    status: 0,
    code: aborted ? "ABORTED" : "NETWORK_ERROR",
    message: messageForKind(kind, typeof maybeError?.message === "string" ? maybeError.message : undefined),
    kind,
    retryHint: retryHintForKind(kind),
    raw: error,
  };
}

async function requestJson<T>(
  transport: L3ClientTransport,
  method: L3HttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  try {
    const response = await transport.fetch(path, {
      method,
      headers: DEFAULT_HEADERS,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw normalizeL3Error(response.status, payload as L3ApiErrorBody);
    return payload as T;
  } catch (error) {
    if (isNormalizedL3Error(error)) throw error;
    throw normalizeL3TransportError(error);
  }
}

export function createL3FrontendClient(transport: L3ClientTransport): L3FrontendClient {
  return {
    createSource: (input) => requestJson(transport, "POST", "/api/l3/sources", validateManualSourceCreateInput(input)),
    createContext: (input) => requestJson(transport, "POST", "/api/l3/contexts", validateManualContextCreateInput(input)),
    createOccurrence: (input) => requestJson(transport, "POST", "/api/l3/occurrences", validateManualOccurrenceCreateInput(input)),
    createContextLink: (input) => requestJson(transport, "POST", "/api/l3/context-links", validateManualContextLinkCreateInput(input)),
    deleteOccurrence: (id) => requestJson(transport, "DELETE", `/api/l3/occurrences/${encodeURIComponent(validateExplicitId(id))}`),
    deleteContextLink: (id) => requestJson(transport, "DELETE", `/api/l3/context-links/${encodeURIComponent(validateExplicitId(id))}`),
    deleteSource: (id) => requestJson(transport, "DELETE", `/api/l3/sources/${encodeURIComponent(validateExplicitId(id))}`),
    deleteContext: (id) => requestJson(transport, "DELETE", `/api/l3/contexts/${encodeURIComponent(validateExplicitId(id))}`),
    createRawTextImport: (input) => requestJson(transport, "POST", "/api/l3/imports/raw-text", validateRawTextImportInput(input)),
    createStructuredImport: (input) => requestJson(transport, "POST", "/api/l3/imports/structured", validateStructuredImportInput(input)),
    createProposal: (input) => requestJson(transport, "POST", "/api/l3/proposals", validateProposalCreateInput(input)),
    listProposals: (params) => requestJson(transport, "GET", appendQuery("/api/l3/proposals", validateListParams(params))),
    getProposal: (id) => requestJson(transport, "GET", `/api/l3/proposals/${encodeURIComponent(id)}`),
    validateProposal: (id) => requestJson(transport, "POST", `/api/l3/proposals/${encodeURIComponent(id)}/validate`),
    confirmProposal: (id) => requestJson(transport, "POST", `/api/l3/proposals/${encodeURIComponent(id)}/confirm`),
    rejectProposal: (id, reviewNote) => requestJson(transport, "POST", `/api/l3/proposals/${encodeURIComponent(id)}/reject`, { reviewNote: reviewNote ?? null }),
    generateRecommendations: (input) => requestJson(transport, "POST", "/api/l3/recommendations/generate", validateRecommendationGenerateInput(input)),
    listRecommendations: (params) => requestJson(transport, "GET", appendQuery("/api/l3/recommendations", validateListParams(params))),
    getRecommendation: (id) => requestJson(transport, "GET", `/api/l3/recommendations/${encodeURIComponent(id)}`),
    acceptRecommendation: (id) => requestJson(transport, "POST", `/api/l3/recommendations/${encodeURIComponent(id)}/accept`),
    rejectRecommendation: (id, reviewNote) => requestJson(transport, "POST", `/api/l3/recommendations/${encodeURIComponent(id)}/reject`, { reviewNote: reviewNote ?? null }),
    getContextDetail: (id) => requestJson(transport, "GET", `/api/l3/contexts/${encodeURIComponent(id)}`),
    getWordSpace: (slug, params) => requestJson(transport, "GET", appendQuery(`/api/l3/words/${encodeURIComponent(slug)}/space`, validateSpaceParams(params))),
    getSourceSpace: (sourceId, params) => requestJson(transport, "GET", appendQuery(`/api/l3/sources/${encodeURIComponent(sourceId)}/space`, validateSourceSpaceParams(params))),
    getGraph: (params) => requestJson(transport, "GET", appendQuery("/api/l3/graph", validateGraphParams(params))),
  };
}

export function parseTargetWordInput(value: string): Array<{ slug: string }> {
  const seen = new Set<string>();
  const result: Array<{ slug: string }> = [];
  for (const raw of value.split(/[\n,]+/g)) {
    const slug = raw.trim();
    if (!slug) continue;
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ slug });
  }
  return result;
}

export function validateRawTextImportInput(input: L3RawTextImportInput): L3RawTextImportInput {
  requireNonEmptyText(input.source.title, "source.title");
  requireNonEmptyText(input.text, "text");
  for (const targetWord of input.targetWords ?? []) {
    if (!targetWord.wordId && (!targetWord.slug || targetWord.slug.trim().length === 0)) {
      throw frontendValidationError("targetWords", "targetWords entries require wordId or non-empty slug.");
    }
  }
  return input;
}

export function validateStructuredImportInput(input: L3StructuredImportInput): L3StructuredImportInput {
  requireNonEmptyText(input.source.title, "source.title");
  if (input.contexts.length === 0) throw frontendValidationError("contexts", "contexts cannot be empty.");
  for (const [index, context] of input.contexts.entries()) {
    requireNonEmptyText(context.text, `contexts.${index}.text`);
    for (const [occurrenceIndex, occurrence] of (context.occurrences ?? []).entries()) {
      requireNonEmptyText(occurrence.surface, `contexts.${index}.occurrences.${occurrenceIndex}.surface`);
      if (!occurrence.wordId && (!occurrence.slug || occurrence.slug.trim().length === 0)) {
        throw frontendValidationError(`contexts.${index}.occurrences.${occurrenceIndex}`, "occurrence requires wordId or non-empty slug.");
      }
    }
  }
  return input;
}

export function validateProposalCreateInput(input: L3ProposalCreateInput): L3ProposalCreateInput {
  if (input.items.length === 0) throw frontendValidationError("items", "Proposal requires at least one item.");
  return input;
}

export function validateManualSourceCreateInput(input: L3ManualSourceCreateInput): L3ManualSourceCreateInput {
  requireNonEmptyText(input.title, "title");
  return input;
}

export function validateManualContextCreateInput(input: L3ManualContextCreateInput): L3ManualContextCreateInput {
  requireNonEmptyText(input.sourceId, "sourceId");
  requireNonEmptyText(input.text, "text");
  return input;
}

export function validateManualOccurrenceCreateInput(input: L3ManualOccurrenceCreateInput): L3ManualOccurrenceCreateInput {
  requireNonEmptyText(input.contextId, "contextId");
  requireNonEmptyText(input.surface, "surface");
  if (!input.wordId && (!input.slug || input.slug.trim().length === 0)) {
    throw frontendValidationError("wordId", "wordId or slug is required.");
  }
  if ((input.startOffset === undefined || input.startOffset === null) !== (input.endOffset === undefined || input.endOffset === null)) {
    throw frontendValidationError("startOffset", "startOffset and endOffset must be supplied together.");
  }
  return input;
}

export function validateManualContextLinkCreateInput(input: L3ManualContextLinkCreateInput): L3ManualContextLinkCreateInput {
  if ((!input.contextId || input.contextId.trim().length === 0) && (!input.wordId || input.wordId.trim().length === 0)) {
    throw frontendValidationError("contextId", "contextId or wordId is required.");
  }
  if (
    (input.targetType === "word" || input.targetType === "context" || input.targetType === "source") &&
    (!input.targetId || input.targetId.trim().length === 0)
  ) {
    throw frontendValidationError("targetId", `targetId is required for ${input.targetType} targets.`);
  }
  if (input.targetType === "l2_item") {
    const ref = input.targetRef ?? {};
    const hasField = typeof ref.field === "string" && ref.field.trim().length > 0;
    const hasStableRef = ["contentId", "hash", "sourceRef"].some((key) => typeof ref[key] === "string" && String(ref[key]).trim().length > 0);
    if (!hasField || !hasStableRef) {
      throw frontendValidationError("targetRef", "l2_item targetRef requires field plus contentId, hash, or sourceRef.");
    }
  }
  return input;
}

export function validateRecommendationGenerateInput(input: L3RecommendationGenerateInput): L3RecommendationGenerateInput {
  validateLimit(input.limit, RECOMMENDATION_LIMIT_MAX);
  if (input.horizonDays !== undefined && input.horizonDays !== null) {
    if (!Number.isInteger(input.horizonDays) || input.horizonDays < 1 || input.horizonDays > RECOMMENDATION_HORIZON_MAX) {
      throw frontendValidationError("horizonDays", `horizonDays must be between 1 and ${RECOMMENDATION_HORIZON_MAX}.`);
    }
  }
  return input;
}

export function validateListParams<T extends { limit?: number | null } | undefined>(params: T): T {
  validateLimit(params?.limit, SPACE_LIMIT_MAX);
  return params;
}

export function validateSpaceParams(params: L3SpaceParams = {}): L3SpaceParams {
  validateLimit(params.limit, SPACE_LIMIT_MAX);
  return params;
}

export function validateSourceSpaceParams(params: L3SourceSpaceParams = {}): L3SourceSpaceParams {
  validateLimit(params.limit, SPACE_LIMIT_MAX);
  return params;
}

export function validateGraphParams(params: L3GraphParams = {}): L3GraphParams {
  if (params.depth !== undefined && params.depth !== null && (!Number.isInteger(params.depth) || params.depth < 1 || params.depth > 2)) {
    throw frontendValidationError("depth", "Depth must be 1 or 2.");
  }
  validateLimit(params.limit, GRAPH_LIMIT_MAX);
  return params;
}

export function applyImportSuccess<T extends L3ImportProposalResponse>(data: T): L3CommandResult<T> {
  const proposalId = typeof data.proposal.id === "string" ? data.proposal.id : undefined;
  const keys = ["l3.proposals.list", ...(proposalId ? [`l3.proposals.detail:${proposalId}`] : [])];
  return {
    data,
    nextState: "proposalCreated" satisfies L3ImportFlowState,
    message: L3_UI_COPY.importCreatedProposal,
    invalidate: keys,
    refreshGraph: false,
    createsActiveL3: false,
    cache: cacheSignal({
      keys,
      proposalInvalidation: true,
      reason: "import_created_pending_proposal",
      nextSuggestedAction: proposalId ? "review_proposal" : "refresh_proposals",
    }),
  };
}

export function applyProposalValidationResult<T extends L3ProposalValidationResult>(data: T): L3CommandResult<T> {
  const keys = [`l3.proposals.detail:${data.proposal.id}`];
  return {
    data,
    nextState: (data.valid ? "valid" : "invalid") satisfies L3ProposalReviewState,
    invalidate: keys,
    refreshGraph: false,
    createsActiveL3: false,
    cache: cacheSignal({
      keys,
      proposalInvalidation: true,
      reason: data.valid ? "proposal_validation_passed" : "proposal_validation_feedback",
      nextSuggestedAction: data.valid ? "confirm_or_reject" : "review_items",
    }),
  };
}

export function applyProposalConfirmSuccess<T extends L3ProposalConfirmResult>(data: T): L3CommandResult<T> {
  const activeTypes = new Set(data.activeEntities.map((entity) => entity.activeEntityType));
  const keys = [
    "l3.proposals.list",
    `l3.proposals.detail:${data.proposal.id}`,
    "l3.graph",
    ...(activeTypes.has("context") ? ["l3.context.detail"] : []),
    ...(activeTypes.has("source") || activeTypes.has("context") || activeTypes.has("occurrence") || activeTypes.has("context_link")
      ? ["l3.word.space", "l3.source.space"]
      : []),
  ];
  return {
    data,
    nextState: "confirmed" satisfies L3ProposalReviewState,
    invalidate: compactKeys(keys),
    refreshGraph: true,
    createsActiveL3: true,
    cache: cacheSignal({
      keys,
      activeReadInvalidation: true,
      proposalInvalidation: true,
      reason: "proposal_confirmed_active_l3_created",
      nextSuggestedAction: "refresh_active_reads",
    }),
  };
}

export function applyManualDeleteSuccess<T extends L3ManualDeleteResponse>(data: T): L3CommandResult<T> {
  const keys = ["l3.graph", "l3.context.detail", "l3.word.space", "l3.source.space"];
  return {
    data,
    nextState: "deleted",
    message: `${data.deleted.entityType} deleted.`,
    invalidate: keys,
    refreshGraph: true,
    createsActiveL3: false,
    cache: cacheSignal({
      keys,
      activeReadInvalidation: true,
      proposalInvalidation: false,
      recommendationInvalidation: false,
      reason: "manual_active_l3_deleted",
      nextSuggestedAction: "refresh_active_reads",
    }),
  };
}

export function applyProposalRejectSuccess<T extends L3ProposalBundle>(data: T): L3CommandResult<T> {
  const keys = ["l3.proposals.list", `l3.proposals.detail:${data.proposal.id}`];
  return {
    data,
    nextState: "rejected" satisfies L3ProposalReviewState,
    invalidate: keys,
    refreshGraph: false,
    createsActiveL3: false,
    cache: cacheSignal({
      keys,
      proposalInvalidation: true,
      reason: "proposal_rejected_no_active_l3_change",
    }),
  };
}

export function applyRecommendationGenerateSuccess<T extends L3RecommendationBundle>(data: T): L3CommandResult<T> {
  const keys = data.run.id === "dry-run" ? [] : ["l3.recommendations.list"];
  return {
    data,
    nextState: "pending" satisfies L3RecommendationReviewState,
    invalidate: keys,
    refreshGraph: false,
    createsActiveL3: false,
    cache: cacheSignal({
      keys,
      recommendationInvalidation: keys.length > 0,
      reason: data.run.id === "dry-run" ? "recommendation_dry_run_no_cache_change" : "recommendations_generated",
    }),
  };
}

export function applyRecommendationAcceptSuccess<T extends L3RecommendationAcceptResult>(data: T): L3CommandResult<T> {
  const proposalId = data.proposal?.proposal.id;
  const keys = [
    "l3.recommendations.detail",
    "l3.recommendations.list",
    ...(proposalId ? ["l3.proposals.list", `l3.proposals.detail:${proposalId}`] : []),
  ];
  return {
    data,
    nextState: (data.proposal ? "proposalBridgeCreated" : "futureAction") satisfies L3RecommendationReviewState,
    message: data.proposal ? L3_UI_COPY.recommendationAcceptedProposal : undefined,
    invalidate: keys,
    refreshGraph: false,
    createsActiveL3: false,
    cache: cacheSignal({
      keys,
      proposalInvalidation: Boolean(data.proposal),
      recommendationInvalidation: true,
      reason: data.proposal ? "recommendation_accept_created_pending_proposal" : "recommendation_accept_future_action",
      nextSuggestedAction: data.proposal ? "review_proposal" : "handle_future_action",
    }),
  };
}

export function applyRecommendationRejectSuccess<T extends L3RecommendationItemRow>(data: T): L3CommandResult<T> {
  const keys = ["l3.recommendations.detail", "l3.recommendations.list"];
  return {
    data,
    nextState: "rejected" satisfies L3RecommendationReviewState,
    invalidate: keys,
    refreshGraph: false,
    createsActiveL3: false,
    cache: cacheSignal({
      keys,
      recommendationInvalidation: true,
      reason: "recommendation_rejected_no_active_l3_change",
    }),
  };
}

export function applyGraphReadSuccess<T extends L3GraphReadModel>(data: T): L3CommandResult<T> {
  return {
    data,
    nextState: graphStateFromRead(data),
    invalidate: [],
    refreshGraph: false,
    createsActiveL3: false,
    cache: cacheSignal({ keys: [], reason: "graph_read_no_invalidation" }),
  };
}

export function proposalActionsForStatus(status: string): {
  state: L3ProposalReviewState;
  canValidate: boolean;
  canConfirm: boolean;
  canReject: boolean;
} {
  if (status === "confirmed") return { state: "confirmed", canValidate: false, canConfirm: false, canReject: false };
  if (status === "rejected") return { state: "rejected", canValidate: false, canConfirm: false, canReject: false };
  if (status === "pending") return { state: "needsValidation", canValidate: true, canConfirm: true, canReject: true };
  return { state: "conflict", canValidate: false, canConfirm: false, canReject: false };
}

export function recommendationActionForAcceptResult(result: L3RecommendationAcceptResult): "proposalBridgeCreated" | "futureAction" {
  return result.proposal ? "proposalBridgeCreated" : "futureAction";
}

export function graphStateAfterConfirm(): L3GraphReadState {
  return "staleAfterConfirm";
}

export function graphStateFromRead(data: L3GraphReadModel): L3GraphReadState {
  return data.nodes.length === 0 ? "empty" : "loaded";
}

export function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNormalizedL3Error(value: unknown): value is NormalizedL3Error {
  return value !== null && typeof value === "object" && "kind" in value && "retryHint" in value && "status" in value;
}
