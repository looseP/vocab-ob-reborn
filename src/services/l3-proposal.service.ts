/**
 * L3ProposalService - review gate for untrusted L3 candidates.
 *
 * Proposal create/validate/reject never writes active L3 tables. Confirm is the
 * only upgrade path and reuses L3ContextService inside one transaction.
 */

import type { PoolClient } from "pg";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type {
  IL3ContextRepository,
  IL3ProposalRepository,
  IRepositories,
} from "../repositories/interfaces";
import type {
  Json,
  L3PaginatedList,
  L3ProposalBundle,
  L3ProposalConfirmResult,
  L3ProposalItemRow,
  L3ProposalRow,
  L3ProposalValidationIssue,
  L3ProposalValidationResult,
} from "../domain";
import {
  L3_CONTEXT_LINK_TARGET_TYPES,
  L3_CONTEXT_LINK_TYPES,
  L3_CONTEXT_TYPES,
  L3_PROPOSAL_ITEM_TYPES,
  L3_PROPOSAL_SOURCE_TYPES,
  L3_PROPOSAL_STATUSES,
  L3_SOURCE_TYPES,
  type CreateL3ProposalInput,
  type L3ProposalIdInput,
  type ListL3ProposalsInput,
  type RejectL3ProposalInput,
} from "../schemas/service";
import { L3ContextService } from "./l3-context.service";
import {
  assertJsonResourceBudget,
  JSON_MAX_DEPTH,
  L3_PROPOSAL_MAX_ITEMS,
  L3_PROPOSAL_PAYLOAD_MAX_BYTES,
  L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES,
} from "../schemas/resource-budget";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ResolvedSource {
  id: string | null;
  wordbookId: string | null;
}

interface ResolvedContext {
  id: string | null;
  text: string;
  source: ResolvedSource;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} cannot be empty`, field);
  }
}

function requireEnum(value: string, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new ValidationError(`Invalid ${field}: ${value}`, field);
  }
}

function isRecord(value: Json | unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalString(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  return typeof value === "string" ? value : null;
}

function optionalNumber(payload: Record<string, unknown>, field: string): number | null {
  const value = payload[field];
  return typeof value === "number" ? value : null;
}

function optionalJsonRecord(payload: Record<string, unknown>, field: string): Json {
  const value = payload[field];
  return isRecord(value) ? value as Json : {};
}

function requireUuidTargetId(targetId: string | null, targetType: string, push: (field: string, message: string) => void): string | null {
  if (!targetId) {
    push("targetId", `targetId is required when targetType is ${targetType}`);
    return null;
  }
  if (!UUID_RE.test(targetId)) {
    push("targetId", `targetId must be a UUID when targetType is ${targetType}`);
    return null;
  }
  return targetId;
}

function isL2SoftTargetRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hasField = typeof value.field === "string" && value.field.trim().length > 0;
  const hasLocator =
    (typeof value.contentId === "string" && value.contentId.trim().length > 0) ||
    (typeof value.hash === "string" && value.hash.trim().length > 0) ||
    (typeof value.sourceRef === "string" && value.sourceRef.trim().length > 0);
  return hasField && hasLocator;
}

function addIssue(
  errors: L3ProposalValidationIssue[],
  item: L3ProposalItemRow,
  field: string,
  message: string,
): void {
  errors.push({
    itemId: item.id,
    ordinal: item.ordinal,
    itemType: item.item_type,
    field,
    message,
  });
}

export class L3ProposalService {
  constructor(
    _proposals: IL3ProposalRepository,
    _l3Context: IL3ContextRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  async createProposal(input: CreateL3ProposalInput): Promise<L3ProposalBundle> {
    requireNonEmpty(input.userId, "userId");
    requireEnum(input.sourceType, L3_PROPOSAL_SOURCE_TYPES, "sourceType");
    if (input.items.length === 0) {
      throw new ValidationError("Proposal requires at least one item", "items");
    }
    if (input.items.length > L3_PROPOSAL_MAX_ITEMS) {
      throw new ValidationError(
        `Proposal exceeds maximum of ${L3_PROPOSAL_MAX_ITEMS} items`,
        "items",
      );
    }
    let totalPayloadBytes = 0;
    for (const item of input.items) {
      requireEnum(item.itemType, L3_PROPOSAL_ITEM_TYPES, "itemType");
      if (!isRecord(item.payload)) {
        throw new ValidationError("Proposal item payload must be an object", "payload");
      }
      try {
        totalPayloadBytes += assertJsonResourceBudget(item.payload, {
          maxBytes: L3_PROPOSAL_PAYLOAD_MAX_BYTES,
          maxDepth: JSON_MAX_DEPTH,
        });
      } catch (error) {
        throw new ValidationError(
          error instanceof Error ? error.message : "Proposal payload exceeds resource budget",
          "payload",
        );
      }
      if (totalPayloadBytes > L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES) {
        throw new ValidationError(
          `Proposal payloads exceed ${L3_PROPOSAL_TOTAL_PAYLOAD_MAX_BYTES} total bytes`,
          "items",
        );
      }
    }
    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      if (input.wordbookId) {
        const wordbook = await repos.l3Context.findWordbookByIdForUser(
          input.userId,
          input.wordbookId,
        );
        if (!wordbook) throw new NotFoundError("Wordbook", input.wordbookId);
      }
      return this.createProposalInTx(tx, input);
    }, { actorId: input.userId });
  }

  /**
   * Create a proposal + items within an existing transaction. The caller is
   * responsible for committing or rolling back the transaction, and for
   * validating the input before calling this method.
   */
  async createProposalInTx(tx: PoolClient, input: CreateL3ProposalInput): Promise<L3ProposalBundle> {
    const repos = this.repositoryFactory(tx);
    const proposal = await repos.l3Proposal.createProposal({
      user_id: input.userId,
      wordbook_id: input.wordbookId ?? null,
      source_type: input.sourceType,
      title: input.title ?? null,
      summary: input.summary ?? null,
      input_hash: input.inputHash ?? null,
      proposed_by: input.proposedBy ?? null,
      provenance: input.provenance ?? {},
    });

    const items: L3ProposalItemRow[] = [];
    for (const [index, item] of input.items.entries()) {
      const payload = {
        ...(item.payload as Record<string, unknown>),
        ...(item.clientRef ? { clientRef: item.clientRef } : {}),
      } as Json;
      items.push(await repos.l3Proposal.createProposalItem({
        proposal_id: proposal.id,
        user_id: input.userId,
        item_type: item.itemType,
        ordinal: index + 1,
        payload,
      }));
    }
    return { proposal, items };
  }

  async listProposals(input: ListL3ProposalsInput): Promise<L3PaginatedList<L3ProposalRow>> {
    requireNonEmpty(input.userId, "userId");
    if (input.status) requireEnum(input.status, L3_PROPOSAL_STATUSES, "status");
    return this.withActorProposalRepository(
      input.userId,
      (proposals) => proposals.listProposals(input),
    );
  }

  async getProposal(input: L3ProposalIdInput): Promise<L3ProposalBundle> {
    requireNonEmpty(input.userId, "userId");
    return this.withActorProposalRepository(
      input.userId,
      (proposals) => this.requireProposalBundle(proposals, input),
    );
  }

  private async requireProposalBundle(
    proposals: IL3ProposalRepository,
    input: L3ProposalIdInput,
  ): Promise<L3ProposalBundle> {
    const bundle = await proposals.getProposalBundle(input.userId, input.proposalId);
    if (!bundle) throw new NotFoundError("L3Proposal", input.proposalId);
    return bundle;
  }

  private withActorProposalRepository<T>(
    userId: string,
    callback: (proposals: IL3ProposalRepository) => Promise<T>,
  ): Promise<T> {
    return this.txRunner(
      async (tx) => callback(this.repositoryFactory(tx).l3Proposal),
      { actorId: userId },
    );
  }

  /** Find a proposal by (userId, inputHash) — used by L3ImportService for dedup. */
  async findProposalByInputHash(userId: string, inputHash: string): Promise<L3ProposalRow | null> {
    return this.withActorProposalRepository(
      userId,
      (proposals) => proposals.findProposalByInputHash(userId, inputHash),
    );
  }

  async validateProposal(input: L3ProposalIdInput): Promise<L3ProposalValidationResult> {
    requireNonEmpty(input.userId, "userId");
    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const bundle = await this.requireProposalBundle(repos.l3Proposal, input);
      if (bundle.proposal.status !== "pending") {
        throw new ConflictError(`Cannot validate ${bundle.proposal.status} proposal`);
      }
      const errors = await this.validateItems(bundle.proposal, bundle.items, repos.l3Context);
      const updatedItems: L3ProposalItemRow[] = [];
      for (const item of bundle.items) {
        const itemErrors = errors.filter((error) => error.itemId === item.id);
        updatedItems.push(await repos.l3Proposal.updateProposalItemValidation(
          item.id,
          input.userId,
          itemErrors as unknown as Json,
        ));
      }
      return {
        proposal: bundle.proposal,
        items: updatedItems,
        valid: errors.length === 0,
        errors,
      };
    }, { actorId: input.userId });
  }

  async confirmProposal(input: L3ProposalIdInput): Promise<L3ProposalConfirmResult> {
    const preflight = await this.validateProposal(input);
    if (!preflight.valid) {
      throw new ValidationError("Proposal validation failed", "proposal", preflight.errors);
    }

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const proposal = await repos.l3Proposal.lockProposalByIdForUser(input.userId, input.proposalId);
      if (!proposal) throw new NotFoundError("L3Proposal", input.proposalId);
      if (proposal.status !== "pending") {
        throw new ConflictError(`Cannot confirm ${proposal.status} proposal`);
      }
      const items = await repos.l3Proposal.findProposalItems(input.userId, input.proposalId);
      const recheckErrors = await this.validateItems(proposal, items, repos.l3Context);
      if (recheckErrors.length > 0) {
        throw new ValidationError("Proposal validation failed", "proposal", recheckErrors);
      }

      const l3Service = new L3ContextService(
        repos.l3Context,
        async (callback) => callback(tx),
        () => repos,
      );
      const sourceIds = new Map<string, string>();
      const contextIds = new Map<string, string>();
      const activeEntities: L3ProposalConfirmResult["activeEntities"] = [];
      const updatedItems: L3ProposalItemRow[] = [];

      for (const item of items) {
        const payload = item.payload as Record<string, unknown>;
        if (item.item_type === "source") {
          const result = await l3Service.createSource({
            userId: input.userId,
            wordbookId: optionalString(payload, "wordbookId") ?? proposal.wordbook_id,
            sourceType: stringField(payload, "sourceType") as never,
            title: stringField(payload, "title") ?? "",
            author: optionalString(payload, "author"),
            url: optionalString(payload, "url"),
            language: optionalString(payload, "language"),
            metadata: optionalJsonRecord(payload, "metadata"),
          });
          this.rememberClientRef(sourceIds, item, result.source.id);
          updatedItems.push(await this.markConfirmed(repos.l3Proposal, item, input.userId, "source", result.source.id, activeEntities));
        }
        if (item.item_type === "context") {
          const sourceId = optionalString(payload, "sourceId") ?? sourceIds.get(stringField(payload, "sourceRef") ?? "") ?? "";
          const result = await l3Service.createContext({
            userId: input.userId,
            sourceId,
            contextType: stringField(payload, "contextType") as never,
            text: stringField(payload, "text") ?? "",
            normalizedText: optionalString(payload, "normalizedText"),
            language: optionalString(payload, "language"),
            position: optionalJsonRecord(payload, "position"),
            metadata: optionalJsonRecord(payload, "metadata"),
          });
          this.rememberClientRef(contextIds, item, result.context.id);
          updatedItems.push(await this.markConfirmed(repos.l3Proposal, item, input.userId, "context", result.context.id, activeEntities));
        }
        if (item.item_type === "occurrence") {
          const contextId = optionalString(payload, "contextId") ?? contextIds.get(stringField(payload, "contextRef") ?? "") ?? "";
          const result = await l3Service.createOccurrence({
            userId: input.userId,
            contextId,
            wordId: optionalString(payload, "wordId") ?? undefined,
            slug: optionalString(payload, "slug") ?? undefined,
            surface: stringField(payload, "surface") ?? "",
            lemma: optionalString(payload, "lemma"),
            startOffset: optionalNumber(payload, "startOffset"),
            endOffset: optionalNumber(payload, "endOffset"),
            confidence: optionalNumber(payload, "confidence"),
            evidence: optionalJsonRecord(payload, "evidence"),
          });
          updatedItems.push(await this.markConfirmed(repos.l3Proposal, item, input.userId, "occurrence", result.occurrence.id, activeEntities));
        }
        if (item.item_type === "context_link") {
          const contextId = optionalString(payload, "contextId") ?? contextIds.get(stringField(payload, "contextRef") ?? "") ?? null;
          const result = await l3Service.createContextLink({
            userId: input.userId,
            contextId,
            wordId: optionalString(payload, "wordId"),
            linkType: stringField(payload, "linkType") as never,
            targetType: stringField(payload, "targetType") as never,
            targetId: optionalString(payload, "targetId"),
            targetRef: optionalJsonRecord(payload, "targetRef"),
            confidence: optionalNumber(payload, "confidence"),
            provenance: optionalJsonRecord(payload, "provenance"),
          });
          updatedItems.push(await this.markConfirmed(repos.l3Proposal, item, input.userId, "context_link", result.link.id, activeEntities));
        }
      }

      const confirmed = await repos.l3Proposal.markProposalConfirmed(input.proposalId, input.userId);
      return { proposal: confirmed, items: updatedItems, activeEntities };
    }, { actorId: input.userId });
  }

  async rejectProposal(input: RejectL3ProposalInput): Promise<L3ProposalBundle> {
    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const proposal = await repos.l3Proposal.lockProposalByIdForUser(input.userId, input.proposalId);
      if (!proposal) throw new NotFoundError("L3Proposal", input.proposalId);
      if (proposal.status !== "pending") {
        throw new ConflictError(`Cannot reject ${proposal.status} proposal`);
      }
      await repos.l3Proposal.markProposalItemsRejected(input.proposalId, input.userId);
      const rejected = await repos.l3Proposal.markProposalRejected(input.proposalId, input.userId, input.reviewNote ?? null);
      const items = await repos.l3Proposal.findProposalItems(input.userId, input.proposalId);
      return { proposal: rejected, items };
    }, { actorId: input.userId });
  }

  private async markConfirmed(
    repo: IL3ProposalRepository,
    item: L3ProposalItemRow,
    userId: string,
    activeEntityType: "source" | "context" | "occurrence" | "context_link",
    activeEntityId: string,
    activeEntities: L3ProposalConfirmResult["activeEntities"],
  ): Promise<L3ProposalItemRow> {
    const updated = await repo.markProposalItemConfirmed(item.id, userId, activeEntityType, activeEntityId);
    activeEntities.push({
      itemId: item.id,
      itemType: item.item_type,
      activeEntityType,
      activeEntityId,
    });
    return updated;
  }

  private rememberClientRef(refs: Map<string, string>, item: L3ProposalItemRow, activeId: string): void {
    const payload = item.payload as Record<string, unknown>;
    const clientRef = stringField(payload, "clientRef");
    if (clientRef) refs.set(clientRef, activeId);
  }

  private async validateItems(
    proposal: L3ProposalRow,
    items: L3ProposalItemRow[],
    contextRepo: IL3ContextRepository,
  ): Promise<L3ProposalValidationIssue[]> {
    const errors: L3ProposalValidationIssue[] = [];
    const sourceRefs = new Map<string, ResolvedSource>();
    const contextRefs = new Map<string, ResolvedContext>();

    for (const item of items) {
      const push = (field: string, message: string) => addIssue(errors, item, field, message);
      if (!isRecord(item.payload)) {
        push("payload", "payload must be an object");
        continue;
      }
      const payload = item.payload;
      const clientRef = stringField(payload, "clientRef");
      if (clientRef && (sourceRefs.has(clientRef) || contextRefs.has(clientRef))) {
        push("clientRef", `Duplicate clientRef: ${clientRef}`);
      }

      if (item.item_type === "source") {
        const source = await this.validateSourceItem(proposal, item, payload, contextRepo, push);
        if (clientRef && source) sourceRefs.set(clientRef, source);
      } else if (item.item_type === "context") {
        const context = await this.validateContextItem(proposal, payload, contextRepo, sourceRefs, push);
        if (clientRef && context) contextRefs.set(clientRef, context);
      } else if (item.item_type === "occurrence") {
        await this.validateOccurrenceItem(proposal, payload, contextRepo, contextRefs, push);
      } else if (item.item_type === "context_link") {
        await this.validateContextLinkItem(proposal, payload, contextRepo, contextRefs, push);
      } else {
        push("itemType", `Unsupported proposal item type: ${item.item_type}`);
      }
    }
    return errors;
  }

  private async validateSourceItem(
    proposal: L3ProposalRow,
    item: L3ProposalItemRow,
    payload: Record<string, unknown>,
    contextRepo: IL3ContextRepository,
    push: (field: string, message: string) => void,
  ): Promise<ResolvedSource | null> {
    const sourceType = stringField(payload, "sourceType");
    const title = stringField(payload, "title");
    if (!sourceType || !L3_SOURCE_TYPES.includes(sourceType as never)) push("sourceType", "Invalid sourceType");
    if (!title) push("title", "title is required");
    const wordbookId = optionalString(payload, "wordbookId") ?? proposal.wordbook_id;
    if (wordbookId) {
      const wordbook = await contextRepo.findWordbookByIdForUser(proposal.user_id, wordbookId);
      if (!wordbook) push("wordbookId", "wordbookId does not belong to the user");
    }
    return sourceType && title ? { id: null, wordbookId } : null;
  }

  private async validateContextItem(
    proposal: L3ProposalRow,
    payload: Record<string, unknown>,
    contextRepo: IL3ContextRepository,
    sourceRefs: Map<string, ResolvedSource>,
    push: (field: string, message: string) => void,
  ): Promise<ResolvedContext | null> {
    const contextType = stringField(payload, "contextType");
    const text = stringField(payload, "text");
    if (!contextType || !L3_CONTEXT_TYPES.includes(contextType as never)) push("contextType", "Invalid contextType");
    if (!text) push("text", "text is required");
    const source = await this.resolveSource(proposal.user_id, payload, contextRepo, sourceRefs, push);
    return contextType && text && source ? { id: null, text, source } : null;
  }

  private async validateOccurrenceItem(
    proposal: L3ProposalRow,
    payload: Record<string, unknown>,
    contextRepo: IL3ContextRepository,
    contextRefs: Map<string, ResolvedContext>,
    push: (field: string, message: string) => void,
  ): Promise<void> {
    const context = await this.resolveContext(proposal.user_id, payload, contextRepo, contextRefs, push);
    const surface = stringField(payload, "surface");
    if (!surface) push("surface", "surface is required");
    await this.validateWord(payload, context?.source.wordbookId ?? null, contextRepo, push);
    this.validateOffsets(payload, context?.text ?? null, surface, push);
  }

  private async validateContextLinkItem(
    proposal: L3ProposalRow,
    payload: Record<string, unknown>,
    contextRepo: IL3ContextRepository,
    contextRefs: Map<string, ResolvedContext>,
    push: (field: string, message: string) => void,
  ): Promise<void> {
    const hasContext = Boolean(stringField(payload, "contextId") || stringField(payload, "contextRef"));
    const context = hasContext ? await this.resolveContext(proposal.user_id, payload, contextRepo, contextRefs, push) : null;
    const wordId = optionalString(payload, "wordId");
    if (!hasContext && !wordId) push("contextId", "contextId/contextRef or wordId is required");
    if (wordId) {
      const word = context?.source.wordbookId
        ? await contextRepo.findWordInWordbookById(context.source.wordbookId, wordId)
        : await contextRepo.findWordById(wordId);
      if (!word) push("wordId", "wordId does not exist or is outside the context source wordbook");
    }
    const linkType = stringField(payload, "linkType");
    if (!linkType || !L3_CONTEXT_LINK_TYPES.includes(linkType as never)) push("linkType", "Invalid linkType");
    const targetType = stringField(payload, "targetType");
    if (!targetType || !L3_CONTEXT_LINK_TARGET_TYPES.includes(targetType as never)) {
      push("targetType", "Invalid targetType");
      return;
    }
    await this.validateLinkTarget(proposal.user_id, payload, targetType, context?.source.wordbookId ?? null, contextRepo, push);
  }

  private async resolveSource(
    userId: string,
    payload: Record<string, unknown>,
    contextRepo: IL3ContextRepository,
    sourceRefs: Map<string, ResolvedSource>,
    push: (field: string, message: string) => void,
  ): Promise<ResolvedSource | null> {
    const sourceId = optionalString(payload, "sourceId");
    if (sourceId) {
      const source = await contextRepo.findSourceById(userId, sourceId);
      if (source) return { id: source.id, wordbookId: source.wordbook_id };
    }
    const sourceRef = optionalString(payload, "sourceRef");
    if (sourceRef && sourceRefs.has(sourceRef)) return sourceRefs.get(sourceRef) ?? null;
    if (sourceId) push("sourceId", "sourceId must exist and belong to the user");
    else push("sourceRef", "sourceId or valid sourceRef is required");
    return null;
  }

  private async resolveContext(
    userId: string,
    payload: Record<string, unknown>,
    contextRepo: IL3ContextRepository,
    contextRefs: Map<string, ResolvedContext>,
    push: (field: string, message: string) => void,
  ): Promise<ResolvedContext | null> {
    const contextId = optionalString(payload, "contextId");
    if (contextId) {
      const contextWithSource = await contextRepo.findContextWithSourceById(userId, contextId);
      if (contextWithSource) {
        return {
          id: contextWithSource.context.id,
          text: contextWithSource.context.text,
          source: { id: contextWithSource.source.id, wordbookId: contextWithSource.source.wordbook_id },
        };
      }
    }
    const contextRef = optionalString(payload, "contextRef");
    if (contextRef && contextRefs.has(contextRef)) return contextRefs.get(contextRef) ?? null;
    if (contextId) push("contextId", "contextId must exist and belong to the user");
    else push("contextRef", "contextId or valid contextRef is required");
    return null;
  }

  private async validateWord(
    payload: Record<string, unknown>,
    wordbookId: string | null,
    contextRepo: IL3ContextRepository,
    push: (field: string, message: string) => void,
  ): Promise<void> {
    const wordId = optionalString(payload, "wordId");
    const slug = optionalString(payload, "slug");
    if (!wordId && !slug) {
      push("wordId", "wordId or slug is required");
      return;
    }
    const word = wordbookId
      ? wordId
        ? await contextRepo.findWordInWordbookById(wordbookId, wordId)
        : await contextRepo.findWordInWordbookBySlug(wordbookId, slug ?? "")
      : wordId
        ? await contextRepo.findWordById(wordId)
        : await contextRepo.findWordBySlug(slug ?? "");
    if (!word) push("wordId", "wordId/slug does not exist or is outside the source wordbook");
  }

  private validateOffsets(
    payload: Record<string, unknown>,
    text: string | null,
    surface: string | null,
    push: (field: string, message: string) => void,
  ): void {
    const start = payload.startOffset;
    const end = payload.endOffset;
    if (start === undefined && end === undefined) return;
    if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 0 || Number(end) < Number(start)) {
      push("offset", "startOffset and endOffset must be valid integers provided together");
      return;
    }
    if (text && Number(end) > text.length) {
      push("offset", "offsets exceed context text length");
      return;
    }
    if (text && surface && text.slice(Number(start), Number(end)) !== surface) {
      push("surface", "surface does not match context text at offsets");
    }
  }

  private async validateLinkTarget(
    userId: string,
    payload: Record<string, unknown>,
    targetType: string,
    sourceWordbookId: string | null,
    contextRepo: IL3ContextRepository,
    push: (field: string, message: string) => void,
  ): Promise<void> {
    if (targetType === "word") {
      const targetId = requireUuidTargetId(optionalString(payload, "targetId"), "word", push);
      const word = targetId
        ? sourceWordbookId
          ? await contextRepo.findWordInWordbookById(sourceWordbookId, targetId)
          : await contextRepo.findWordById(targetId)
        : null;
      if (targetId && !word) push("targetId", "target word does not exist or is outside the context source wordbook");
    }
    if (targetType === "context") {
      const targetId = requireUuidTargetId(optionalString(payload, "targetId"), "context", push);
      if (targetId && !(await contextRepo.findContextById(userId, targetId))) {
        push("targetId", "target context does not exist or is outside user scope");
      }
    }
    if (targetType === "source") {
      const targetId = requireUuidTargetId(optionalString(payload, "targetId"), "source", push);
      if (targetId && !(await contextRepo.findSourceById(userId, targetId))) {
        push("targetId", "target source does not exist or is outside user scope");
      }
    }
    if (targetType === "l2_item" && !isL2SoftTargetRef(payload.targetRef)) {
      push("targetRef", "l2_item targetRef requires field plus one of contentId, hash, or sourceRef");
    }
  }
}
