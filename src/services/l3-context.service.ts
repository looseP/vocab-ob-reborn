/**
 * L3ContextService — minimal L3 context-space business rules.
 *
 * This service intentionally depends only on the L3 repository boundary. It
 * does not import LLM, dictionary, FSRS, L2 content, or review progress code.
 */

import { NotFoundError, ValidationError } from "../errors";
import type {
  Json,
  L3ContextLinkRow,
  L3ContextRow,
  L3ImportJobRow,
  L3OccurrenceRow,
  L3PaginatedList,
  L3SourceContextListItem,
  L3SourceRow,
  L3WordContextListItem,
} from "../domain";
import type {
  IL3ContextRepository,
  NewL3Context,
  NewL3ContextLink,
  NewL3ImportJob,
  NewL3Occurrence,
  NewL3Source,
} from "../repositories/interfaces";
import {
  L3_CONTEXT_LINK_TARGET_TYPES,
  L3_CONTEXT_LINK_TYPES,
  L3_CONTEXT_TYPES,
  L3_IMPORT_JOB_STATUSES,
  L3_SOURCE_TYPES,
  type CreateL3ContextInput,
  type CreateL3ContextLinkInput,
  type CreateL3ImportJobInput,
  type CreateL3OccurrenceInput,
  type CreateL3SourceInput,
} from "../schemas/service";

function requireEnum(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new ValidationError(`Invalid ${field}: ${value}`, field);
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} cannot be empty`, field);
  }
}

function validateConfidence(confidence: number | null | undefined, field = "confidence"): void {
  if (confidence === undefined || confidence === null) return;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new ValidationError(`${field} must be between 0 and 1`, field);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuidTargetId(targetId: string | null | undefined, targetType: string): string {
  if (!targetId) {
    throw new ValidationError(`targetId is required when targetType is ${targetType}`, "targetId");
  }
  if (!UUID_RE.test(targetId)) {
    throw new ValidationError(`targetId must be a UUID when targetType is ${targetType}`, "targetId");
  }
  return targetId;
}

function validateOffset(input: CreateL3OccurrenceInput, context: L3ContextRow): void {
  const start = input.startOffset ?? null;
  const end = input.endOffset ?? null;
  if (start === null && end === null) return;
  if (start === null || end === null) {
    throw new ValidationError("startOffset and endOffset must be provided together", "offset");
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new ValidationError("Invalid occurrence offsets", "offset");
  }
  if (end > context.text.length) {
    throw new ValidationError("Occurrence offsets exceed context text length", "offset");
  }
  if (context.text.slice(start, end) !== input.surface) {
    throw new ValidationError("Occurrence surface does not match context text at offsets", "surface");
  }
}

function isObject(value: Json | undefined | null): value is Record<string, Json> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireL2SoftTargetRef(targetRef: Json | undefined): void {
  if (!isObject(targetRef)) {
    throw new ValidationError("targetRef is required for l2_item soft references", "targetRef");
  }
  const hasField = typeof targetRef.field === "string" && targetRef.field.trim().length > 0;
  const hasContentLocator =
    (typeof targetRef.contentId === "string" && targetRef.contentId.trim().length > 0) ||
    (typeof targetRef.hash === "string" && targetRef.hash.trim().length > 0) ||
    (typeof targetRef.sourceRef === "string" && targetRef.sourceRef.trim().length > 0);
  if (!hasField || !hasContentLocator) {
    throw new ValidationError(
      "l2_item targetRef requires field plus one of contentId, hash, or sourceRef",
      "targetRef",
    );
  }
}

export class L3ContextService {
  constructor(private readonly l3Context: IL3ContextRepository) {}

  async createSource(input: CreateL3SourceInput): Promise<{ source: L3SourceRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.title, "title");
    requireEnum(input.sourceType, L3_SOURCE_TYPES, "sourceType");

    if (input.wordbookId) {
      const wordbook = await this.l3Context.findWordbookByIdForUser(input.userId, input.wordbookId);
      if (!wordbook) {
        throw new NotFoundError("Wordbook", input.wordbookId);
      }
    }

    const source = await this.l3Context.createSource({
      user_id: input.userId,
      wordbook_id: input.wordbookId ?? null,
      source_type: input.sourceType,
      title: input.title.trim(),
      author: input.author ?? null,
      url: input.url ?? null,
      language: input.language ?? null,
      metadata: input.metadata ?? {},
    } satisfies NewL3Source);
    return { source };
  }

  async createContext(input: CreateL3ContextInput): Promise<{ context: L3ContextRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.text, "text");
    requireEnum(input.contextType, L3_CONTEXT_TYPES, "contextType");

    const source = await this.l3Context.findSourceById(input.userId, input.sourceId);
    if (!source) {
      throw new NotFoundError("L3Source", input.sourceId);
    }

    const context = await this.l3Context.createContext({
      user_id: input.userId,
      source_id: input.sourceId,
      context_type: input.contextType,
      text: input.text,
      normalized_text: input.normalizedText ?? null,
      language: input.language ?? source.language,
      position: input.position ?? {},
      metadata: input.metadata ?? {},
    } satisfies NewL3Context);
    return { context };
  }

  async createOccurrence(input: CreateL3OccurrenceInput): Promise<{ occurrence: L3OccurrenceRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.surface, "surface");
    validateConfidence(input.confidence);

    const contextWithSource = await this.l3Context.findContextWithSourceById(input.userId, input.contextId);
    if (!contextWithSource) {
      throw new NotFoundError("L3Context", input.contextId);
    }
    const { context, source } = contextWithSource;

    const word = source.wordbook_id
      ? input.wordId
        ? await this.l3Context.findWordInWordbookById(source.wordbook_id, input.wordId)
        : input.slug
          ? await this.l3Context.findWordInWordbookBySlug(source.wordbook_id, input.slug)
          : null
      : input.wordId
        ? await this.l3Context.findWordById(input.wordId)
        : input.slug
          ? await this.l3Context.findWordBySlug(input.slug)
          : null;
    if (!word) {
      throw new NotFoundError("Word", input.wordId ?? input.slug ?? "");
    }

    validateOffset(input, context);

    const occurrence = await this.l3Context.createOccurrence({
      user_id: input.userId,
      context_id: input.contextId,
      word_id: word.id,
      surface: input.surface,
      lemma: input.lemma ?? null,
      start_offset: input.startOffset ?? null,
      end_offset: input.endOffset ?? null,
      confidence: input.confidence ?? null,
      evidence: input.evidence ?? {},
    } satisfies NewL3Occurrence);
    return { occurrence };
  }

  async createContextLink(input: CreateL3ContextLinkInput): Promise<{ link: L3ContextLinkRow }> {
    requireNonEmpty(input.userId, "userId");
    requireEnum(input.linkType, L3_CONTEXT_LINK_TYPES, "linkType");
    requireEnum(input.targetType, L3_CONTEXT_LINK_TARGET_TYPES, "targetType");
    validateConfidence(input.confidence);

    if (!input.contextId && !input.wordId) {
      throw new ValidationError("contextId or wordId is required", "contextId");
    }
    let contextWithSource: Awaited<ReturnType<IL3ContextRepository["findContextWithSourceById"]>> = null;
    if (input.contextId) {
      contextWithSource = await this.l3Context.findContextWithSourceById(input.userId, input.contextId);
      if (!contextWithSource) {
        throw new NotFoundError("L3Context", input.contextId);
      }
    }
    if (input.wordId) {
      const word = contextWithSource?.source.wordbook_id
        ? await this.l3Context.findWordInWordbookById(contextWithSource.source.wordbook_id, input.wordId)
        : await this.l3Context.findWordById(input.wordId);
      if (!word) {
        throw new NotFoundError("Word", input.wordId);
      }
    }
    if (input.targetType === "word") {
      const targetId = requireUuidTargetId(input.targetId, "word");
      const word = contextWithSource?.source.wordbook_id
        ? await this.l3Context.findWordInWordbookById(contextWithSource.source.wordbook_id, targetId)
        : await this.l3Context.findWordById(targetId);
      if (!word) {
        throw new NotFoundError("Word", targetId);
      }
    }
    if (input.targetType === "context") {
      const targetId = requireUuidTargetId(input.targetId, "context");
      const context = await this.l3Context.findContextById(input.userId, targetId);
      if (!context) {
        throw new NotFoundError("L3Context", targetId);
      }
    }
    if (input.targetType === "source") {
      const targetId = requireUuidTargetId(input.targetId, "source");
      const source = await this.l3Context.findSourceById(input.userId, targetId);
      if (!source) {
        throw new NotFoundError("L3Source", targetId);
      }
    }
    if (input.targetType === "l2_item") {
      requireL2SoftTargetRef(input.targetRef);
    }

    const link = await this.l3Context.createContextLink({
      user_id: input.userId,
      context_id: input.contextId ?? null,
      word_id: input.wordId ?? null,
      link_type: input.linkType,
      target_type: input.targetType,
      target_id: input.targetId ?? null,
      target_ref: input.targetRef ?? {},
      confidence: input.confidence ?? null,
      provenance: input.provenance ?? {},
    } satisfies NewL3ContextLink);
    return { link };
  }

  async createImportJob(input: CreateL3ImportJobInput): Promise<{ importJob: L3ImportJobRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.inputHash, "inputHash");
    requireEnum(input.status, L3_IMPORT_JOB_STATUSES, "status");
    if (input.sourceId) {
      const source = await this.l3Context.findSourceById(input.userId, input.sourceId);
      if (!source) {
        throw new NotFoundError("L3Source", input.sourceId);
      }
    }

    const importJob = await this.l3Context.createImportJob({
      user_id: input.userId,
      source_id: input.sourceId ?? null,
      status: input.status,
      input_hash: input.inputHash,
      input_summary: input.inputSummary ?? null,
      stats: input.stats ?? {},
      error: input.error ?? null,
    } satisfies NewL3ImportJob);
    return { importJob };
  }

  async listContextsForWord(input: {
    userId: string;
    wordId?: string;
    slug?: string;
    limit: number;
    cursor?: string | null;
  }): Promise<L3PaginatedList<L3WordContextListItem>> {
    requireNonEmpty(input.userId, "userId");
    if (!input.wordId && !input.slug) {
      throw new ValidationError("wordId or slug is required", "word");
    }
    if (input.slug) {
      const word = await this.l3Context.findWordBySlug(input.slug);
      if (!word) throw new NotFoundError("Word", input.slug);
    }
    if (input.wordId) {
      const word = await this.l3Context.findWordById(input.wordId);
      if (!word) throw new NotFoundError("Word", input.wordId);
    }
    return this.l3Context.listContextsForWord(input);
  }

  async listContextsForSource(input: {
    userId: string;
    sourceId: string;
    limit: number;
    cursor?: string | null;
  }): Promise<L3PaginatedList<L3SourceContextListItem>> {
    requireNonEmpty(input.userId, "userId");
    const source = await this.l3Context.findSourceById(input.userId, input.sourceId);
    if (!source) {
      throw new NotFoundError("L3Source", input.sourceId);
    }
    return this.l3Context.listContextsForSource(input);
  }
}
