/**
 * ReviewCard — rich domain entity for a word awaiting review.
 *
 * Encapsulates FSRS scheduling state queries and business rules:
 * - isDue: should this card be shown now?
 * - isSuspended: blocked from review?
 * - isLeech: failed too many times, needs special handling?
 * - needsRecheck: word content changed since last review?
 */

import type { ReviewState, UserWordProgressRow } from "./index";

export interface WordRef {
  id: string;
  slug: string;
  title: string;
  lemma: string;
}

/** Lapse threshold for leech detection (FSRS convention). */
const LEECH_LAPSE_THRESHOLD = 8;

export class ReviewCard {
  constructor(
    private readonly progress: UserWordProgressRow,
    private readonly word: WordRef,
  ) {}

  get id(): string { return this.progress.id; }
  get wordId(): string { return this.progress.word_id; }
  get wordbookId(): string { return this.progress.wordbook_id; }
  get state(): ReviewState { return this.progress.state; }
  get dueAt(): string | null { return this.progress.due_at; }
  get lapseCount(): number { return this.progress.lapse_count; }
  get reviewCount(): number { return this.progress.review_count; }
  get schedulerPayload(): unknown { return this.progress.scheduler_payload; }
  get desiredRetention(): number { return this.progress.desired_retention; }
  get contentHashSnapshot(): string | null { return this.progress.content_hash_snapshot; }

  get wordRef(): WordRef { return this.word; }

  /** Is this card due for review now (or overdue)? */
  get isDue(): boolean {
    if (this.state === "suspended") return false;
    if (this.dueAt === null) return true; // new card
    return new Date(this.dueAt) <= new Date();
  }

  get isSuspended(): boolean {
    return this.state === "suspended";
  }

  /** A leech has lapsed too many times — needs alternative study. */
  get isLeech(): boolean {
    return this.lapseCount >= LEECH_LAPSE_THRESHOLD;
  }

  /** Has the word's content changed since this card was last reviewed? */
  needsRecheck(currentContentHash: string): boolean {
    return (
      this.contentHashSnapshot !== null &&
      this.contentHashSnapshot !== currentContentHash
    );
  }

  /** Can the user answer this card right now? */
  get isAnswerable(): boolean {
    return !this.isSuspended && this.isDue;
  }
}
