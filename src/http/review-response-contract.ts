import { z } from "zod";

const reviewStateSchema = z.enum([
  "new",
  "learning",
  "review",
  "relearning",
]);

export const reviewAnswerResponseSchema = z.object({
  ok: z.literal(true),
  idempotent: z.literal(true).optional(),
  reviewLogId: z.string().uuid(),
  nextDueAt: z.iso.datetime({ offset: true }).optional(),
  state: reviewStateSchema.optional(),
}).strict();

export const reviewSimpleResponseSchema = z.object({
  ok: z.literal(true),
  idempotent: z.literal(true).optional(),
}).strict();

// ── Review support endpoints (queue / stats / leeches / timeline / heatmap) ──

const reviewRatingSchema = z.enum(["again", "hard", "good", "easy"]);

const queueCardWordSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  lemma: z.string(),
  short_definition: z.string().nullable(),
  ipa: z.string().nullable(),
  pos: z.string().nullable(),
  cefr: z.string().nullable(),
}).strict();

export const reviewQueueResponseSchema = z.object({
  items: z.array(z.object({
    progressId: z.string(),
    word: queueCardWordSchema,
    state: reviewStateSchema,
    dueAt: z.string().nullable(),
    lastRating: reviewRatingSchema.nullable(),
    reviewCount: z.number().int().nonnegative(),
  }).strict()),
  session: z.object({
    id: z.string(),
    mode: z.string(),
    cardsSeen: z.number().int().nonnegative(),
  }).strict(),
  stats: z.object({
    total: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const reviewStatsResponseSchema = z.object({
  todayCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  ratingDist: z.object({
    again: z.number().int().nonnegative(),
    hard: z.number().int().nonnegative(),
    good: z.number().int().nonnegative(),
    easy: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const reviewLeechesResponseSchema = z.object({
  items: z.array(z.object({
    progressId: z.string(),
    word: z.object({
      id: z.string(),
      slug: z.string(),
      title: z.string(),
      lemma: z.string(),
      short_definition: z.string().nullable(),
    }).strict(),
    lapseCount: z.number().int().nonnegative(),
    state: reviewStateSchema,
    dueAt: z.string().nullable(),
  }).strict()),
  total: z.number().int().nonnegative(),
}).strict();

export const reviewTimelineResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    rating: z.string(),
    created_at: z.string(),
    word_slug: z.string(),
    word_lemma: z.string(),
  }).strict()),
  total: z.number().int().nonnegative(),
}).strict();

export const reviewHeatmapResponseSchema = z.object({
  items: z.array(z.object({
    date: z.string(),
    count: z.string(),
  }).strict()),
}).strict();

// ── Card enqueue endpoints (R0) ─────────────────────────────────────────────

export const reviewEnqueueCardResponseSchema = z.object({
  ok: z.literal(true),
  progressId: z.string().uuid(),
}).strict();

export const reviewEnqueueCardsBatchResponseSchema = z.object({
  ok: z.literal(true),
  added: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  progressIds: z.array(z.string().uuid()),
}).strict();
