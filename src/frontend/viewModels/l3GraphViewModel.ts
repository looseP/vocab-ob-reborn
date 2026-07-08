import type { L3GraphEdge, L3GraphNode, L3GraphNodeType, L3GraphReadModel } from "@/domain";
import {
  applyGraphReadSuccess,
  normalizeL3Error,
  type L3GraphParams,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";

export const graphDepthOptions = [1, 2] as const;

export type GraphCanvasSelection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | null;

export interface GraphCanvasNode {
  id: string;
  type: L3GraphNode["type"] | "unknown";
  label: string;
  compactLabel: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  ref: L3GraphNode["ref"];
  metadata?: L3GraphNode["metadata"];
}

export interface GraphCanvasEdge {
  id: string;
  type: string;
  sourceNodeId: string;
  targetNodeId: string;
  source: { x: number; y: number };
  target: { x: number; y: number };
  color: string;
  confidence?: L3GraphEdge["confidence"];
  evidence?: L3GraphEdge["evidence"];
  provenance?: L3GraphEdge["provenance"];
  missingEndpoint: boolean;
}

export interface GraphLegendItem {
  type: string;
  label: string;
  color: string;
  count: number;
}

export interface GraphCanvasModel {
  state: "empty" | "ready";
  viewBox: string;
  width: number;
  height: number;
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  legend: GraphLegendItem[];
  summary: string;
}

const GRAPH_CANVAS_WIDTH = 960;
const GRAPH_CANVAS_HEIGHT = 420;

const nodeTypePriority: Record<L3GraphNodeType, number> = {
  source: 0,
  context: 1,
  word: 2,
  l2_item: 3,
  topic: 4,
  external: 5,
};

const nodeTypeDisplay: Record<L3GraphNodeType, { label: string; color: string; radius: number }> = {
  word: { label: "Word", color: "#2563eb", radius: 21 },
  context: { label: "Context", color: "#059669", radius: 19 },
  source: { label: "Source", color: "#7c3aed", radius: 23 },
  l2_item: { label: "L2 item", color: "#d97706", radius: 18 },
  topic: { label: "Topic", color: "#0f766e", radius: 18 },
  external: { label: "External", color: "#6b7280", radius: 18 },
};

const edgeTypeColors: Record<string, string> = {
  occurs_in: "#64748b",
  belongs_to: "#8b5cf6",
  illustrates: "#2563eb",
  contrasts_with: "#dc2626",
  collocates_with: "#059669",
  related_to: "#0f766e",
  derived_from: "#d97706",
};

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

export function compactGraphLabel(value: string | null | undefined, maxLength = 18): string {
  const text = value?.trim() || "Untitled";
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 3))}...` : text;
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

export function getGraphNodeDisplay(node: L3GraphNode): {
  id: string;
  type: L3GraphNode["type"] | "unknown";
  typeLabel: string;
  label: string;
  compactLabel: string;
  color: string;
  radius: number;
} {
  const display = nodeTypeDisplay[node.type] ?? { label: "Unknown", color: "#475569", radius: 18 };
  return {
    id: node.id || "unknown-node",
    type: node.type ?? "unknown",
    typeLabel: display.label,
    label: node.label?.trim() || node.id || "Untitled node",
    compactLabel: compactGraphLabel(node.label || node.id),
    color: display.color,
    radius: display.radius,
  };
}

export function getGraphEdgeDisplay(edge: L3GraphEdge): {
  id: string;
  type: string;
  label: string;
  color: string;
} {
  const type = edge.type || "unknown_edge";
  return {
    id: edge.id || `${edge.sourceNodeId || "unknown-source"}:${type}:${edge.targetNodeId || "unknown-target"}`,
    type,
    label: compactGraphLabel(type.replaceAll("_", " "), 24),
    color: edgeTypeColors[type] ?? "#475569",
  };
}

function sortedGraphNodes(nodes: L3GraphNode[]): L3GraphNode[] {
  return [...nodes].sort((a, b) => {
    const priorityA = nodeTypePriority[a.type] ?? 99;
    const priorityB = nodeTypePriority[b.type] ?? 99;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return `${a.label}|${a.id}`.localeCompare(`${b.label}|${b.id}`);
  });
}

function sortedGraphEdges(edges: L3GraphEdge[]): L3GraphEdge[] {
  return [...edges].sort((a, b) => `${a.type}|${a.sourceNodeId}|${a.targetNodeId}|${a.id}`.localeCompare(`${b.type}|${b.sourceNodeId}|${b.targetNodeId}|${b.id}`));
}

export function layoutGraphNodes(nodes: L3GraphNode[], edges: L3GraphEdge[] = []): GraphCanvasNode[] {
  if (nodes.length === 0) return [];
  const sorted = sortedGraphNodes(nodes);
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(sorted.length))));
  const rows = Math.max(1, Math.ceil(sorted.length / columns));
  const xStep = GRAPH_CANVAS_WIDTH / (columns + 1);
  const yStep = GRAPH_CANVAS_HEIGHT / (rows + 1);
  const connectedIds = new Set(edges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]));

  return sorted.map((node, index) => {
    const display = getGraphNodeDisplay(node);
    const column = index % columns;
    const row = Math.floor(index / columns);
    const stagger = rows > 1 && column % 2 === 1 ? Math.min(24, yStep * 0.14) : 0;
    return {
      id: display.id,
      type: display.type,
      label: display.label,
      compactLabel: display.compactLabel,
      x: Math.round((column + 1) * xStep),
      y: Math.round(Math.min(GRAPH_CANVAS_HEIGHT - 42, (row + 1) * yStep + stagger)),
      radius: connectedIds.has(node.id) ? display.radius + 2 : display.radius,
      color: display.color,
      ref: node.ref,
      metadata: node.metadata,
    };
  });
}

export function getGraphLegendItems(graph: L3GraphReadModel): GraphLegendItem[] {
  const counts = new Map<string, { label: string; color: string; count: number }>();
  for (const node of graph.nodes) {
    const display = getGraphNodeDisplay(node);
    const current = counts.get(display.type) ?? { label: display.typeLabel, color: display.color, count: 0 };
    counts.set(display.type, { ...current, count: current.count + 1 });
  }
  return [...counts.entries()]
    .sort(([typeA], [typeB]) => (nodeTypePriority[typeA as L3GraphNodeType] ?? 99) - (nodeTypePriority[typeB as L3GraphNodeType] ?? 99) || typeA.localeCompare(typeB))
    .map(([type, value]) => ({ type, ...value }));
}

export function buildGraphCanvasModel(graph: L3GraphReadModel | null): GraphCanvasModel {
  if (!graph || (graph.nodes.length === 0 && graph.edges.length === 0)) {
    return {
      state: "empty",
      viewBox: `0 0 ${GRAPH_CANVAS_WIDTH} ${GRAPH_CANVAS_HEIGHT}`,
      width: GRAPH_CANVAS_WIDTH,
      height: GRAPH_CANVAS_HEIGHT,
      nodes: [],
      edges: [],
      legend: [],
      summary: "No visual graph data for current filters.",
    };
  }

  const nodes = layoutGraphNodes(graph.nodes, graph.edges);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = sortedGraphEdges(graph.edges).map((edge): GraphCanvasEdge => {
    const display = getGraphEdgeDisplay(edge);
    const source = nodeById.get(edge.sourceNodeId);
    const target = nodeById.get(edge.targetNodeId);
    return {
      id: display.id,
      type: display.type,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      source: source ? { x: source.x, y: source.y } : { x: 24, y: GRAPH_CANVAS_HEIGHT - 24 },
      target: target ? { x: target.x, y: target.y } : { x: GRAPH_CANVAS_WIDTH - 24, y: GRAPH_CANVAS_HEIGHT - 24 },
      color: display.color,
      confidence: edge.confidence,
      evidence: edge.evidence,
      provenance: edge.provenance,
      missingEndpoint: !source || !target,
    };
  });

  return {
    state: "ready",
    viewBox: `0 0 ${GRAPH_CANVAS_WIDTH} ${GRAPH_CANVAS_HEIGHT}`,
    width: GRAPH_CANVAS_WIDTH,
    height: GRAPH_CANVAS_HEIGHT,
    nodes,
    edges,
    legend: getGraphLegendItems(graph),
    summary: `${nodes.length} visual nodes / ${edges.length} visual edges from graph response.`,
  };
}

export function summarizeSelectedGraphItem(graph: L3GraphReadModel | null, selection: GraphCanvasSelection): string {
  if (!graph || !selection) return "Select a node or edge to inspect graph response details.";
  if (selection.kind === "node") {
    const node = graph.nodes.find((candidate) => candidate.id === selection.id);
    return node ? `${getGraphNodeDisplay(node).typeLabel}: ${getGraphNodeDisplay(node).label}` : "Selected node is no longer present in the latest graph response.";
  }
  const edge = graph.edges.find((candidate) => candidate.id === selection.id);
  return edge ? `${getGraphEdgeDisplay(edge).label}: ${edge.sourceNodeId} -> ${edge.targetNodeId}` : "Selected edge is no longer present in the latest graph response.";
}

export function applyGraphReadUiResult(data: L3GraphReadModel) {
  return applyGraphReadSuccess(data);
}
