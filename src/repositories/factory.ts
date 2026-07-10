/**
 * Repository factory — creates a set of repositories, optionally bound to a
 * transaction connection.
 *
 * M-NEW-3 fix: extracted from src/index.ts to break circular dependency.
 * Services import from here (not from @/index), which avoids the
 * index.ts → services → index.ts cycle.
 */

import type { PoolClient } from "pg";
import type { IRepositories } from "./interfaces";
import { WordRepository } from "./word.repository";
import { ReviewRepository } from "./review.repository";
import { NoteRepository } from "./note.repository";
import { WordbookRepository } from "./wordbook.repository";
import { HighlightRepository } from "./highlight.repository";
import { AnnotationRepository } from "./annotation.repository";
import { SessionRepository } from "./session.repository";
import { StatsRepository } from "./stats.repository";
import { L2ProgressRepository } from "./l2-progress.repository";
import { L2ContentRepository } from "./l2-content.repository";
import { LlmUsageRepository } from "./llm-usage.repository";
import { L3ContextRepository } from "./l3-context.repository";
import { L3ProposalRepository } from "./l3-proposal.repository";
import { L3RecommendationRepository } from "./l3-recommendation.repository";
import { OutboxRepository } from "./outbox.repository";

export function createRepositories(tx?: PoolClient): IRepositories {
  return {
    words: new WordRepository(tx),
    reviews: new ReviewRepository(tx),
    notes: new NoteRepository(tx),
    wordbooks: new WordbookRepository(tx),
    highlights: new HighlightRepository(tx),
    annotations: new AnnotationRepository(tx),
    sessions: new SessionRepository(tx),
    stats: new StatsRepository(tx),
    l2Progress: new L2ProgressRepository(tx),
    l2Content: new L2ContentRepository(tx),
    l3Context: new L3ContextRepository(tx),
    l3Proposal: new L3ProposalRepository(tx),
    l3Recommendation: new L3RecommendationRepository(tx),
    llmUsage: new LlmUsageRepository(tx),
    outbox: new OutboxRepository(tx),
  };
}

export type Repositories = IRepositories;
