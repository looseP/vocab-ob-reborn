/**
 * Service factory — creates all services with their dependencies.
 *
 * M6 fix: fsrsAdapter is required (not optional), enforced at compile time.
 * H1 fix: RepositoryFactory deleted — services create their own repos inside tx.
 *
 * Usage:
 *   const services = createServices({ fsrsAdapter, loadWeights });
 *   const words = await services.words.getPublicWords({...});
 *   await services.reviews.submitAnswer(input, userId);  // creates tx internally
 */

import { WordService } from "./word.service";
import { ReviewService, type FsrsAdapterFn, type FsrsScheduling } from "./review.service";
import { CaptureService } from "./capture.service";
import { VocabImportService } from "./vocab-import.service";
import { NoteService } from "./note.service";
import { WordbookService } from "./wordbook.service";
import { StatsService } from "./stats.service";
import { L2TransitionService } from "./l2-transition.service";
import { L2ContentService } from "./l2-content.service";
import { L3ContextService } from "./l3-context.service";
import { L3ProposalService } from "./l3-proposal.service";
import { L3ImportService } from "./l3-import.service";
import { L3ReadService } from "./l3-read.service";
import { L3RecommendationService } from "./l3-recommendation.service";
import { CrossTrackService } from "./cross-track.service";
import { L2DrillService } from "./l2-drill.service";
import { L3ContextSourceAdapter } from "./l3-context-source-adapter";
import { AuthSessionService } from "./auth-session.service";
import { LoginRateLimitService } from "./login-rate-limit.service";
import { RuntimeStatusService } from "./runtime-status.service";
import { telemetry } from "../observability/telemetry";
import type { LlmProvider } from "../llm/provider";
import type { UsageTracker } from "../llm/usage-tracker";
import type { DictionaryProvider } from "../dictionary/provider";
import type { ContextSource } from "../domain/context-source";
import { createRepositories } from "../repositories/factory";
import { withTransaction } from "../db/transaction";
import { AuthSessionRepository } from "../repositories/auth-session.repository";
import {
  LoginRateLimitRepository,
  type LoginRateLimitRepositoryPort,
} from "../repositories/login-rate-limit.repository";
import type { RuntimeDatabaseStatus } from "./runtime-status.service";

export type { FsrsAdapterFn, FsrsScheduling };

export interface ServiceDeps {
  /** FSRS scheduling adapter — M6 fix: required */
  fsrsAdapter: FsrsAdapterFn;
  /** Database probe injected by the composition root for readiness. */
  checkDatabase?: () => Promise<RuntimeDatabaseStatus>;
  /** Fail-closed readiness deadline. */
  readinessTimeoutMs?: number;
  /** Login limiter storage and bounded policy, injectable for tests. */
  loginRateLimitRepository?: LoginRateLimitRepositoryPort;
  loginRateLimitWindowMs?: number;
  loginRateLimitAttempts?: number;
  /** Load wordbook FSRS weights */
  loadWeights?: (wordbookId: string) => Promise<number[] | null>;
  /** Load wordbook L2-track weights（缺省回退 loadWeights，双轨 spec §十） */
  loadL2Weights?: (wordbookId: string) => Promise<number[] | null>;
  /** LLM provider — optional; required to enable the L2 draft/confirm flow. */
  llmProvider?: LlmProvider;
  /** LLM usage tracker — paired with llmProvider for budget enforcement. */
  usageTracker?: UsageTracker;
  /**
   * Dictionary provider — optional; grounds the collocation draft flow (B3).
   * When absent, collocation drafts return `NO_DICTIONARY_CANDIDATES`. The
   * server assembles a Datamuse provider when a dictionary source is enabled.
   */
  dictionaryProvider?: DictionaryProvider;
  /**
   * Context source — optional; FR-12 接线2. When absent, L2DrillService
   * defaults to L3ContextSourceAdapter (reads L3 contexts for the word).
   * Inject noopContextSource or a mock to disable L3 context consumption.
   */
  contextSource?: ContextSource;
}

export function createServices(deps: ServiceDeps) {
  const repos = createRepositories();

  const loadWeights = deps.loadWeights ?? (async () => null);

  // L2TransitionService and CrossTrackService are consumed by the outbox
  // worker. ReviewService only persists the authoritative answer and event.
  const l2Transition = new L2TransitionService(repos.l2Progress);

  // CrossTrackService (Phase 2C) owns the L1↔L2 cascade rules: L1 collapsing
  // pauses L2, L1 recovering resumes the cascade pause, L2 sustained failure
  // marks L1 weak-signal. Both l2Transition and crossTrack are consumed by the
  // ReviewOutboxWorker (which constructs its own instances from a tx-scoped
  // repository set). They are also exposed on the returned services for the
  // forthcoming L2ReviewService to call checkL2FailureCascade.
  const crossTrack = new CrossTrackService(repos.l2Progress, repos.reviews);

  // L2ContentService is always constructed so the confirm flow (a pure DB
  // cascade with no LLM dependency) works even without a provider. The draft
  // flow degrades gracefully: generateDraft returns L2_CONTENT_UNAVAILABLE
  // for fields that need the LLM when no provider/tracker is injected, and
  // collocation drafts return NO_DICTIONARY_CANDIDATES when no dictionary
  // provider is injected (B3).
  const l2content = new L2ContentService({
    llmProvider: deps.llmProvider,
    usageTracker: deps.usageTracker,
    dictionaryProvider: deps.dictionaryProvider,
  });

  const l3Context = new L3ContextService(repos.l3Context);
  const l3Proposal = new L3ProposalService(repos.l3Proposal, repos.l3Context);
  const l3Read = new L3ReadService(repos.l3Context);
  const l3Recommendation = new L3RecommendationService(repos.l3Recommendation, repos.l3Context);

  return {
    runtimeStatus: new RuntimeStatusService(
      deps.checkDatabase ?? (async () => ({ ok: false, totalCount: 0, idleCount: 0, waitingCount: 0 })),
      repos.outbox,
      repos.llmUsage,
      deps.readinessTimeoutMs,
    ),
    authSessions: new AuthSessionService(new AuthSessionRepository()),
    loginRateLimit: new LoginRateLimitService(
      deps.loginRateLimitRepository ?? new LoginRateLimitRepository(),
      {
        windowMs: deps.loginRateLimitWindowMs,
        attemptLimit: deps.loginRateLimitAttempts,
      },
    ),
    words: new WordService(repos.words),
    capture: new CaptureService(repos.words),
    vocabImport: new VocabImportService(repos.words),
    // ReviewService 的读路径依赖：owner-scoped 表全部启用 RLS，池直连（无
    // request.jwt.claim.sub）会静默返回空数据 —— 每个依赖必须携带 actorId
    // 的事务执行。sessions.getOrCreateToday 已在仓库内部自带事务，直接透传。
    reviews: new ReviewService({
      fsrsAdapter: deps.fsrsAdapter,
      loadWeights,
      findDueCards: (userId, wordbookId, limit) =>
        withTransaction(
          (tx) => createRepositories(tx).reviews.findDueCards(userId, wordbookId, limit),
          { actorId: userId },
        ),
      getOrCreateTodaySession: (userId, wordbookId, mode) => repos.sessions.getOrCreateToday(userId, wordbookId, mode),
      getReviewStats: (userId, wordbookId) =>
        withTransaction(
          (tx) => createRepositories(tx).reviews.getStats!(userId, wordbookId),
          { actorId: userId },
        ),
      findLeeches: (userId, wordbookId, limit) =>
        withTransaction(
          (tx) => createRepositories(tx).reviews.findLeeches!(userId, wordbookId, limit),
          { actorId: userId },
        ),
      getTimeline: (userId, wordbookId, limit) =>
        withTransaction(
          (tx) => createRepositories(tx).reviews.getTimeline!(userId, wordbookId, limit),
          { actorId: userId },
        ),
      getHeatmap: (userId, wordbookId, days) =>
        withTransaction(
          (tx) => createRepositories(tx).reviews.getHeatmap!(userId, wordbookId, days),
          { actorId: userId },
        ),
      clearL1WeakSignal: (userId, wordbookId, wordId) =>
        withTransaction(
          (tx) => createRepositories(tx).reviews.markL1WeakSignal(userId, wordbookId, wordId, false),
          { actorId: userId },
        ),
    }),
    notes: new NoteService(repos.notes, repos.wordbooks),
    wordbooks: new WordbookService(repos.wordbooks),
    stats: new StatsService(repos.stats),
    l2Transition,
    crossTrack,
    l2Drill: new L2DrillService({
      fsrsAdapter: deps.fsrsAdapter,
      loadWeights,
      loadL2Weights: deps.loadL2Weights,
      // FR-12 接线2：注入 L3 语境源，让 L2 产出自评步优先使用用户自己的 L3 语境。
      // 未注入时回退到 noopContextSource（恒返 []，不影响任何现有行为）。
      // 生产环境默认注入 L3ContextSourceAdapter（自带 withTransaction + RLS）。
      contextSource: deps.contextSource ?? new L3ContextSourceAdapter(),
      // P2-5：注入全局 telemetry 单例，采集 L3 命中率/延迟/L2 verdict 真实流量
      telemetry,
    }),
    l2content,
    l3Context,
    l3Proposal,
    l3Read,
    l3Recommendation,
    l3Import: new L3ImportService(repos.l3Context, l3Proposal),
  };
}

export type Services = ReturnType<typeof createServices>;
