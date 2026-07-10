import type { NormalizedL3Error } from "@/l3/frontend/contract";

export type L3ParentDeleteEntityType = "source" | "context";

export type L3ParentDeleteBlockerKey =
  | "contexts"
  | "inboundContextLinks"
  | "importJobs"
  | "occurrences"
  | "contextLinks";

export interface L3ParentDeleteBlockerRow {
  key: L3ParentDeleteBlockerKey;
  count: number;
  label: string;
}

export interface L3ParentDeleteConflictSummary {
  entityType: L3ParentDeleteEntityType;
  id: string;
  blockers: L3ParentDeleteBlockerRow[];
  canRetryAfterCleanup: true;
}

interface BlockerMapping {
  field: string;
  key: L3ParentDeleteBlockerKey;
  label: string;
}

const SOURCE_BLOCKERS: BlockerMapping[] = [
  { field: "contextCount", key: "contexts", label: "Contexts" },
  { field: "inboundContextLinkCount", key: "inboundContextLinks", label: "Inbound context links" },
  { field: "importJobCount", key: "importJobs", label: "Import jobs" },
];

const CONTEXT_BLOCKERS: BlockerMapping[] = [
  { field: "occurrenceCount", key: "occurrences", label: "Occurrences" },
  { field: "contextLinkCount", key: "contextLinks", label: "Context links" },
  { field: "inboundContextLinkCount", key: "inboundContextLinks", label: "Inbound context links" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parentEntityType(value: unknown): L3ParentDeleteEntityType | null {
  return value === "source" || value === "context" ? value : null;
}

function blockerMappingsFor(entityType: L3ParentDeleteEntityType): BlockerMapping[] {
  return entityType === "source" ? SOURCE_BLOCKERS : CONTEXT_BLOCKERS;
}

function blockerRows(
  entityType: L3ParentDeleteEntityType,
  blockers: Record<string, unknown>,
): L3ParentDeleteBlockerRow[] {
  return blockerMappingsFor(entityType).flatMap((mapping) => {
    const count = blockers[mapping.field];
    if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) return [];
    return [{ key: mapping.key, count, label: mapping.label }];
  });
}

export function summarizeL3ParentDeleteConflict(
  error: NormalizedL3Error,
): L3ParentDeleteConflictSummary | null {
  if (error.status !== 409 || error.kind !== "conflict") return null;
  if (!isRecord(error.details)) return null;

  const entityType = parentEntityType(error.details.entityType);
  const id = typeof error.details.id === "string" ? error.details.id.trim() : "";
  if (!entityType || !id || !isRecord(error.details.blockers)) return null;

  return {
    entityType,
    id,
    blockers: blockerRows(entityType, error.details.blockers),
    canRetryAfterCleanup: true,
  };
}
