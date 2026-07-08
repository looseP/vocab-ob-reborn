/**
 * L3RecommendationService - deterministic recommendation proposal builder.
 *
 * Phase 3E generates auditable recommendation candidates. It may write
 * recommendation runs/items and, when accepting link_gap, proposal rows/items.
 * It never writes active L3 rows, L1/L2 progress, words JSONB, or L2 content.
 */

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type {
  IL3ContextRepository,
  IL3RecommendationRepository,
  IRepositories,
  L3RecommendationLinkGapCandidate,
  L3RecommendationSignal,
} from "../repositories/interfaces";
import type {
  Json,
  L3PaginatedList,
  L3RecommendationAcceptResult,
  L3RecommendationBundle,
  L3RecommendationEvidence,
  L3RecommendationItemRow,
  L3RecommendationRunRow,
} from "../domain";
import {
  L3_RECOMMENDATION_RUN_MODES,
  L3_RECOMMENDATION_STATUSES,
  L3_RECOMMENDATION_TYPES,
  type GenerateL3RecommendationsInput,
  type L3RecommendationIdInput,
  type ListL3RecommendationsInput,
  type RejectL3RecommendationInput,
} from "../schemas/service";
import { L3ProposalService } from "./l3-proposal.service";

type TxRunner = <T>(callback: (tx: PoolClient) => Promise<T>) => Promise<T>;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_HORIZON_DAYS = 7;
const MAX_HORIZON_DAYS = 90;
const REQUIRED_L2_FIELDS = ["collocation", "corpus", "synonym", "antonym"] as const;

interface Candidate {
  recommendationType: (typeof L3_RECOMMENDATION_TYPES)[number];
  title: string;
  summary: string;
  priorityScore: number;
  confidence: number;
  reasonCodes: string[];
  evidence: L3RecommendationEvidence[];
  payload: Json;
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

function normalizeLimit(limit: number | null | undefined): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`limit must be between 1 and ${MAX_LIMIT}`, "limit");
  }
  return limit;
}

function normalizeHorizonDays(horizonDays: number | null | undefined): number {
  if (horizonDays === undefined || horizonDays === null) return DEFAULT_HORIZON_DAYS;
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > MAX_HORIZON_DAYS) {
    throw new ValidationError(`horizonDays must be between 1 and ${MAX_HORIZON_DAYS}`, "horizonDays");
  }
  return horizonDays;
}

function stableHash(value: Json): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
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

function asNumber(value: number | string | null | undefined, fallback = 0): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function compactCandidates(items: Candidate[], limit: number): Candidate[] {
  const seen = new Set<string>();
  return items
    .sort((a, b) => b.priorityScore - a.priorityScore || b.confidence - a.confidence || a.title.localeCompare(b.title))
    .filter((item) => {
      const key = stableHash({ type: item.recommendationType, payload: item.payload });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function missingL2Fields(signal: L3RecommendationSignal): string[] {
  const fields = new Set(signal.l2_fields ?? []);
  return REQUIRED_L2_FIELDS.filter((field) => !fields.has(field));
}

function signalEvidence(signal: L3RecommendationSignal): L3RecommendationEvidence[] {
  const evidence: L3RecommendationEvidence[] = [];
  if (signal.due_at) evidence.push({ type: "fsrs_due", ref: { wordId: signal.word_id, dueAt: signal.due_at } });
  if (signal.l1_weak_signal) evidence.push({ type: "fsrs_weak", ref: { wordId: signal.word_id } });
  const occurrenceCount = asNumber(signal.l3_occurrence_count);
  if (occurrenceCount > 0) evidence.push({ type: "occurrence_count", ref: { wordId: signal.word_id, occurrenceCount } });
  if (asNumber(signal.l3_context_count) === 0) evidence.push({ type: "l3_context_missing", ref: { wordId: signal.word_id } });
  return evidence;
}

export class L3RecommendationService {
  constructor(
    private readonly recommendations: IL3RecommendationRepository,
    private readonly l3Context: IL3ContextRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  async generateRecommendations(input: GenerateL3RecommendationsInput): Promise<L3RecommendationBundle> {
    requireNonEmpty(input.userId, "userId");
    requireEnum(input.mode, L3_RECOMMENDATION_RUN_MODES, "mode");
    const limit = normalizeLimit(input.limit);
    const horizonDays = normalizeHorizonDays(input.horizonDays);
    if (input.wordbookId) {
      const wordbook = await this.l3Context.findWordbookByIdForUser(input.userId, input.wordbookId);
      if (!wordbook) throw new NotFoundError("Wordbook", input.wordbookId);
    }
    if (input.seedSlug) {
      const word = input.wordbookId
        ? await this.l3Context.findWordInWordbookBySlug(input.wordbookId, input.seedSlug)
        : await this.l3Context.findWordBySlug(input.seedSlug);
      if (!word) throw new NotFoundError("Word", input.seedSlug);
    }

    const signals = await this.recommendations.findSignals({
      userId: input.userId,
      wordbookId: input.wordbookId ?? null,
      seedSlug: input.seedSlug ?? null,
      horizonDays,
      limit,
    });
    const linkGaps = input.mode === "link_suggestions" || input.mode === "gap_scan"
      ? await this.recommendations.findLinkGapCandidates({
        userId: input.userId,
        wordbookId: input.wordbookId ?? null,
        seedSlug: input.seedSlug ?? null,
        horizonDays,
        limit,
      })
      : [];
    const candidates = compactCandidates(this.buildCandidates(input.mode, signals, linkGaps), limit);
    const stats = {
      signalCount: signals.length,
      linkGapCandidateCount: linkGaps.length,
      itemCount: candidates.length,
      dryRun: Boolean(input.dryRun),
    } as Json;

    if (input.dryRun) {
      return {
        run: {
          id: "dry-run",
          user_id: input.userId,
          wordbook_id: input.wordbookId ?? null,
          mode: input.mode,
          status: "completed",
          input_hash: this.inputHash(input, candidates),
          stats,
          created_at: new Date(0).toISOString(),
          completed_at: new Date(0).toISOString(),
        },
        items: candidates.map((candidate, index) => this.toDryRunItem(input, candidate, index)),
        stats,
      };
    }

    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const run = await repos.l3Recommendation.createRun({
        user_id: input.userId,
        wordbook_id: input.wordbookId ?? null,
        mode: input.mode,
        input_hash: this.inputHash(input, candidates),
        stats,
      });
      const items: L3RecommendationItemRow[] = [];
      for (const candidate of candidates) {
        items.push(await repos.l3Recommendation.createItem({
          run_id: run.id,
          user_id: input.userId,
          wordbook_id: input.wordbookId ?? null,
          recommendation_type: candidate.recommendationType,
          title: candidate.title,
          summary: candidate.summary,
          priority_score: candidate.priorityScore,
          confidence: candidate.confidence,
          reason_codes: candidate.reasonCodes as unknown as Json,
          evidence: candidate.evidence as unknown as Json,
          payload: candidate.payload,
        }));
      }
      return { run, items, stats };
    });
  }

  async listRecommendations(input: ListL3RecommendationsInput): Promise<L3PaginatedList<L3RecommendationItemRow>> {
    requireNonEmpty(input.userId, "userId");
    if (input.status) requireEnum(input.status, L3_RECOMMENDATION_STATUSES, "status");
    if (input.recommendationType) requireEnum(input.recommendationType, L3_RECOMMENDATION_TYPES, "recommendationType");
    return this.recommendations.listItems({ ...input, limit: normalizeLimit(input.limit) });
  }

  async getRecommendation(input: L3RecommendationIdInput): Promise<L3RecommendationItemRow> {
    requireNonEmpty(input.userId, "userId");
    const item = await this.recommendations.findItemByIdForUser(input.userId, input.recommendationId);
    if (!item) throw new NotFoundError("L3Recommendation", input.recommendationId);
    return item;
  }

  async rejectRecommendation(input: RejectL3RecommendationInput): Promise<L3RecommendationItemRow> {
    requireNonEmpty(input.userId, "userId");
    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const item = await repos.l3Recommendation.lockItemByIdForUser(input.userId, input.recommendationId);
      if (!item) throw new NotFoundError("L3Recommendation", input.recommendationId);
      if (item.status !== "pending") throw new ConflictError(`Cannot reject ${item.status} recommendation`);
      return repos.l3Recommendation.markItemStatus(item.id, input.userId, "rejected");
    });
  }

  async acceptRecommendation(input: L3RecommendationIdInput): Promise<L3RecommendationAcceptResult> {
    requireNonEmpty(input.userId, "userId");
    return this.txRunner(async (tx) => {
      const repos = this.repositoryFactory(tx);
      const item = await repos.l3Recommendation.lockItemByIdForUser(input.userId, input.recommendationId);
      if (!item) throw new NotFoundError("L3Recommendation", input.recommendationId);
      if (item.status !== "pending") throw new ConflictError(`Cannot accept ${item.status} recommendation`);

      if (item.recommendation_type === "link_gap") {
        const proposalService = new L3ProposalService(repos.l3Proposal, repos.l3Context, async (cb) => cb(tx), () => repos);
        const payload = item.payload as Record<string, unknown>;
        const proposal = await proposalService.createProposal({
          userId: input.userId,
          wordbookId: item.wordbook_id,
          sourceType: "agent",
          title: `Recommendation: ${item.title}`,
          summary: item.summary,
          proposedBy: "l3_recommendation_builder",
          provenance: {
            recommendationId: item.id,
            recommendationType: item.recommendation_type,
            reasonCodes: item.reason_codes,
          },
          items: [{
            itemType: "context_link",
            payload: {
              contextId: typeof payload.contextId === "string" ? payload.contextId : null,
              wordId: typeof payload.wordId === "string" ? payload.wordId : null,
              linkType: typeof payload.linkType === "string" ? payload.linkType : "collocates_with",
              targetType: "word",
              targetId: typeof payload.targetWordId === "string" ? payload.targetWordId : null,
              targetRef: {
                source: "l3_recommendation",
                targetSlug: typeof payload.targetSlug === "string" ? payload.targetSlug : null,
              },
              confidence: asNumber(item.confidence, 0.5),
              provenance: {
                recommendationId: item.id,
                evidence: item.evidence,
              },
            } as Json,
          }],
        });
        const accepted = await repos.l3Recommendation.markItemStatus(item.id, input.userId, "accepted", proposal.proposal.id);
        return { item: accepted, proposal };
      }

      const accepted = await repos.l3Recommendation.markItemStatus(item.id, input.userId, "accepted");
      return {
        item: accepted,
        actionPayload: {
          recommendationId: item.id,
          recommendationType: item.recommendation_type,
          action: "future_consumer",
          payload: item.payload,
        },
      };
    });
  }

  private buildCandidates(
    mode: GenerateL3RecommendationsInput["mode"],
    signals: L3RecommendationSignal[],
    linkGaps: L3RecommendationLinkGapCandidate[],
  ): Candidate[] {
    if (mode === "review_pack") return this.buildReviewPack(signals);
    if (mode === "learn_next") return this.buildLearnNext(signals);
    if (mode === "link_suggestions") return this.buildLinkGaps(linkGaps);
    return [
      ...this.buildLinkGaps(linkGaps),
      ...this.buildContextGaps(signals),
      ...this.buildL2Gaps(signals),
      ...this.buildWeakWords(signals),
    ];
  }

  private buildReviewPack(signals: L3RecommendationSignal[]): Candidate[] {
    const selected = signals.filter((signal) => signal.due_at || signal.l1_weak_signal).slice(0, 10);
    if (selected.length === 0) return [];
    return [{
      recommendationType: "review_pack",
      title: `Review pack: ${selected.map((signal) => signal.slug).join(", ")}`,
      summary: "Due or weak words grouped for quick review with L3 evidence.",
      priorityScore: selected.reduce((score, signal) => score + (signal.l1_weak_signal ? 20 : 10), 50),
      confidence: 0.8,
      reasonCodes: ["fsrs_due", "fsrs_weak", "graph_grouped"],
      evidence: selected.flatMap(signalEvidence),
      payload: {
        suggestedMode: "quick_review",
        words: selected.map((signal) => ({ wordId: signal.word_id, slug: signal.slug })),
      },
    }];
  }

  private buildLearnNext(signals: L3RecommendationSignal[]): Candidate[] {
    return signals
      .filter((signal) => !signal.state || asNumber(signal.graph_neighbor_count) > 0)
      .map((signal) => ({
        recommendationType: "learn_next",
        title: `Learn next: ${signal.slug}`,
        summary: "Wordbook or graph neighbor with insufficient review coverage.",
        priorityScore: 40 + asNumber(signal.graph_neighbor_count) * 5 - asNumber(signal.review_count),
        confidence: asNumber(signal.graph_neighbor_count) > 0 ? 0.75 : 0.55,
        reasonCodes: ["wordbook_neighbor", "graph_neighbor"],
        evidence: [
          ...signalEvidence(signal),
          ...(asNumber(signal.graph_neighbor_count) > 0
            ? [{ type: "graph_edge", ref: { wordId: signal.word_id, neighborCount: asNumber(signal.graph_neighbor_count) } } as L3RecommendationEvidence]
            : []),
          { type: "wordbook_neighbor", ref: { wordId: signal.word_id, slug: signal.slug } } as L3RecommendationEvidence,
        ],
        payload: { wordId: signal.word_id, slug: signal.slug, suggestedMode: "learn_next" },
      }));
  }

  private buildLinkGaps(linkGaps: L3RecommendationLinkGapCandidate[]): Candidate[] {
    return linkGaps.map((gap) => ({
      recommendationType: "link_gap",
      title: `Link gap: ${gap.word_slug} -> ${gap.target_word_slug}`,
      summary: "Words co-occur in an L3 context but have no active context_link.",
      priorityScore: 60 + asNumber(gap.cooccurrence_count) * 10,
      confidence: 0.7,
      reasonCodes: ["cooccurrence_without_link", "proposal_bridge_available"],
      evidence: [{
        type: "graph_edge",
        ref: {
          contextId: gap.context_id,
          sourceId: gap.source_id,
          cooccurrenceCount: asNumber(gap.cooccurrence_count),
        },
      }],
      payload: {
        contextId: gap.context_id,
        wordId: gap.word_id,
        wordSlug: gap.word_slug,
        targetWordId: gap.target_word_id,
        targetSlug: gap.target_word_slug,
        linkType: "collocates_with",
      },
    }));
  }

  private buildContextGaps(signals: L3RecommendationSignal[]): Candidate[] {
    return signals.filter((signal) => asNumber(signal.l3_context_count) === 0).map((signal) => ({
      recommendationType: "context_gap",
      title: `Context gap: ${signal.slug}`,
      summary: "Word has learning signal but no owner-scoped L3 context.",
      priorityScore: 50 + (signal.l1_weak_signal ? 10 : 0),
      confidence: 0.75,
      reasonCodes: ["l3_context_missing"],
      evidence: signalEvidence(signal),
      payload: {
        wordId: signal.word_id,
        slug: signal.slug,
        suggestedAction: "import_or_search_context",
      },
    }));
  }

  private buildL2Gaps(signals: L3RecommendationSignal[]): Candidate[] {
    return signals.flatMap((signal) => {
      const missing = missingL2Fields(signal);
      if (missing.length === 0) return [];
      return [{
        recommendationType: "l2_gap",
        title: `L2 gap: ${signal.slug}`,
        summary: `Missing L2 fields: ${missing.join(", ")}`,
        priorityScore: 45 + missing.length * 5,
        confidence: 0.65,
        reasonCodes: ["l2_missing_field"],
        evidence: missing.map((field) => ({ type: "l2_missing_field", ref: { wordId: signal.word_id, field } })),
        payload: {
          wordId: signal.word_id,
          slug: signal.slug,
          missingFields: missing,
          suggestedAction: "composer_draft",
        },
      }];
    });
  }

  private buildWeakWords(signals: L3RecommendationSignal[]): Candidate[] {
    return signals.filter((signal) => signal.l1_weak_signal).map((signal) => ({
      recommendationType: "weak_word",
      title: `Weak word: ${signal.slug}`,
      summary: "L1/L2 weak signal suggests focused review or context enrichment.",
      priorityScore: 80,
      confidence: 0.8,
      reasonCodes: ["fsrs_weak"],
      evidence: signalEvidence(signal),
      payload: { wordId: signal.word_id, slug: signal.slug, suggestedAction: "focused_review" },
    }));
  }

  private toDryRunItem(
    input: GenerateL3RecommendationsInput,
    candidate: Candidate,
    index: number,
  ): L3RecommendationItemRow {
    return {
      id: `dry-run-item-${index + 1}`,
      run_id: "dry-run",
      user_id: input.userId,
      wordbook_id: input.wordbookId ?? null,
      recommendation_type: candidate.recommendationType,
      status: "pending",
      title: candidate.title,
      summary: candidate.summary,
      priority_score: candidate.priorityScore,
      confidence: candidate.confidence,
      reason_codes: candidate.reasonCodes as unknown as Json,
      evidence: candidate.evidence as unknown as Json,
      payload: candidate.payload,
      accepted_proposal_id: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      expires_at: null,
      accepted_at: null,
      rejected_at: null,
      dismissed_at: null,
    };
  }

  private inputHash(input: GenerateL3RecommendationsInput, candidates: Candidate[]): string {
    return stableHash({
      userId: input.userId,
      wordbookId: input.wordbookId ?? null,
      mode: input.mode,
      seedSlug: input.seedSlug ?? null,
      limit: input.limit ?? null,
      horizonDays: input.horizonDays ?? null,
      candidates: candidates.map((candidate) => ({ type: candidate.recommendationType, payload: candidate.payload })),
    });
  }
}
