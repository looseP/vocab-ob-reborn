/**
 * Wordbook — rich domain entity for word collections.
 *
 * Encapsulates wordbook-level settings access (FSRS weights, desired retention).
 */

import type { WordbookRow } from "./index";

export class Wordbook {
  constructor(private readonly row: WordbookRow) {}

  get id(): string { return this.row.id; }
  get name(): string { return this.row.name; }
  get description(): string | null { return this.row.description; }
  get isDefault(): boolean { return this.row.is_default; }
  get userId(): string { return this.row.user_id; }

  /** Extract FSRS review settings from the wordbook's JSONB settings. */
  get reviewSettings(): {
    desiredRetention?: number;
    fsrsWeights?: number[];
  } {
    const settings = this.row.settings as Record<string, unknown> | null;
    const review = settings?.review as Record<string, unknown> | undefined;
    if (!review) return {};

    return {
      ...(typeof review.desired_retention === "number"
        ? { desiredRetention: review.desired_retention }
        : {}),
      ...(Array.isArray(review.fsrs_weights)
        ? { fsrsWeights: review.fsrs_weights as number[] }
        : {}),
    };
  }
}
