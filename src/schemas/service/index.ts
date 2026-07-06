/**
 * Service-layer DTO types — derived from HTTP schemas but without coercion.
 *
 * These are the strong-typed contracts that Service methods accept.
 * The Route layer parses HTTP input with the http schemas, then passes
 * the inferred type to the Service.
 */

import { z } from "zod";
import {
  reviewAnswerSchema,
  reviewSkipSchema,
  reviewSuspendSchema,
  reviewUndoSchema,
  reviewSettingsSchema,
  noteSchema,
  wordbookCreateSchema,
  wordsQuerySchema,
  batchAddFromContentSchema,
} from "../http";

// ── Word service ────────────────────────────────────────────────────────
export type WordsQuery = z.infer<typeof wordsQuerySchema>;

// ── Review service ──────────────────────────────────────────────────────
export type SubmitAnswerInput = z.infer<typeof reviewAnswerSchema>;
export type SkipReviewInput = z.infer<typeof reviewSkipSchema>;
export type SuspendReviewInput = z.infer<typeof reviewSuspendSchema>;
export type UndoReviewInput = z.infer<typeof reviewUndoSchema>;
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;

export interface SubmitAnswerResult {
  ok: boolean;
  idempotent?: boolean;
  reviewLogId: string;
  nextDueAt?: string;
  state?: string;
}

// ── Note service ────────────────────────────────────────────────────────
export type UpsertNoteInput = z.infer<typeof noteSchema>;

export interface UpsertNoteResult {
  ok: boolean;
  updatedAt: string;
  version: number;
}

// ── Wordbook service ────────────────────────────────────────────────────
export type CreateWordbookInput = z.infer<typeof wordbookCreateSchema>;

// ── Import service ──────────────────────────────────────────────────────
export type BatchAddFromContentInput = z.infer<typeof batchAddFromContentSchema>;
