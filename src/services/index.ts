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
import { AuthSessionService } from "./auth-session.service";
import type { LlmProvider } from "../llm/provider";
import type { UsageTracker } from "../llm/usage-tracker";
import type { DictionaryProvider } from "../dictionary/provider";
import { createRepositories } from "../repositories/factory";
import { AuthSessionRepository } from "../repositories/auth-session.repository";

export type { FsrsAdapterFn, FsrsScheduling };

export interface ServiceDeps {
  /** FSRS scheduling adapter — M6 fix: required */
  fsrsAdapter: FsrsAdapterFn;
  /** Load wordbook FSRS weights */
  loadWeights?: (wordbookId: string) => Promise<number[] | null>;
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
    authSessions: new AuthSessionService(new AuthSessionRepository()),
    words: new WordService(repos.words),
    reviews: new ReviewService({
      fsrsAdapter: deps.fsrsAdapter,
      loadWeights,
    }),
    notes: new NoteService(repos.notes, repos.wordbooks),
    wordbooks: new WordbookService(repos.wordbooks),
    stats: new StatsService(repos.stats),
    l2Transition,
    crossTrack,
    l2content,
    l3Context,
    l3Proposal,
    l3Read,
    l3Recommendation,
    l3Import: new L3ImportService(repos.l3Context, l3Proposal),
  };
}

export type Services = ReturnType<typeof createServices>;
