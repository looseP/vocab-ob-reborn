import type { L3RecommendationAcceptResult, L3RecommendationBundle, L3RecommendationItemRow, L3RecommendationStatus, L3RecommendationType } from "@/domain";
import {
  applyRecommendationAcceptSuccess,
  applyRecommendationGenerateSuccess,
  applyRecommendationRejectSuccess,
  normalizeL3Error,
  type L3RecommendationGenerateInput,
  type L3RecommendationReviewState,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";

export const recommendationModes: L3RecommendationGenerateInput["mode"][] = ["review_pack", "learn_next", "gap_scan", "link_suggestions"];
export const recommendationStatuses: L3RecommendationStatus[] = ["pending", "accepted", "rejected", "dismissed", "expired"];
export const recommendationTypes: L3RecommendationType[] = ["review_pack", "learn_next", "link_gap", "context_gap", "l2_gap", "weak_word", "related_word"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function compactJson(value: unknown, maxLength = 220): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized;
  } catch {
    return "Unserializable payload";
  }
}

function parseOptionalInteger(value: string, field: string, max: number, fieldErrors: Record<string, string[]>): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    fieldErrors[field] = [`${field} must be between 1 and ${max}.`];
    return null;
  }
  return parsed;
}

function recommendationFormError(fieldErrors: Record<string, string[]>): NormalizedL3Error {
  return normalizeL3Error(400, {
    code: "FRONTEND_VALIDATION_ERROR",
    message: "Request validation failed.",
    details: { fieldErrors },
  });
}

export function buildRecommendationGeneratePayload(input: {
  mode: L3RecommendationGenerateInput["mode"];
  wordbookId: string;
  seedSlug: string;
  limit: string;
  horizonDays: string;
  dryRun: boolean;
}): L3RecommendationGenerateInput {
  const fieldErrors: Record<string, string[]> = {};
  const limit = parseOptionalInteger(input.limit, "limit", 100, fieldErrors);
  const horizonDays = parseOptionalInteger(input.horizonDays, "horizonDays", 90, fieldErrors);
  if (Object.keys(fieldErrors).length > 0) throw recommendationFormError(fieldErrors);

  return {
    mode: input.mode,
    ...(input.wordbookId.trim() ? { wordbookId: input.wordbookId.trim() } : {}),
    ...(input.seedSlug.trim() ? { seedSlug: input.seedSlug.trim() } : {}),
    ...(limit === null ? {} : { limit }),
    ...(horizonDays === null ? {} : { horizonDays }),
    dryRun: input.dryRun,
  };
}

export function summarizeRecommendationItem(item: L3RecommendationItemRow): string {
  return `${item.recommendation_type} / ${item.status}: ${item.title}`;
}

export function recommendationActionsForStatus(status: L3RecommendationStatus): {
  state: L3RecommendationReviewState;
  canAccept: boolean;
  canReject: boolean;
} {
  if (status === "pending") return { state: "pending", canAccept: true, canReject: true };
  if (status === "accepted") return { state: "accepted", canAccept: false, canReject: false };
  if (status === "rejected") return { state: "rejected", canAccept: false, canReject: false };
  if (status === "dismissed") return { state: "dismissed", canAccept: false, canReject: false };
  return { state: "expired", canAccept: false, canReject: false };
}

export function applyRecommendationGenerateUiResult(data: L3RecommendationBundle) {
  return applyRecommendationGenerateSuccess(data);
}

export function applyRecommendationAcceptUiResult(data: L3RecommendationAcceptResult) {
  return applyRecommendationAcceptSuccess(data);
}

export function applyRecommendationRejectUiResult(data: L3RecommendationItemRow) {
  return applyRecommendationRejectSuccess(data);
}

export function proposalIdFromRecommendationAccept(result: L3RecommendationAcceptResult | null): string | null {
  return result?.proposal?.proposal.id ?? null;
}

export function recommendationAcceptMessage(result: L3RecommendationAcceptResult | null): string | null {
  if (!result) return null;
  if (result.proposal) return "Proposal created; review required before active L3 link exists.";
  if (result.actionPayload) return "This acceptance records a future action; it does not create active L3 rows.";
  if (result.item.recommendation_type === "link_gap") return "Link gap accepted without a proposal bridge. Refresh before assuming any active link exists.";
  return "Recommendation accepted. No active L3 rows were written.";
}

export function recommendationEvidencePreview(item: L3RecommendationItemRow): string {
  return compactJson(item.evidence, 260);
}

export function recommendationPayloadPreview(item: L3RecommendationItemRow): string {
  return compactJson(item.payload, 260);
}

export function recommendationRunStatsPreview(stats: unknown): string {
  return isRecord(stats) ? compactJson(stats, 260) : compactJson(stats, 260);
}
