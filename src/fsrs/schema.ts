/**
 * Runtime validation for stored FSRS scheduler payloads.
 *
 * The scheduler_payload jsonb column is written only by this module's adapter,
 * but historical rows may carry corrupted or version-mismatched JSON. Before a
 * payload crosses the persistence boundary into ts-fsrs, it MUST be validated
 * here — we never force-cast an untrusted jsonb into the scheduler.
 *
 * Design:
 *  - All fields optional with defaults matching buildInitialSchedulerPayload(),
 *    so older / short payloads stay compatible (version tolerance).
 *  - Present fields are strictly typed; a wrong type FAILS (corruption caught).
 *  - null / undefined / {} payload is treated as "no progress yet" → fresh card.
 *
 * This module stays self-contained: only depends on zod + ./types.
 */
import { z } from "zod";
import type { StoredSchedulerCard } from "./types";

const isoDateString = z.iso.datetime({ offset: true });

const nonNegativeInt = z.number().int().nonnegative();

export const storedSchedulerCardSchema = z.object({
  difficulty: z.number().finite().optional().default(0),
  due: isoDateString.optional().default(new Date(0).toISOString()),
  elapsed_days: nonNegativeInt.optional().default(0),
  lapses: nonNegativeInt.optional().default(0),
  learning_steps: nonNegativeInt.optional().default(0),
  last_review: isoDateString.nullable().optional().default(null),
  reps: nonNegativeInt.optional().default(0),
  scheduled_days: nonNegativeInt.optional().default(0),
  stability: z.number().finite().nonnegative().optional().default(0),
  state: z.number().int().min(0).max(3).optional().default(0),
});

/** Thrown when a stored scheduler payload fails runtime validation. */
export class SchedulerPayloadParseError extends Error {
  constructor(message: string, public readonly raw?: unknown) {
    super(message);
    this.name = "SchedulerPayloadParseError";
  }
}

/**
 * Validate an untrusted jsonb value into a structured StoredSchedulerCard.
 * @throws SchedulerPayloadParseError if any present field has the wrong type.
 */
export function parseSchedulerPayload(raw: unknown): StoredSchedulerCard {
  const value = raw === null || raw === undefined ? {} : raw;
  const result = storedSchedulerCardSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new SchedulerPayloadParseError(`invalid scheduler_payload (${issues})`, raw);
  }
  return result.data;
}
