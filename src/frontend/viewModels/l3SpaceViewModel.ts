import type {
  L3ContextDetail,
  L3ContextLinkRow,
  L3ContextRow,
  L3OccurrenceRow,
  L3ReadStats,
  L3SourceRow,
  L3SourceSpace,
  L3WordSpace,
  WordRow,
} from "@/domain";
import {
  normalizeL3Error,
  type L3CacheSignal,
  type L3SourceSpaceParams,
  type L3SpaceParams,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";
import type { L3ActiveReadStaleState } from "../state/l3CacheSignals";

export interface ContextLookupPayload {
  contextId: string;
}

export interface WordSpaceLookupPayload {
  slug: string;
  params: L3SpaceParams;
}

export interface SourceSpaceLookupPayload {
  sourceId: string;
  params: L3SourceSpaceParams;
}

export interface SpaceReadTransition<T> {
  data: T;
  nextState: "loaded" | "empty";
  invalidate: [];
  refreshGraph: false;
  createsActiveL3: false;
  cache: L3CacheSignal;
}

function spaceFormError(fieldErrors: Record<string, string[]>): NormalizedL3Error {
  return normalizeL3Error(400, {
    code: "FRONTEND_VALIDATION_ERROR",
    message: "Request validation failed.",
    details: { fieldErrors },
  });
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

function requireTrimmed(value: string, field: string, fieldErrors: Record<string, string[]>): string {
  const trimmed = value.trim();
  if (!trimmed) fieldErrors[field] = [`${field} cannot be empty.`];
  return trimmed;
}

export function buildContextLookupPayload(input: { contextId: string }): ContextLookupPayload {
  const fieldErrors: Record<string, string[]> = {};
  const contextId = requireTrimmed(input.contextId, "contextId", fieldErrors);
  if (Object.keys(fieldErrors).length > 0) throw spaceFormError(fieldErrors);
  return { contextId };
}

export function buildWordSpaceQueryPayload(input: {
  slug: string;
  wordbookId: string;
  limit: string;
  cursor: string;
}): WordSpaceLookupPayload {
  const fieldErrors: Record<string, string[]> = {};
  const slug = requireTrimmed(input.slug, "slug", fieldErrors);
  const limit = parseOptionalInteger(input.limit, "limit", 100, fieldErrors);
  if (Object.keys(fieldErrors).length > 0) throw spaceFormError(fieldErrors);

  const wordbookId = input.wordbookId.trim();
  const cursor = input.cursor.trim();
  return {
    slug,
    params: {
      ...(wordbookId ? { wordbookId } : {}),
      ...(limit === null ? {} : { limit }),
      ...(cursor ? { cursor } : {}),
    },
  };
}

export function buildSourceSpaceQueryPayload(input: {
  sourceId: string;
  limit: string;
  cursor: string;
}): SourceSpaceLookupPayload {
  const fieldErrors: Record<string, string[]> = {};
  const sourceId = requireTrimmed(input.sourceId, "sourceId", fieldErrors);
  const limit = parseOptionalInteger(input.limit, "limit", 100, fieldErrors);
  if (Object.keys(fieldErrors).length > 0) throw spaceFormError(fieldErrors);

  const cursor = input.cursor.trim();
  return {
    sourceId,
    params: {
      ...(limit === null ? {} : { limit }),
      ...(cursor ? { cursor } : {}),
    },
  };
}

export function compactSpaceJson(value: unknown, maxLength = 180): string {
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

export function contextPreview(context: L3ContextRow | null | undefined, maxLength = 220): string {
  const text = context?.text?.trim() ?? "";
  if (!text) return "No context text.";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function sourceLabel(source: L3SourceRow | null | undefined): string {
  if (!source) return "Unknown source";
  return `${source.title || source.id} (${source.source_type})`;
}

export function wordLabel(word: WordRow | null | undefined): string {
  if (!word) return "Unknown word";
  return word.title || word.slug || word.id;
}

export function occurrenceSummary(occurrence: L3OccurrenceRow): string {
  const range =
    occurrence.start_offset === null || occurrence.end_offset === null
      ? "offset unknown"
      : `${occurrence.start_offset}-${occurrence.end_offset}`;
  const lemma = occurrence.lemma ? ` / ${occurrence.lemma}` : "";
  return `${occurrence.surface}${lemma} [${range}]`;
}

export function linkSummary(link: L3ContextLinkRow): string {
  return `${link.link_type}: ${link.context_id ?? "no-context"} -> ${link.target_type}:${link.target_id ?? (compactSpaceJson(link.target_ref, 80) || "unknown")}`;
}

export function statsRows(stats: L3ReadStats, extra: Array<{ label: string; value: number | string | null }> = []): Array<{ label: string; value: number | string | null }> {
  return [
    { label: "Sources", value: stats.sourceCount },
    { label: "Contexts", value: stats.contextCount },
    { label: "Occurrences", value: stats.occurrenceCount },
    { label: "Links", value: stats.linkCount },
    ...extra,
  ];
}

export function contextStatsRows(detail: L3ContextDetail): Array<{ label: string; value: number | string | null }> {
  return statsRows({
    sourceCount: detail.source ? 1 : 0,
    contextCount: 1,
    occurrenceCount: detail.occurrences.length,
    linkCount: detail.links.length,
  });
}

export function wordSpaceStatsRows(space: L3WordSpace): Array<{ label: string; value: number | string | null }> {
  return statsRows(space.stats, [
    { label: "Limit", value: space.limit },
    { label: "Next Cursor", value: space.nextCursor ?? "none" },
  ]);
}

export function sourceSpaceStatsRows(space: L3SourceSpace): Array<{ label: string; value: number | string | null }> {
  return statsRows(space.stats, [
    { label: "Limit", value: space.limit },
    { label: "Next Cursor", value: space.nextCursor ?? "none" },
  ]);
}

export function contextEmptyMessages(detail: L3ContextDetail | null): string[] {
  if (!detail) return [];
  return [
    ...(detail.occurrences.length === 0 ? ["No occurrences are attached to this context."] : []),
    ...(detail.links.length === 0 ? ["No context links are attached to this context."] : []),
  ];
}

export function wordSpaceEmptyMessage(space: L3WordSpace | null): string | null {
  if (!space) return null;
  if (space.contexts.length === 0 && space.occurrences.length === 0 && space.links.length === 0) return "No active L3 space rows for this word.";
  if (space.contexts.length === 0) return "No related contexts for this word.";
  return null;
}

export function sourceSpaceEmptyMessage(space: L3SourceSpace | null): string | null {
  if (!space) return null;
  if (space.contexts.length === 0) return "No contexts are attached to this source.";
  return null;
}

export function readStaleBannerText(staleState: L3ActiveReadStaleState | null): string | null {
  if (!staleState) return null;
  return `L3 read data may be stale after proposal confirmation: ${staleState.reason}`;
}

export function applySpaceReadUiResult<T>(data: T, isEmpty: boolean): SpaceReadTransition<T> {
  return {
    data,
    nextState: isEmpty ? "empty" : "loaded",
    invalidate: [],
    refreshGraph: false,
    createsActiveL3: false,
    cache: {
      keys: [],
      activeReadInvalidation: false,
      proposalInvalidation: false,
      recommendationInvalidation: false,
      reason: "space_read_no_invalidation",
    },
  };
}

export function shouldClearReadStaleAfterSpaceRead(transition: SpaceReadTransition<unknown>): boolean {
  return transition.cache.activeReadInvalidation === false && transition.refreshGraph === false && transition.createsActiveL3 === false;
}
