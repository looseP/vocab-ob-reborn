/**
 * HTTP input schemas — ported from v1's lib/validation/schemas.ts.
 *
 * These validate raw HTTP input (URL params, JSON body). They use z.coerce
 * for URL string→number conversion and .default() for missing fields.
 * The Service layer receives already-parsed strong types derived from these.
 */

import { z } from "zod";

// ── Primitives ──────────────────────────────────────────────────────────
export const reviewRatingSchema = z.enum(["again", "hard", "good", "easy"]);

export const uuidSchema = z.string().uuid();

// ── Words ───────────────────────────────────────────────────────────────
export const wordsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(60),
  offset: z.coerce.number().int().min(0).optional().default(0),
  freq: z.string().max(50).optional(),
  q: z.string().max(200).optional(),
  semantic: z.string().max(100).optional(),
  review: z.enum(["all", "tracked", "due", "untracked"]).optional().default("all"),
  wordbookId: uuidSchema.optional(),
});

// ── Review ──────────────────────────────────────────────────────────────
export const reviewAnswerSchema = z.object({
  progressId: uuidSchema,
  rating: reviewRatingSchema,
  sessionId: uuidSchema,
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const reviewSkipSchema = z.object({
  progressId: uuidSchema,
  sessionId: uuidSchema,
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const reviewSuspendSchema = z.object({
  progressId: uuidSchema,
  sessionId: uuidSchema.optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const reviewUndoSchema = z.object({
  reviewLogId: z.string().min(1),
  sessionId: uuidSchema,
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export const reviewRejoinSchema = z.object({
  progressId: uuidSchema,
});

export const reviewSettingsSchema = z.object({
  desiredRetention: z.number().min(0.7).max(0.99),
  retuneExisting: z.boolean().optional().default(false),
  wordbookId: uuidSchema.optional(),
});

export const addToReviewSchema = z.object({
  wordId: uuidSchema,
  wordbookId: uuidSchema.optional(),
});

export const batchAddToReviewSchema = z.object({
  wordIds: z.array(uuidSchema).min(1).max(100),
  wordbookId: uuidSchema.optional(),
});

export const batchAddFromContentSchema = z.object({
  content: z.string().min(1).max(200_000),
  wordbookId: uuidSchema.optional(),
  dryRun: z.boolean().optional(),
  autoEnqueue: z.boolean().optional().default(true),
});

// ── Notes ───────────────────────────────────────────────────────────────
export const noteSchema = z.object({
  contentMd: z.string().max(20_000),
  wordbookId: uuidSchema.optional(),
});

export const noteRestoreSchema = z.object({
  revisionId: uuidSchema,
  wordbookId: uuidSchema.optional(),
});

// ── Wordbooks ───────────────────────────────────────────────────────────
export const wordbookCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

export const wordbookAddWordsSchema = z.object({
  wordIds: z.array(uuidSchema).min(1).max(500),
});

// ── Highlights ──────────────────────────────────────────────────────────
export const highlightCreateSchema = z.object({
  word_id: uuidSchema,
  source_field: z.string().max(100).default("definition_md"),
  text_snippet: z.string().min(1).max(10_000),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default("#eab308"),
});

// ── Annotations ─────────────────────────────────────────────────────────
export const annotationUpsertSchema = z.object({
  word_id: uuidSchema,
  content: z.string().max(50_000),
});

// ── Quality ─────────────────────────────────────────────────────────────
export const qualityStrictnessSchema = z.enum(["lenient", "standard", "strict"]).default("standard");
