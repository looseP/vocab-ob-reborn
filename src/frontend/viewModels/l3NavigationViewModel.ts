import type {
  L3ContextDetail,
  L3ContextLinkRow,
  L3ContextRow,
  L3GraphEdge,
  L3GraphNode,
  L3GraphReadModel,
  L3OccurrenceRow,
  L3SourceRow,
  L3SourceSpace,
  L3WordSpace,
} from "@/domain";

export type L3NavigationTarget = "graph" | "context" | "word" | "source" | "proposal" | "recommendation";

export interface L3GraphHandoff {
  slug?: string;
  wordbookId?: string;
  sourceId?: string;
  nonce: number;
}

export interface L3ContextHandoff {
  contextId: string;
  nonce: number;
}

export interface L3WordHandoff {
  slug: string;
  wordbookId?: string;
  nonce: number;
}

export interface L3SourceHandoff {
  sourceId: string;
  nonce: number;
}

export type L3NavigationIntent =
  | { target: "graph"; query: { slug?: string; wordbookId?: string; sourceId?: string } }
  | { target: "context"; contextId: string }
  | { target: "word"; slug: string; wordbookId?: string }
  | { target: "source"; sourceId: string }
  | { target: "proposal"; proposalId?: string }
  | { target: "recommendation"; recommendationId?: string };

export interface L3NavigationAction {
  label: string;
  intent: L3NavigationIntent | null;
  reason: string | null;
}

export interface L3GraphSelectionNavigation {
  selected: L3NavigationAction[];
  endpoints: L3NavigationAction[];
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }
  return null;
}

function wordSlugFromRecords(...records: Array<unknown>): string | null {
  for (const recordLike of records) {
    const record = readRecord(recordLike);
    const slug = firstString(record.slug, record.wordSlug, record.targetSlug);
    if (slug) return slug;
  }
  return null;
}

function wordbookIdFromRecords(...records: Array<unknown>): string | undefined {
  for (const recordLike of records) {
    const record = readRecord(recordLike);
    const wordbookId = firstString(record.wordbookId, record.wordbook_id);
    if (wordbookId) return wordbookId;
  }
  return undefined;
}

function sourceIdFromRecords(...records: Array<unknown>): string | null {
  for (const recordLike of records) {
    const record = readRecord(recordLike);
    const sourceId = firstString(record.sourceId, record.source_id);
    if (sourceId) return sourceId;
  }
  return null;
}

function contextIdFromRecords(...records: Array<unknown>): string | null {
  for (const recordLike of records) {
    const record = readRecord(recordLike);
    const contextId = firstString(record.contextId, record.context_id);
    if (contextId) return contextId;
  }
  return null;
}

export function navigationAction(label: string, intent: L3NavigationIntent | null, reason: string | null = null): L3NavigationAction {
  return { label, intent, reason };
}

export function canNavigate(action: L3NavigationAction): boolean {
  return action.intent !== null;
}

export function graphNodeNavigationAction(node: L3GraphNode | null | undefined): L3NavigationAction {
  if (!node) return navigationAction("Open target", null, "No selected node.");
  const ref = readRecord(node.ref);
  const metadata = readRecord(node.metadata);
  if (node.type === "context") {
    const contextId = contextIdFromRecords(ref, metadata);
    return contextId
      ? navigationAction("Open Context", { target: "context", contextId })
      : navigationAction("Open Context", null, "Missing contextId in graph response.");
  }
  if (node.type === "source") {
    const sourceId = sourceIdFromRecords(ref, metadata);
    return sourceId
      ? navigationAction("Open Source Space", { target: "source", sourceId })
      : navigationAction("Open Source Space", null, "Missing sourceId in graph response.");
  }
  if (node.type === "word") {
    const slug = wordSlugFromRecords(ref, metadata);
    const wordbookId = wordbookIdFromRecords(ref, metadata);
    return slug
      ? navigationAction("Open Word Space", { target: "word", slug, ...(wordbookId ? { wordbookId } : {}) })
      : navigationAction("Open Word Space", null, "Missing explicit slug in graph response.");
  }
  return navigationAction("Open read surface", null, `${node.type} nodes are metadata-only in this phase.`);
}

export function graphEdgeEndpointActions(graph: L3GraphReadModel | null, edge: L3GraphEdge | null | undefined): L3NavigationAction[] {
  if (!graph || !edge) return [];
  const source = graph.nodes.find((node) => node.id === edge.sourceNodeId) ?? null;
  const target = graph.nodes.find((node) => node.id === edge.targetNodeId) ?? null;
  return [
    source ? { ...graphNodeNavigationAction(source), label: "Open Source Node" } : navigationAction("Open Source Node", null, "Missing source node in graph response."),
    target ? { ...graphNodeNavigationAction(target), label: "Open Target Node" } : navigationAction("Open Target Node", null, "Missing target node in graph response."),
  ];
}

export function graphSelectionNavigation(graph: L3GraphReadModel | null, selection: { kind: "node" | "edge"; id: string } | null): L3GraphSelectionNavigation {
  if (!graph || !selection) return { selected: [], endpoints: [] };
  if (selection.kind === "node") {
    const node = graph.nodes.find((candidate) => candidate.id === selection.id);
    return { selected: [graphNodeNavigationAction(node)], endpoints: [] };
  }
  const edge = graph.edges.find((candidate) => candidate.id === selection.id);
  return { selected: [], endpoints: graphEdgeEndpointActions(graph, edge) };
}

export function sourceNavigationAction(source: L3SourceRow | null | undefined): L3NavigationAction {
  return source?.id
    ? navigationAction("Open Source Space", { target: "source", sourceId: source.id })
    : navigationAction("Open Source Space", null, "Missing source id.");
}

export function contextNavigationAction(context: L3ContextRow | null | undefined): L3NavigationAction {
  return context?.id
    ? navigationAction("Open Context", { target: "context", contextId: context.id })
    : navigationAction("Open Context", null, "Missing context id.");
}

export function wordNavigationAction(input: {
  slug?: string | null;
  wordbookId?: string | null;
  label?: string;
}): L3NavigationAction {
  const slug = cleanString(input.slug);
  return slug
    ? navigationAction(input.label ?? "Open Word Space", { target: "word", slug, ...(cleanString(input.wordbookId) ? { wordbookId: cleanString(input.wordbookId)! } : {}) })
    : navigationAction(input.label ?? "Open Word Space", null, "Missing explicit slug; word id alone is not enough.");
}

export function graphForWordNavigationAction(space: L3WordSpace | null | undefined, activeWordbookId?: string | null): L3NavigationAction {
  if (!space) return navigationAction("Open Graph for this word", null, "Load a word space first.");
  return navigationAction("Open Graph for this word", {
    target: "graph",
    query: {
      slug: space.word.slug,
      ...(cleanString(activeWordbookId) ? { wordbookId: cleanString(activeWordbookId)! } : {}),
    },
  });
}

export function graphForSourceNavigationAction(space: L3SourceSpace | null | undefined): L3NavigationAction {
  return space?.source.id
    ? navigationAction("Open Graph for this source", { target: "graph", query: { sourceId: space.source.id } })
    : navigationAction("Open Graph for this source", null, "Load a source space first.");
}

export function contextSourceNavigationAction(detail: L3ContextDetail | null | undefined): L3NavigationAction {
  return sourceNavigationAction(detail?.source);
}

export function occurrenceContextNavigationAction(occurrence: L3OccurrenceRow | null | undefined): L3NavigationAction {
  return occurrence?.context_id
    ? navigationAction("Open Context", { target: "context", contextId: occurrence.context_id })
    : navigationAction("Open Context", null, "Missing occurrence context id.");
}

export function occurrenceWordNavigationAction(occurrence: L3OccurrenceRow | null | undefined, wordbookId?: string | null): L3NavigationAction {
  const slug = wordSlugFromRecords(occurrence?.evidence);
  return wordNavigationAction({ slug, wordbookId, label: "Open Word Space" });
}

export function linkTargetNavigationAction(link: L3ContextLinkRow): L3NavigationAction {
  if (link.target_type === "context") {
    return link.target_id
      ? navigationAction("Open Target Context", { target: "context", contextId: link.target_id })
      : navigationAction("Open Target Context", null, "Missing target context id.");
  }
  if (link.target_type === "source") {
    return link.target_id
      ? navigationAction("Open Target Source", { target: "source", sourceId: link.target_id })
      : navigationAction("Open Target Source", null, "Missing target source id.");
  }
  if (link.target_type === "word") {
    const slug = wordSlugFromRecords(link.target_ref, link.provenance);
    const wordbookId = wordbookIdFromRecords(link.target_ref, link.provenance);
    return wordNavigationAction({ slug, wordbookId, label: "Open Target Word" });
  }
  return navigationAction("Open Link Target", null, `${link.target_type} targets are metadata-only in this phase.`);
}

export function proposalReviewNavigationAction(proposalId: string | null | undefined): L3NavigationAction {
  const id = cleanString(proposalId);
  return id
    ? navigationAction("Open Proposal Review", { target: "proposal", proposalId: id })
    : navigationAction("Open Proposal Review", null, "Missing proposal id.");
}
