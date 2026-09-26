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
import { NoteEntryRepository } from "./note-entry.repository";
import { WordbookRepository } from "./wordbook.repository";
import { HighlightRepository } from "./highlight.repository";
import { AnnotationRepository } from "./annotation.repository";
import { SessionRepository } from "./session.repository";
import { StatsRepository } from "./stats.repository";
import { L2ProgressRepository } from "./l2-progress.repository";
import { L2ContentRepository } from "./l2-content.repository";
import { UpgradeWorkOrderRepository } from "./upgrade-work-order.repository";
import { LlmUsageRepository } from "./llm-usage.repository";
import { L3ContextRepository } from "./l3-context.repository";
import { L3ProposalRepository } from "./l3-proposal.repository";
import { L3RecommendationRepository } from "./l3-recommendation.repository";
import { L3PracticeRepository } from "./l3-practice.repository";
import { L3ErrorBookRepository } from "./l3-error-book.repository";
import { L3SessionRepository } from "./l3-session.repository";
import { L3PaperRepository } from "./l3-paper.repository";
import { L3AnnotationRepository } from "./l3-annotations.repository";
import { L3SheetRepository } from "./l3-sheets.repository";
import { L3AssessmentRepository } from "./l3-assessments.repository";
import { L3GradingRepository } from "./l3-grading.repository";
import { L3WritingRepository } from "./l3-writing.repository";
import { L3WritingFeedbackRepository } from "./l3-writing-feedback.repository";
import { L3StudyNoteRepository } from "./l3-study-notes.repository";
import { L3StudyTopicRepository } from "./l3-study-topics.repository";
import { L3StudyReferenceRepository } from "./l3-study-references.repository";
import { OutboxRepository } from "./outbox.repository";

export function createRepositories(tx?: PoolClient): IRepositories {
  return {
    words: new WordRepository(tx),
    reviews: new ReviewRepository(tx),
    noteEntries: new NoteEntryRepository(tx),
    wordbooks: new WordbookRepository(tx),
    highlights: new HighlightRepository(tx),
    annotations: new AnnotationRepository(tx),
    sessions: new SessionRepository(tx),
    stats: new StatsRepository(tx),
    l2Progress: new L2ProgressRepository(tx),
    l2Content: new L2ContentRepository(tx),
    upgradeWorkOrders: new UpgradeWorkOrderRepository(tx),
    l3Context: new L3ContextRepository(tx),
    l3Proposal: new L3ProposalRepository(tx),
    l3Recommendation: new L3RecommendationRepository(tx),
    l3Practice: new L3PracticeRepository(tx),
    l3ErrorBook: new L3ErrorBookRepository(tx),
    l3Sessions: new L3SessionRepository(tx),
    l3Paper: new L3PaperRepository(tx),
    l3Annotations: new L3AnnotationRepository(tx),
    l3Sheets: new L3SheetRepository(tx),
    l3Assessments: new L3AssessmentRepository(tx),
    l3Grading: new L3GradingRepository(tx),
    l3Writing: new L3WritingRepository(tx),
    l3Feedback: new L3WritingFeedbackRepository(tx),
    studyNotes: new L3StudyNoteRepository(tx),
    studyTopics: new L3StudyTopicRepository(tx),
    studyReferences: new L3StudyReferenceRepository(tx),
    llmUsage: new LlmUsageRepository(tx),
    outbox: new OutboxRepository(tx),
  };
}

export type Repositories = IRepositories;
