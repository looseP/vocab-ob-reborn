/**
 * L3ContextService — minimal L3 context-space business rules.
 *
 * This service intentionally depends only on the L3 repository boundary. It
 * does not import LLM, dictionary, FSRS, L2 content, or review progress code.
 */

import type { PoolClient } from "pg";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
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
  IRepositories,
  L3ContextDeleteBlockers,
  L3SourceDeleteBlockers,
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
  type DeleteL3ContextInput,
  type DeleteL3ContextLinkInput,
  type DeleteL3OccurrenceInput,
  type DeleteL3SourceInput,
  type L3DeleteResult,
} from "../schemas/service";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

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
  return targetId.toLowerCase();
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

function hasSourceDeleteBlockers(blockers: L3SourceDeleteBlockers): boolean {
  return blockers.contextCount > 0 ||
    blockers.inboundContextLinkCount > 0 ||
    blockers.importJobCount > 0;
}

function hasContextDeleteBlockers(blockers: L3ContextDeleteBlockers): boolean {
  return blockers.occurrenceCount > 0 ||
    blockers.contextLinkCount > 0 ||
    blockers.inboundContextLinkCount > 0;
}

function deleteConflict(
  entityType: "source" | "context",
  id: string,
  blockers: L3SourceDeleteBlockers | L3ContextDeleteBlockers,
): ConflictError {
  return new ConflictError(`Cannot delete L3 ${entityType} with active dependencies`, undefined, {
    entityType,
    id,
    blockers,
  });
}

export class L3ContextService {
  constructor(
    private readonly l3Context: IL3ContextRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  async createSource(input: CreateL3SourceInput): Promise<{ source: L3SourceRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.title, "title");
    requireEnum(input.sourceType, L3_SOURCE_TYPES, "sourceType");

    return this.withActorRepository(input.userId, async (repository) => {
      if (input.wordbookId) {
        const wordbook = await repository.findWordbookByIdForUser(input.userId, input.wordbookId);
        if (!wordbook) {
          throw new NotFoundError("Wordbook", input.wordbookId);
        }
      }

      const source = await repository.createSource({
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
    });
  }

  async createContext(input: CreateL3ContextInput): Promise<{ context: L3ContextRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.text, "text");
    requireEnum(input.contextType, L3_CONTEXT_TYPES, "contextType");

    return this.withActorRepository(input.userId, async (repository) => {
      const source = await repository.findSourceById(input.userId, input.sourceId);
      if (!source) {
        throw new NotFoundError("L3Source", input.sourceId);
      }

      const context = await repository.createContext({
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
    });
  }

  async createOccurrence(input: CreateL3OccurrenceInput): Promise<{ occurrence: L3OccurrenceRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.surface, "surface");
    validateConfidence(input.confidence);

    return this.withActorRepository(input.userId, async (repository) => {
      const contextWithSource = await repository.findContextWithSourceById(input.userId, input.contextId);
      if (!contextWithSource) {
        throw new NotFoundError("L3Context", input.contextId);
      }
      const { context, source } = contextWithSource;

      const word = source.wordbook_id
        ? input.wordId
          ? await repository.findWordInWordbookById(source.wordbook_id, input.wordId)
          : input.slug
            ? await repository.findWordInWordbookBySlug(source.wordbook_id, input.slug)
            : null
        : input.wordId
          ? await repository.findWordById(input.wordId)
          : input.slug
            ? await repository.findWordBySlug(input.slug)
            : null;
      if (!word) {
        throw new NotFoundError("Word", input.wordId ?? input.slug ?? "");
      }

      validateOffset(input, context);

      const occurrence = await repository.createOccurrence({
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
    });
  }

  async createContextLink(input: CreateL3ContextLinkInput): Promise<{ link: L3ContextLinkRow }> {
    requireNonEmpty(input.userId, "userId");
    requireEnum(input.linkType, L3_CONTEXT_LINK_TYPES, "linkType");
    requireEnum(input.targetType, L3_CONTEXT_LINK_TARGET_TYPES, "targetType");
    validateConfidence(input.confidence);

    const needsSoftTargetLock = input.targetType === "source" || input.targetType === "context";
    if (needsSoftTargetLock) {
      return this.txRunner(async (tx) => {
        const repos = this.repositoryFactory(tx);
        return this.createContextLinkWithRepository(input, repos.l3Context, true);
      }, { actorId: input.userId });
    }

    return this.withActorRepository(
      input.userId,
      (repository) => this.createContextLinkWithRepository(input, repository, false),
    );
  }

  private async createContextLinkWithRepository(
    input: CreateL3ContextLinkInput,
    repository: IL3ContextRepository,
    lockSoftTarget: boolean,
  ): Promise<{ link: L3ContextLinkRow }> {
    if (!input.contextId && !input.wordId) {
      throw new ValidationError("contextId or wordId is required", "contextId");
    }
    let targetIdForInsert = input.targetId ?? null;
    let contextWithSource: Awaited<ReturnType<IL3ContextRepository["findContextWithSourceById"]>> = null;
    if (input.contextId) {
      contextWithSource = await repository.findContextWithSourceById(input.userId, input.contextId);
      if (!contextWithSource) {
        throw new NotFoundError("L3Context", input.contextId);
      }
    }
    if (input.wordId) {
      const word = contextWithSource?.source.wordbook_id
        ? await repository.findWordInWordbookById(contextWithSource.source.wordbook_id, input.wordId)
        : await repository.findWordById(input.wordId);
      if (!word) {
        throw new NotFoundError("Word", input.wordId);
      }
    }
    if (input.targetType === "word") {
      const targetId = requireUuidTargetId(input.targetId, "word");
      targetIdForInsert = targetId;
      const word = contextWithSource?.source.wordbook_id
        ? await repository.findWordInWordbookById(contextWithSource.source.wordbook_id, targetId)
        : await repository.findWordById(targetId);
      if (!word) {
        throw new NotFoundError("Word", targetId);
      }
    }
    if (input.targetType === "context") {
      const targetId = requireUuidTargetId(input.targetId, "context");
      targetIdForInsert = targetId;
      if (lockSoftTarget) {
        await repository.lockActiveL3TargetReference(input.userId, "context", targetId);
      }
      const context = await repository.findContextById(input.userId, targetId);
      if (!context) {
        throw new NotFoundError("L3Context", targetId);
      }
    }
    if (input.targetType === "source") {
      const targetId = requireUuidTargetId(input.targetId, "source");
      targetIdForInsert = targetId;
      if (lockSoftTarget) {
        await repository.lockActiveL3TargetReference(input.userId, "source", targetId);
      }
      const source = await repository.findSourceById(input.userId, targetId);
      if (!source) {
        throw new NotFoundError("L3Source", targetId);
      }
    }
    if (input.targetType === "l2_item") {
      requireL2SoftTargetRef(input.targetRef);
    }

    const link = await repository.createContextLink({
      user_id: input.userId,
      context_id: input.contextId ?? null,
      word_id: input.wordId ?? null,
      link_type: input.linkType,
      target_type: input.targetType,
      target_id: targetIdForInsert,
      target_ref: input.targetRef ?? {},
      confidence: input.confidence ?? null,
      provenance: input.provenance ?? {},
    } satisfies NewL3ContextLink);
    return { link };
  }

  async deleteOccurrence(input: DeleteL3OccurrenceInput): Promise<L3DeleteResult> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.occurrenceId, "occurrenceId");

    return this.withActorRepository(input.userId, async (repository) => {
      const deleted = await repository.deleteOccurrence(input.userId, input.occurrenceId);
      if (!deleted) {
        throw new NotFoundError("L3Occurrence", input.occurrenceId);
      }

      return {
        deleted: { entityType: "occurrence", id: deleted.id },
        activeReadInvalidation: true,
      };
    });
  }

  async deleteContextLink(input: DeleteL3ContextLinkInput): Promise<L3DeleteResult> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.contextLinkId, "contextLinkId");

    return this.withActorRepository(input.userId, async (repository) => {
      const deleted = await repository.deleteContextLink(input.userId, input.contextLinkId);
      if (!deleted) {
        throw new NotFoundError("L3ContextLink", input.contextLinkId);
      }

      return {
        deleted: { entityType: "context_link", id: deleted.id },
        activeReadInvalidation: true,
      };
    });
  }

  async deleteSource(input: DeleteL3SourceInput): Promise<L3DeleteResult> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.sourceId, "sourceId");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const source = await repos.l3Context.lockSourceByIdForUser(input.userId, input.sourceId);
      if (!source) {
        throw new NotFoundError("L3Source", input.sourceId);
      }

      await repos.l3Context.lockActiveL3TargetReference(input.userId, "source", input.sourceId);
      const blockers = await repos.l3Context.getSourceDeleteBlockers(input.userId, input.sourceId);
      if (hasSourceDeleteBlockers(blockers)) {
        throw deleteConflict("source", input.sourceId, blockers);
      }

      const deleted = await repos.l3Context.deleteSource(input.userId, input.sourceId);
      if (!deleted) {
        const current = await repos.l3Context.findSourceById(input.userId, input.sourceId);
        if (!current) {
          throw new NotFoundError("L3Source", input.sourceId);
        }
        const latestBlockers = await repos.l3Context.getSourceDeleteBlockers(input.userId, input.sourceId);
        throw deleteConflict("source", input.sourceId, latestBlockers);
      }

      return {
        deleted: { entityType: "source", id: deleted.id },
        activeReadInvalidation: true,
      };
    }, { actorId: input.userId });
  }

  async deleteContext(input: DeleteL3ContextInput): Promise<L3DeleteResult> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.contextId, "contextId");

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const context = await repos.l3Context.lockContextByIdForUser(input.userId, input.contextId);
      if (!context) {
        throw new NotFoundError("L3Context", input.contextId);
      }

      await repos.l3Context.lockActiveL3TargetReference(input.userId, "context", input.contextId);
      const blockers = await repos.l3Context.getContextDeleteBlockers(input.userId, input.contextId);
      if (hasContextDeleteBlockers(blockers)) {
        throw deleteConflict("context", input.contextId, blockers);
      }

      const deleted = await repos.l3Context.deleteContext(input.userId, input.contextId);
      if (!deleted) {
        const current = await repos.l3Context.findContextById(input.userId, input.contextId);
        if (!current) {
          throw new NotFoundError("L3Context", input.contextId);
        }
        const latestBlockers = await repos.l3Context.getContextDeleteBlockers(input.userId, input.contextId);
        throw deleteConflict("context", input.contextId, latestBlockers);
      }

      return {
        deleted: { entityType: "context", id: deleted.id },
        activeReadInvalidation: true,
      };
    }, { actorId: input.userId });
  }

  async createImportJob(input: CreateL3ImportJobInput): Promise<{ importJob: L3ImportJobRow }> {
    requireNonEmpty(input.userId, "userId");
    requireNonEmpty(input.inputHash, "inputHash");
    requireEnum(input.status, L3_IMPORT_JOB_STATUSES, "status");
    return this.withActorRepository(input.userId, async (repository) => {
      if (input.sourceId) {
        const source = await repository.findSourceById(input.userId, input.sourceId);
        if (!source) {
          throw new NotFoundError("L3Source", input.sourceId);
        }
      }

      const importJob = await repository.createImportJob({
        user_id: input.userId,
        source_id: input.sourceId ?? null,
        status: input.status,
        input_hash: input.inputHash,
        input_summary: input.inputSummary ?? null,
        stats: input.stats ?? {},
        error: input.error ?? null,
      } satisfies NewL3ImportJob);
      return { importJob };
    });
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
    return this.withActorRepository(input.userId, async (repository) => {
      if (input.slug) {
        const word = await repository.findWordBySlug(input.slug);
        if (!word) throw new NotFoundError("Word", input.slug);
      }
      if (input.wordId) {
        const word = await repository.findWordById(input.wordId);
        if (!word) throw new NotFoundError("Word", input.wordId);
      }
      return repository.listContextsForWord(input);
    });
  }

  async listContextsForSource(input: {
    userId: string;
    sourceId: string;
    limit: number;
    cursor?: string | null;
  }): Promise<L3PaginatedList<L3SourceContextListItem>> {
    requireNonEmpty(input.userId, "userId");
    return this.withActorRepository(input.userId, async (repository) => {
      const source = await repository.findSourceById(input.userId, input.sourceId);
      if (!source) {
        throw new NotFoundError("L3Source", input.sourceId);
      }
      return repository.listContextsForSource(input);
    });
  }

  private withActorRepository<T>(
    userId: string,
    callback: (repository: IL3ContextRepository) => Promise<T>,
  ): Promise<T> {
    return this.txRunner(async (tx) => callback(this.repositoryFactory(tx).l3Context), { actorId: userId });
  }
}
