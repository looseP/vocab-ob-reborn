import type { L3GraphEdge, L3GraphNode, L3GraphReadModel } from "@/domain";
import {
  applyGraphReadSuccess,
  normalizeL3Error,
  type L3GraphParams,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";

export const graphDepthOptions = [1, 2] as const;

function graphFormError(fieldErrors: Record<string, string[]>): NormalizedL3Error {
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

export function buildGraphQueryPayload(input: {
  wordbookId: string;
  slug: string;
  sourceId: string;
  depth: string;
  limit: string;
  cursor: string;
}): L3GraphParams {
  const fieldErrors: Record<string, string[]> = {};
  const depth = parseOptionalInteger(input.depth, "depth", 2, fieldErrors);
  const limit = parseOptionalInteger(input.limit, "limit", 300, fieldErrors);
  if (Object.keys(fieldErrors).length > 0) throw graphFormError(fieldErrors);

  return {
    ...(input.wordbookId.trim() ? { wordbookId: input.wordbookId.trim() } : {}),
    ...(input.slug.trim() ? { slug: input.slug.trim() } : {}),
    ...(input.sourceId.trim() ? { sourceId: input.sourceId.trim() } : {}),
    ...(depth === null ? {} : { depth }),
    ...(limit === null ? {} : { limit }),
    ...(input.cursor.trim() ? { cursor: input.cursor.trim() } : {}),
  };
}

export function compactGraphJson(value: unknown, maxLength = 220): string {
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

export function graphStatsRows(graph: L3GraphReadModel): Array<{ label: string; value: number | string | null }> {
  return [
    { label: "Sources", value: graph.stats.sourceCount },
    { label: "Contexts", value: graph.stats.contextCount },
    { label: "Occurrences", value: graph.stats.occurrenceCount },
    { label: "Links", value: graph.stats.linkCount },
    { label: "Nodes", value: graph.stats.nodeCount },
    { label: "Edges", value: graph.stats.edgeCount },
    { label: "Limit", value: graph.limit },
    { label: "Next Cursor", value: graph.nextCursor ?? "none" },
  ];
}

export function graphEmptyMessage(graph: L3GraphReadModel | null): string | null {
  if (!graph) return null;
  if (graph.nodes.length === 0 && graph.edges.length === 0) return "No L3 graph data for current filters.";
  if (graph.edges.length === 0) return "No graph edges for current filters.";
  return null;
}

export function summarizeGraphNode(node: L3GraphNode): string {
  return `${node.type}: ${node.label}`;
}

export function summarizeGraphEdge(edge: L3GraphEdge): string {
  return `${edge.type}: ${edge.sourceNodeId} -> ${edge.targetNodeId}`;
}

export function applyGraphReadUiResult(data: L3GraphReadModel) {
  return applyGraphReadSuccess(data);
}
