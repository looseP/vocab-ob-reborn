/**
 * Wordbook — rich domain entity for word collections.
 *
 * Encapsulates wordbook-level settings access (FSRS weights, desired retention,
 * direction).
 */

import type { Direction, WordbookRow } from "./index";

const DIRECTIONS: readonly Direction[] = ["通用", "考研", "雅思"];

function isDirection(value: unknown): value is Direction {
  return typeof value === "string" && (DIRECTIONS as readonly string[]).includes(value);
}

export class Wordbook {
  constructor(private readonly row: WordbookRow) {}

  get id(): string { return this.row.id; }
  get name(): string { return this.row.name; }
  get description(): string | null { return this.row.description; }
  get isDefault(): boolean { return this.row.is_default; }
  get userId(): string { return this.row.user_id; }

  /**
   * Direction（方向，ADR-0017）: the book-scoped exam/purpose flavor that
   * weights the review queue and prioritizes direction-flavored L2 content.
   * Stored in `settings.direction` (no column); absent or unrecognized → `通用`
   * (the direction-agnostic bucket).
   */
  get direction(): Direction {
    const settings = this.row.settings as Record<string, unknown> | null;
    return isDirection(settings?.direction) ? settings.direction : "通用";
  }

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
