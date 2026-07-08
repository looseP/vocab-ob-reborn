/**
 * L3ImportService - deterministic import-to-proposal builder.
 *
 * This service creates l3_import_jobs and pending l3_proposals only. It never
 * writes active L3 source/context/occurrence/link rows; active evidence still
 * enters through L3ProposalService.confirmProposal.
 */

import { createHash } from "node:crypto";
import { NotFoundError, ValidationError } from "../errors";
import type { Json, L3ImportJobRow, L3ProposalItemRow, L3ProposalRow, WordRow } from "../domain";
import type { IL3ContextRepository } from "../repositories/interfaces";
import {
  L3_CONTEXT_LINK_TARGET_TYPES,
  L3_CONTEXT_LINK_TYPES,
  L3_CONTEXT_TYPES,
  L3_SOURCE_TYPES,
  type CreateL3RawTextImportProposalInput,
  type CreateL3StructuredImportProposalInput,
  type L3StructuredImportContextInput,
} from "../schemas/service";
import { parseRawTextImport } from "../l3/import/parser";
import type { L3ProposalService } from "./l3-proposal.service";

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
  ) {}

  async createRawTextImportProposal(input: CreateL3RawTextImportProposalInput): Promise<L3ImportProposalResult> {
    await this.validateEnvelope(input.userId, input.wordbookId ?? null, input.source);
    requireNonEmpty(input.text, "text");
    if (input.text.length > MAX_RAW_TEXT_LENGTH) {
      throw new ValidationError("text exceeds maximum import length", "text");
    }
    const targetWords = await this.resolveTargetWords(input.userId, input.wordbookId ?? null, input.targetWords ?? []);

    const parsed = parseRawTextImport(input.text, targetWords, input.options);
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

    const importJob = await this.l3Context.createImportJob({
      user_id: input.userId,
      status: "processing",
      input_hash: inputHash,
      input_summary: `${input.source.title}: ${parseStats.contextCount} parsed contexts`,
      stats: parseStats as unknown as Json,
    });

    try {
      const items = this.buildRawTextProposalItems(input, importJob.id, parsed.contexts);
      const bundle = await this.l3Proposal.createProposal({
        userId: input.userId,
        wordbookId: input.wordbookId ?? null,
        sourceType: "import",
        title: `Import: ${input.source.title}`,
        summary: `${parseStats.contextCount} contexts, ${parseStats.occurrenceCount} occurrences`,
        inputHash,
        proposedBy: "l3_import_builder",
        provenance: mergeEvidence({ importJobId: importJob.id, source: "raw_text_import" }, input.provenance),
        items,
      });
      const completedImportJob = await this.l3Context.updateImportJobStatus(
        importJob.id,
        input.userId,
        "completed",
        parseStats as unknown as Json,
        null,
      );
      return { importJob: completedImportJob, proposal: bundle.proposal, items: bundle.items, parseStats };
    } catch (error) {
      await this.l3Context.updateImportJobStatus(
        importJob.id,
        input.userId,
        "failed",
        parseStats as unknown as Json,
        error instanceof Error ? error.message : "Unknown import proposal failure",
      );
      throw error;
    }
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
    const importJob = await this.l3Context.createImportJob({
      user_id: input.userId,
      status: "processing",
      input_hash: inputHash,
      input_summary: `${input.source.title}: ${parseStats.contextCount} structured contexts`,
      stats: parseStats as unknown as Json,
    });

    try {
      const items = this.buildStructuredProposalItems(input, importJob.id);
      const bundle = await this.l3Proposal.createProposal({
        userId: input.userId,
        wordbookId: input.wordbookId ?? null,
        sourceType: "import",
        title: `Import: ${input.source.title}`,
        summary: `${parseStats.contextCount} contexts, ${parseStats.occurrenceCount} occurrences, ${parseStats.linkCount} links`,
        inputHash,
        proposedBy: "l3_import_builder",
        provenance: mergeEvidence({ importJobId: importJob.id, source: "structured_import" }, input.provenance),
        items,
      });
      const completedImportJob = await this.l3Context.updateImportJobStatus(
        importJob.id,
        input.userId,
        "completed",
        parseStats as unknown as Json,
        null,
      );
      return { importJob: completedImportJob, proposal: bundle.proposal, items: bundle.items, parseStats };
    } catch (error) {
      await this.l3Context.updateImportJobStatus(
        importJob.id,
        input.userId,
        "failed",
        parseStats as unknown as Json,
        error instanceof Error ? error.message : "Unknown import proposal failure",
      );
      throw error;
    }
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
