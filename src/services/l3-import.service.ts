/**
 * L3ImportService - deterministic import-to-proposal builder.
 *
 * This service creates l3_import_jobs and pending l3_proposals only. It never
 * writes active L3 source/context/occurrence/link rows; active evidence still
 * enters through L3ProposalService.confirmProposal.
 */

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { NotFoundError, ValidationError } from "../errors";
import type { Json, L3ImportJobRow, L3ProposalItemRow, L3ProposalRow, WordRow } from "../domain";
import type { IL3ContextRepository, IRepositories } from "../repositories/interfaces";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import {
  L3_CONTEXT_LINK_TARGET_TYPES,
  L3_CONTEXT_LINK_TYPES,
  L3_CONTEXT_TYPES,
  L3_SOURCE_TYPES,
  type CreateL3ProposalItemInput,
  type CreateL3RawTextImportProposalInput,
  type CreateL3StructuredImportProposalInput,
  type L3StructuredImportContextInput,
} from "../schemas/service";
import { parseRawTextImport } from "../l3/import/parser";
import type { L3ProposalService } from "./l3-proposal.service";
import { L3_PROPOSAL_MAX_ITEMS } from "../schemas/resource-budget";

export interface L3ImportParseStats {
  contextCount: number;
  occurrenceCount: number;
  linkCount: number;
  skippedContextCount: number;
  warnings: string[];
}

export interface L3ImportProposalResult {
  importJob: L3ImportJobRow;
  proposal: L3ProposalRow;
  items: L3ProposalItemRow[];
  parseStats: L3ImportParseStats;
}

type TxRunner = <T>(callback: (tx: PoolClient) => Promise<T>) => Promise<T>;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

const MAX_RAW_TEXT_LENGTH = 500_000;

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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashInput(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

function mergeEvidence(base: Record<string, unknown>, extra: Json | undefined): Json {
  return {
    ...base,
    ...((extra && typeof extra === "object" && !Array.isArray(extra)) ? extra as Record<string, unknown> : {}),
  } as Json;
}

function jsonObject(value: Json | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class L3ImportService {
  constructor(
    private readonly l3Context: IL3ContextRepository,
    private readonly l3Proposal: L3ProposalService,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  async createRawTextImportProposal(input: CreateL3RawTextImportProposalInput): Promise<L3ImportProposalResult> {
    await this.validateEnvelope(input.userId, input.wordbookId ?? null, input.source);
    requireNonEmpty(input.text, "text");
    if (input.text.length > MAX_RAW_TEXT_LENGTH) {
      throw new ValidationError("text exceeds maximum import length", "text");
    }
    const targetWords = await this.resolveTargetWords(input.userId, input.wordbookId ?? null, input.targetWords ?? []);

    const parsed = parseRawTextImport(input.text, targetWords, input.options);
    const proposalItemCount = 1 + parsed.contexts.reduce(
      (total, context) => total + 1 + context.occurrences.length,
      0,
    );
    if (proposalItemCount > L3_PROPOSAL_MAX_ITEMS) {
      throw new ValidationError(
        `Raw import creates more than ${L3_PROPOSAL_MAX_ITEMS} proposal items`,
        "text",
      );
    }
    const parseStats: L3ImportParseStats = {
      contextCount: parsed.contexts.length,
      occurrenceCount: parsed.contexts.reduce((sum, context) => sum + context.occurrences.length, 0),
      linkCount: 0,
      skippedContextCount: parsed.skippedContextCount,
      warnings: parsed.warnings,
    };
    const inputHash = hashInput({
      kind: "raw_text",
      wordbookId: input.wordbookId ?? null,
      source: input.source,
      text: input.text,
      targetWords,
      options: input.options ?? {},
    });

    return this.executeImport(input, inputHash, parseStats, "raw_text_import",
      (importJobId) => this.buildRawTextProposalItems(input, importJobId, parsed.contexts));
  }

  async createStructuredImportProposal(input: CreateL3StructuredImportProposalInput): Promise<L3ImportProposalResult> {
    await this.validateEnvelope(input.userId, input.wordbookId ?? null, input.source);
    if (input.contexts.length === 0) {
      throw new ValidationError("contexts cannot be empty", "contexts");
    }
    for (const context of input.contexts) {
      requireEnum(context.contextType, L3_CONTEXT_TYPES, "contextType");
      requireNonEmpty(context.text, "text");
      for (const link of context.links ?? []) {
        requireEnum(link.linkType, L3_CONTEXT_LINK_TYPES, "linkType");
        requireEnum(link.targetType, L3_CONTEXT_LINK_TARGET_TYPES, "targetType");
        this.validateStructuredLinkTargetPolicy(link);
      }
    }
    const proposalItemCount = 1 + input.contexts.reduce(
      (total, context) => total + 1 + (context.occurrences?.length ?? 0) + (context.links?.length ?? 0),
      0,
    );
    if (proposalItemCount > L3_PROPOSAL_MAX_ITEMS) {
      throw new ValidationError(
        `Structured import creates more than ${L3_PROPOSAL_MAX_ITEMS} proposal items`,
        "contexts",
      );
    }

    const parseStats: L3ImportParseStats = {
      contextCount: input.contexts.length,
      occurrenceCount: input.contexts.reduce((sum, context) => sum + (context.occurrences?.length ?? 0), 0),
      linkCount: input.contexts.reduce((sum, context) => sum + (context.links?.length ?? 0), 0),
      skippedContextCount: 0,
      warnings: [],
    };
    const inputHash = hashInput({
      kind: "structured",
      wordbookId: input.wordbookId ?? null,
      source: input.source,
      contexts: input.contexts,
    });

    return this.executeImport(input, inputHash, parseStats, "structured_import",
      (importJobId) => this.buildStructuredProposalItems(input, importJobId));
  }

  /**
   * Shared import execution: dedup check → single transaction (import job +
   * proposal + items) → race-condition fallback. The import job is created
   * directly as "completed" — the "processing" intermediate state is
   * eliminated because the entire flow is atomic.
   */
  private async executeImport(
    input: { userId: string; wordbookId?: string | null; source: { title: string }; provenance?: Json },
    inputHash: string,
    parseStats: L3ImportParseStats,
    sourceTag: string,
    buildItems: (importJobId: string) => CreateL3ProposalItemInput[],
  ): Promise<L3ImportProposalResult> {
    // Idempotent re-submission: return existing result if input_hash matches.
    const existing = await this.findExistingImport(input.userId, inputHash);
    if (existing) return existing;

    const summary = parseStats.linkCount > 0
      ? `${parseStats.contextCount} contexts, ${parseStats.occurrenceCount} occurrences, ${parseStats.linkCount} links`
      : `${parseStats.contextCount} contexts, ${parseStats.occurrenceCount} occurrences`;

    try {
      return await this.txRunner(async (tx) => {
        const repos = this.repositoryFactory(tx);
        const importJob = await repos.l3Context.createImportJob({
          user_id: input.userId,
          status: "completed",
          input_hash: inputHash,
          input_summary: `${input.source.title}: ${parseStats.contextCount} contexts`,
          stats: parseStats as unknown as Json,
        });
        const items = buildItems(importJob.id);
        const bundle = await this.l3Proposal.createProposalInTx(tx, {
          userId: input.userId,
          wordbookId: input.wordbookId ?? null,
          sourceType: "import",
          title: `Import: ${input.source.title}`,
          summary,
          inputHash,
          proposedBy: "l3_import_builder",
          provenance: mergeEvidence({ importJobId: importJob.id, source: sourceTag }, input.provenance),
          items,
        });
        return { importJob, proposal: bundle.proposal, items: bundle.items, parseStats };
      });
    } catch (error) {
      // Race: another concurrent request inserted the same (user_id, input_hash).
      if (isUniqueViolation(error)) {
        const existing = await this.findExistingImport(input.userId, inputHash);
        if (existing) return existing;
      }
      throw error;
    }
  }

  /**
   * Find an existing completed import job + its proposal by input_hash.
   * Returns null if no match exists, or if the existing job is in a
   * non-completed state (the caller should retry or conflict).
   */
  private async findExistingImport(
    userId: string,
    inputHash: string,
  ): Promise<L3ImportProposalResult | null> {
    const importJob = await this.l3Context.findImportJobByInputHash(userId, inputHash);
    if (!importJob || importJob.status !== "completed") return null;
    const proposal = await this.l3Proposal.findProposalByInputHash(userId, inputHash);
    if (!proposal) return null;
    const bundle = await this.l3Proposal.getProposal({ userId, proposalId: proposal.id });
    return {
      importJob,
      proposal: bundle.proposal,
      items: bundle.items,
      parseStats: importJob.stats as unknown as L3ImportParseStats,
    };
  }

  private async validateEnvelope(
    userId: string,
    wordbookId: string | null,
    source: CreateL3RawTextImportProposalInput["source"],
  ): Promise<void> {
    requireNonEmpty(userId, "userId");
    requireEnum(source.sourceType, L3_SOURCE_TYPES, "sourceType");
    requireNonEmpty(source.title, "title");
    if (wordbookId && !(await this.l3Context.findWordbookByIdForUser(userId, wordbookId))) {
      throw new NotFoundError("Wordbook", wordbookId);
    }
  }

  private async resolveTargetWords(
    userId: string,
    wordbookId: string | null,
    targetWords: CreateL3RawTextImportProposalInput["targetWords"] = [],
  ): Promise<Array<{ wordId: string; slug: string }>> {
    const resolved: Array<{ wordId: string; slug: string }> = [];
    const seen = new Set<string>();
    for (const targetWord of targetWords) {
      if (!targetWord.wordId && !targetWord.slug) {
        throw new ValidationError("targetWords require wordId or slug", "targetWords");
      }
      const word = await this.findTargetWord(userId, wordbookId, targetWord.wordId ?? null, targetWord.slug ?? null);
      if (!word) {
        throw new NotFoundError("Word", targetWord.wordId ?? targetWord.slug ?? "");
      }
      const key = word.id ? `wordId:${word.id}` : `slug:${word.slug.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push({ wordId: word.id, slug: word.slug });
    }
    return resolved;
  }

  private validateStructuredLinkTargetPolicy(link: { targetType: string; targetId?: string | null; targetRef?: Json }): void {
    if (link.targetType !== "context" && link.targetType !== "source") return;
    const targetRef = jsonObject(link.targetRef);
    const hasProposalTargetRef =
      (typeof targetRef.contextRef === "string" && targetRef.contextRef.trim().length > 0) ||
      (typeof targetRef.sourceRef === "string" && targetRef.sourceRef.trim().length > 0);
    if (hasProposalTargetRef) {
      throw new ValidationError(
        "Structured import context/source link targets do not support proposal refs; confirm first and use active targetId",
        "targetRef",
      );
    }
    if (!link.targetId) {
      throw new ValidationError(
        "Structured import context/source link targets require active targetId",
        "targetId",
      );
    }
  }

  private async findTargetWord(
    _userId: string,
    wordbookId: string | null,
    wordId: string | null,
    slug: string | null,
  ): Promise<WordRow | null> {
    if (wordbookId) {
      return wordId
        ? this.l3Context.findWordInWordbookById(wordbookId, wordId)
        : this.l3Context.findWordInWordbookBySlug(wordbookId, slug ?? "");
    }
    return wordId
      ? this.l3Context.findWordById(wordId)
      : this.l3Context.findWordBySlug(slug ?? "");
  }

  private sourcePayload(input: CreateL3RawTextImportProposalInput | CreateL3StructuredImportProposalInput): Json {
    return {
      clientRef: "source-1",
      wordbookId: input.wordbookId ?? null,
      sourceType: input.source.sourceType,
      title: input.source.title,
      author: input.source.author ?? null,
      url: input.source.url ?? null,
      language: input.source.language ?? null,
      metadata: input.source.metadata ?? {},
    } as Json;
  }

  private buildRawTextProposalItems(
    input: CreateL3RawTextImportProposalInput,
    importJobId: string,
    contexts: Array<{ text: string; startOffset: number; endOffset: number; occurrences: Array<{
      wordId?: string;
      slug?: string;
      surface: string;
      startOffset: number;
      endOffset: number;
      confidence: number;
    }> }>,
  ): Array<{
    itemType: "source" | "context" | "occurrence";
    clientRef?: string | null;
    payload: Json;
  }> {
    const items: Array<{ itemType: "source" | "context" | "occurrence"; clientRef?: string | null; payload: Json }> = [
      { itemType: "source", clientRef: "source-1", payload: this.sourcePayload(input) },
    ];
    for (const [index, context] of contexts.entries()) {
      const contextRef = `context-${index + 1}`;
      items.push({
        itemType: "context",
        clientRef: contextRef,
        payload: {
          clientRef: contextRef,
          sourceRef: "source-1",
          contextType: input.options?.contextType ?? "sentence",
          text: context.text,
          language: input.source.language ?? null,
          position: { start: context.startOffset, end: context.endOffset },
          metadata: { importJobId, source: "raw_text_import" },
        } as Json,
      });
      for (const occurrence of context.occurrences) {
        items.push({
          itemType: "occurrence",
          payload: {
            contextRef,
            ...(occurrence.wordId ? { wordId: occurrence.wordId } : {}),
            ...(occurrence.slug ? { slug: occurrence.slug } : {}),
            surface: occurrence.surface,
            startOffset: occurrence.startOffset,
            endOffset: occurrence.endOffset,
            confidence: occurrence.confidence,
            evidence: {
              importJobId,
              method: "deterministic_text_match",
              source: "raw_text_import",
            },
          } as Json,
        });
      }
    }
    return items;
  }

  private buildStructuredProposalItems(
    input: CreateL3StructuredImportProposalInput,
    importJobId: string,
  ): Array<{ itemType: "source" | "context" | "occurrence" | "context_link"; clientRef?: string | null; payload: Json }> {
    const items: Array<{ itemType: "source" | "context" | "occurrence" | "context_link"; clientRef?: string | null; payload: Json }> = [
      { itemType: "source", clientRef: "source-1", payload: this.sourcePayload(input) },
    ];
    for (const [index, context] of input.contexts.entries()) {
      const contextRef = this.contextRef(context, index);
      items.push({
        itemType: "context",
        clientRef: contextRef,
        payload: {
          clientRef: contextRef,
          sourceRef: "source-1",
          contextType: context.contextType,
          text: context.text,
          normalizedText: context.normalizedText ?? null,
          language: context.language ?? input.source.language ?? null,
          position: context.position ?? {},
          metadata: mergeEvidence({ importJobId, source: "structured_import" }, context.metadata),
        } as Json,
      });
      for (const occurrence of context.occurrences ?? []) {
        items.push({
          itemType: "occurrence",
          payload: {
            contextRef,
            ...(occurrence.wordId ? { wordId: occurrence.wordId } : {}),
            ...(occurrence.slug ? { slug: occurrence.slug } : {}),
            surface: occurrence.surface,
            lemma: occurrence.lemma ?? null,
            startOffset: occurrence.startOffset ?? null,
            endOffset: occurrence.endOffset ?? null,
            confidence: occurrence.confidence ?? null,
            evidence: mergeEvidence({ importJobId, source: "structured_import" }, occurrence.evidence),
          } as Json,
        });
      }
      for (const link of context.links ?? []) {
        items.push({
          itemType: "context_link",
          payload: {
            contextRef,
            wordId: link.wordId ?? null,
            linkType: link.linkType,
            targetType: link.targetType,
            targetId: link.targetId ?? null,
            targetRef: link.targetRef ?? {},
            confidence: link.confidence ?? null,
            provenance: mergeEvidence({ importJobId, source: "structured_import" }, link.provenance),
          } as Json,
        });
      }
    }
    return items;
  }

  private contextRef(context: L3StructuredImportContextInput, index: number): string {
    return context.clientRef?.trim() || `context-${index + 1}`;
  }
}
