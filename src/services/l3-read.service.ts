/**
 * L3ReadService - read-only active L3 context-space projections.
 *
 * Phase 3D exposes stable read models for UI/agent consumers. It does not
 * write active L3 rows and does not touch L1/L2, FSRS, LLM, or dictionary code.
 */

import { createHash } from "node:crypto";
import { NotFoundError, ValidationError } from "../errors";
import type {
  Json,
  L3ContextDetail,
  L3ContextLinkRow,
  L3ContextLinkType,
  L3ContextLinkTargetType,
  L3ContextRow,
  L3GraphEdge,
  L3GraphNode,
  L3GraphReadModel,
  L3OccurrenceRow,
  L3ReadStats,
  L3SourceRow,
  L3SourceSpace,
  L3WordSpace,
} from "../domain";
import type { IL3ContextRepository } from "../repositories/interfaces";

const DEFAULT_SPACE_LIMIT = 50;
const MAX_SPACE_LIMIT = 100;
const DEFAULT_GRAPH_LIMIT = 100;
const MAX_GRAPH_LIMIT = 300;
const DEFAULT_GRAPH_DEPTH = 1;
const MAX_GRAPH_DEPTH = 1;
const GRAPH_NODE_TYPE_ORDER: Record<L3GraphNode["type"], number> = {
  word: 1,
  context: 2,
  source: 3,
  l2_item: 4,
  topic: 5,
  external: 6,
};

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} cannot be empty`, field);
  }
}

function normalizeLimit(limit: number | null | undefined, defaultValue: number, max: number): number {
  if (limit === undefined || limit === null) return defaultValue;
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new ValidationError(`limit must be between 1 and ${max}`, "limit");
  }
  return limit;
}

function normalizeDepth(depth: number | null | undefined): number {
  if (depth === undefined || depth === null) return DEFAULT_GRAPH_DEPTH;
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_GRAPH_DEPTH) {
    throw new ValidationError("depth must be 1", "depth");
  }
  return depth;
}

function stableHash(value: Json | string): string {
  const text = typeof value === "string" ? value : JSON.stringify(sortJson(value));
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function sortJson(value: Json): Json {
  if (Array.isArray(value)) return value.map((item) => sortJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

function asRecord(value: Json | null | undefined): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function contextLabel(context: L3ContextRow): string {
  return context.text.length > 80 ? `${context.text.slice(0, 77)}...` : context.text;
}

function buildStats(
  sources: L3SourceRow[],
  contexts: L3ContextRow[],
  occurrences: L3OccurrenceRow[],
  links: L3ContextLinkRow[],
): L3ReadStats {
  return {
    sourceCount: sources.length,
    contextCount: contexts.length,
    occurrenceCount: occurrences.length,
    linkCount: links.length,
  };
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function softNodeId(targetType: L3ContextLinkTargetType, targetRef: Json, targetId: string | null): string {
  if (targetType === "l2_item") {
    const ref = asRecord(targetRef);
    const stableRef =
      (typeof ref.contentId === "string" && ref.contentId) ||
      (typeof ref.hash === "string" && ref.hash) ||
      (typeof ref.sourceRef === "string" && ref.sourceRef) ||
      targetId ||
      stableHash(targetRef);
    return `l2_item:${stableRef}`;
  }
  if (targetType === "topic") {
    const ref = asRecord(targetRef);
    const label =
      (typeof ref.label === "string" && ref.label) ||
      (typeof ref.topic === "string" && ref.topic) ||
      (typeof ref.name === "string" && ref.name) ||
      targetId;
    return `topic:${label ? stableHash(label) : stableHash(targetRef)}`;
  }
  return `external:${targetId ?? stableHash(targetRef)}`;
}

function softNodeLabel(targetType: L3ContextLinkTargetType, targetRef: Json, targetId: string | null): string {
  const ref = asRecord(targetRef);
  if (targetType === "l2_item") {
    return (
      (typeof ref.field === "string" && ref.field) ||
      (typeof ref.contentId === "string" && ref.contentId) ||
      targetId ||
      "l2_item"
    );
  }
  if (targetType === "topic") {
    return (
      (typeof ref.label === "string" && ref.label) ||
      (typeof ref.topic === "string" && ref.topic) ||
      (typeof ref.name === "string" && ref.name) ||
      targetId ||
      "topic"
    );
  }
  return (typeof ref.url === "string" && ref.url) || targetId || "external";
}

function linkSourceNodeId(link: L3ContextLinkRow): string | null {
  if (link.context_id) return `context:${link.context_id}`;
  if (link.word_id) return `word:${link.word_id}`;
  return null;
}

function linkTargetNode(link: L3ContextLinkRow): L3GraphNode | null {
  if (link.target_type === "word" && link.target_id) {
    return {
      id: `word:${link.target_id}`,
      type: "word",
      label: link.target_id,
      ref: { wordId: link.target_id },
    };
  }
  if (link.target_type === "context" && link.target_id) {
    return {
      id: `context:${link.target_id}`,
      type: "context",
      label: link.target_id,
      ref: { contextId: link.target_id },
    };
  }
  if (link.target_type === "source" && link.target_id) {
    return {
      id: `source:${link.target_id}`,
      type: "source",
      label: link.target_id,
      ref: { sourceId: link.target_id },
    };
  }
  if (link.target_type === "l2_item" || link.target_type === "topic" || link.target_type === "external") {
    return {
      id: softNodeId(link.target_type, link.target_ref, link.target_id),
      type: link.target_type,
      label: softNodeLabel(link.target_type, link.target_ref, link.target_id),
      ref: link.target_ref,
      metadata: link.target_id ? { targetId: link.target_id } : undefined,
    };
  }
  return null;
}

function occurrenceEdgeId(occurrence: L3OccurrenceRow): string {
  return `occurs_in:${stableHash({
    wordId: occurrence.word_id,
    contextId: occurrence.context_id,
    surface: occurrence.surface,
    startOffset: occurrence.start_offset,
    endOffset: occurrence.end_offset,
  })}`;
}

function contextLinkEdgeId(link: L3ContextLinkRow, sourceNodeId: string, targetNodeId: string): string {
  return `context_link:${stableHash({
    linkType: link.link_type,
    targetType: link.target_type,
    sourceNodeId,
    targetNodeId,
    targetId: link.target_id,
    targetRef: link.target_ref,
  })}`;
}

function compareGraphNodes(a: L3GraphNode, b: L3GraphNode): number {
  return (
    (GRAPH_NODE_TYPE_ORDER[a.type] - GRAPH_NODE_TYPE_ORDER[b.type]) ||
    a.label.localeCompare(b.label) ||
    a.id.localeCompare(b.id)
  );
}

function compareGraphEdges(a: L3GraphEdge, b: L3GraphEdge): number {
  return (
    a.type.localeCompare(b.type) ||
    a.sourceNodeId.localeCompare(b.sourceNodeId) ||
    a.targetNodeId.localeCompare(b.targetNodeId) ||
    a.id.localeCompare(b.id)
  );
}

export interface GetContextDetailInput {
  userId: string;
  contextId: string;
}

export interface GetWordSpaceInput {
  userId: string;
  slug: string;
  wordbookId?: string | null;
  limit?: number | null;
  cursor?: string | null;
}

export interface GetSourceSpaceInput {
  userId: string;
  sourceId: string;
  limit?: number | null;
  cursor?: string | null;
}

export interface GetGraphInput {
  userId: string;
  wordbookId?: string | null;
  slug?: string | null;
  sourceId?: string | null;
  depth?: number | null;
  limit?: number | null;
  cursor?: string | null;
}

export class L3ReadService {
  constructor(private readonly l3Context: IL3ContextRepository) {}

  async getContextDetail(input: GetContextDetailInput): Promise<L3ContextDetail> {
    requireNonEmpty(input.userId, "userId");
    const detail = await this.l3Context.getContextDetail(input.userId, input.contextId);
    if (!detail) {
      throw new NotFoundError("L3Context", input.contextId);
    }
    return detail;
  }

  async getWordSpace(input: GetWordSpaceInput): Promise<L3WordSpace> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.slug, "slug");
    const limit = normalizeLimit(input.limit, DEFAULT_SPACE_LIMIT, MAX_SPACE_LIMIT);
    if (input.wordbookId) {
      const wordbook = await this.l3Context.findWordbookByIdForUser(input.userId, input.wordbookId);
      if (!wordbook) {
        throw new NotFoundError("Wordbook", input.wordbookId);
      }
    }
    const result = await this.l3Context.getWordSpace({
      userId: input.userId,
      slug: input.slug,
      wordbookId: input.wordbookId ?? null,
      limit,
      cursor: input.cursor ?? null,
    });
    if (!result) {
      throw new NotFoundError("Word", input.slug);
    }
    return result;
  }

  async getSourceSpace(input: GetSourceSpaceInput): Promise<L3SourceSpace> {
    requireNonEmpty(input.userId, "userId");
    const limit = normalizeLimit(input.limit, DEFAULT_SPACE_LIMIT, MAX_SPACE_LIMIT);
    const result = await this.l3Context.getSourceSpace({
      userId: input.userId,
      sourceId: input.sourceId,
      limit,
      cursor: input.cursor ?? null,
    });
    if (!result) {
      throw new NotFoundError("L3Source", input.sourceId);
    }
    return result;
  }

  async getGraph(input: GetGraphInput): Promise<L3GraphReadModel> {
    requireNonEmpty(input.userId, "userId");
    const depth = normalizeDepth(input.depth);
    const limit = normalizeLimit(input.limit, DEFAULT_GRAPH_LIMIT, MAX_GRAPH_LIMIT);
    if (input.wordbookId) {
      const wordbook = await this.l3Context.findWordbookByIdForUser(input.userId, input.wordbookId);
      if (!wordbook) {
        throw new NotFoundError("Wordbook", input.wordbookId);
      }
    }
    if (input.sourceId) {
      const source = await this.l3Context.findSourceById(input.userId, input.sourceId);
      if (!source) {
        throw new NotFoundError("L3Source", input.sourceId);
      }
    }
    if (input.slug) {
      const word = input.wordbookId
        ? await this.l3Context.findWordInWordbookBySlug(input.wordbookId, input.slug)
        : await this.l3Context.findWordBySlug(input.slug);
      if (!word) {
        throw new NotFoundError("Word", input.slug);
      }
    }

    const seed = await this.l3Context.getGraph({
      userId: input.userId,
      wordbookId: input.wordbookId ?? null,
      slug: input.slug ?? null,
      sourceId: input.sourceId ?? null,
      depth,
      limit,
      cursor: input.cursor ?? null,
    });
    return this.assembleGraph(seed);
  }

  private assembleGraph(seed: L3GraphReadModel): L3GraphReadModel {
    const contextNodes = new Map<string, L3GraphNode>();
    const sourceNodes = new Map<string, L3GraphNode>();
    const wordNodes = new Map<string, L3GraphNode>();
    const softNodes = new Map<string, L3GraphNode>();
    const edges = new Map<string, L3GraphEdge>();

    const contexts = (seed.metadata as { contexts?: L3ContextRow[] } | undefined)?.contexts ?? [];
    const sources = (seed.metadata as { sources?: L3SourceRow[] } | undefined)?.sources ?? [];
    const occurrences = (seed.metadata as { occurrences?: L3OccurrenceRow[] } | undefined)?.occurrences ?? [];
    const links = (seed.metadata as { links?: L3ContextLinkRow[] } | undefined)?.links ?? [];

    for (const source of sources) {
      sourceNodes.set(`source:${source.id}`, {
        id: `source:${source.id}`,
        type: "source",
        label: source.title,
        ref: { sourceId: source.id, wordbookId: source.wordbook_id },
        metadata: { sourceType: source.source_type, language: source.language },
      });
    }

    for (const context of contexts) {
      contextNodes.set(`context:${context.id}`, {
        id: `context:${context.id}`,
        type: "context",
        label: contextLabel(context),
        ref: { contextId: context.id, sourceId: context.source_id },
        metadata: { contextType: context.context_type, language: context.language },
      });
      const edgeId = `belongs_to:${context.id}:${context.source_id}`;
      edges.set(edgeId, {
        id: edgeId,
        type: "belongs_to",
        sourceNodeId: `context:${context.id}`,
        targetNodeId: `source:${context.source_id}`,
      });
    }

    for (const occurrence of occurrences) {
      const wordNodeId = `word:${occurrence.word_id}`;
      if (!wordNodes.has(wordNodeId)) {
        wordNodes.set(wordNodeId, {
          id: wordNodeId,
          type: "word",
          label: occurrence.surface || occurrence.word_id,
          ref: { wordId: occurrence.word_id },
        });
      }
      const edgeId = occurrenceEdgeId(occurrence);
      edges.set(edgeId, {
        id: edgeId,
        type: "occurs_in",
        sourceNodeId: wordNodeId,
        targetNodeId: `context:${occurrence.context_id}`,
        confidence: occurrence.confidence,
        evidence: occurrence.evidence,
      });
    }

    for (const link of links) {
      const sourceNodeId = linkSourceNodeId(link);
      const targetNode = linkTargetNode(link);
      if (!sourceNodeId || !targetNode) continue;
      if (targetNode.type === "word") wordNodes.set(targetNode.id, targetNode);
      else if (targetNode.type === "context") contextNodes.set(targetNode.id, targetNode);
      else if (targetNode.type === "source") sourceNodes.set(targetNode.id, targetNode);
      else softNodes.set(targetNode.id, targetNode);
      const edgeId = contextLinkEdgeId(link, sourceNodeId, targetNode.id);
      edges.set(edgeId, {
        id: edgeId,
        type: link.link_type as L3ContextLinkType,
        sourceNodeId,
        targetNodeId: targetNode.id,
        confidence: link.confidence,
        provenance: link.provenance,
      });
    }

    const nodes = uniqueById([
      ...wordNodes.values(),
      ...contextNodes.values(),
      ...sourceNodes.values(),
      ...softNodes.values(),
    ]).sort(compareGraphNodes);
    const sortedEdges = [...edges.values()].sort(compareGraphEdges);
    return {
      nodes,
      edges: sortedEdges,
      stats: {
        ...buildStats(sources, contexts, occurrences, links),
        nodeCount: nodes.length,
        edgeCount: sortedEdges.length,
      },
      limit: seed.limit,
      cursor: seed.cursor,
      nextCursor: seed.nextCursor,
    };
  }
}
