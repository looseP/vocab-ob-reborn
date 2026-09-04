import { describe, it, expectTypeOf } from "vitest";
import type { ReviewRating, ReviewState, StoredSchedulerCard, SchedulerUpdate } from "@/fsrs/types";

describe("FSRS types", () => {
  it("ReviewRating is the four rating literals", () => {
    expectTypeOf<ReviewRating>().toEqualTypeOf<"again" | "hard" | "good" | "easy">();
  });

  it("ReviewState is the four state literals", () => {
    expectTypeOf<ReviewState>().toEqualTypeOf<"new" | "learning" | "review" | "relearning">();
  });

  it("StoredSchedulerCard has serializable fields", () => {
    expectTypeOf<StoredSchedulerCard>().toMatchTypeOf<{
      difficulty: number;
      due: string;
      elapsed_days: number;
      lapses: number;
      learning_steps: number;
      last_review: string | null;
      reps: number;
      scheduled_days: number;
      stability: number;
      state: number;
    }>();
  });

  it("SchedulerUpdate wraps the scheduling result", () => {
    expectTypeOf<SchedulerUpdate>().toMatchTypeOf<{
      difficulty: number;
      dueAt: string;
      elapsedDays: number;
      lapses: number;
      logDueAt: string;
      nextPayload: StoredSchedulerCard;
      rating: ReviewRating;
      reps: number;
      retrievability: number | null;
      scheduledDays: number;
      stability: number;
      state: ReviewState;
    }>();
  });
});
