/**
 * Public API — createRepositories() factory + all exports.
 *
 * v2 Clean Architecture (hardened):
 * - DB layer: Drizzle client, pool, sql, transaction, timezone
 * - Repository layer: 8 repositories + interfaces + factory (with requireTx)
 * - Domain layer: rich entities (Word, ReviewCard, Note, Wordbook) + raw types
 * - Service layer: createServices() factory (fsrsAdapter required)
 * - Errors: AppError hierarchy + errorToResponse
 * - Schemas: HTTP input schemas + Service DTOs
 * - Observability: structured logger + timedQuery (wired into BaseRepository)
 */

import type { PoolClient } from "pg";
import { BaseRepository } from "./repositories/base";
import { WordRepository } from "./repositories/word.repository";
import { ReviewRepository } from "./repositories/review.repository";
import { NoteRepository } from "./repositories/note.repository";
import { WordbookRepository } from "./repositories/wordbook.repository";
import { HighlightRepository } from "./repositories/highlight.repository";
import { AnnotationRepository } from "./repositories/annotation.repository";
import { SessionRepository } from "./repositories/session.repository";
import { StatsRepository } from "./repositories/stats.repository";

export function createRepositories(tx?: PoolClient) {
  return {
    words: new WordRepository(tx),
    reviews: new ReviewRepository(tx),
    notes: new NoteRepository(tx),
    wordbooks: new WordbookRepository(tx),
    highlights: new HighlightRepository(tx),
    annotations: new AnnotationRepository(tx),
    sessions: new SessionRepository(tx),
    stats: new StatsRepository(tx),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;

// ── Repository exports ──────────────────────────────────────────────────
export { BaseRepository } from "./repositories/base";
export { WordRepository } from "./repositories/word.repository";
export { ReviewRepository } from "./repositories/review.repository";
export { NoteRepository } from "./repositories/note.repository";
export { WordbookRepository } from "./repositories/wordbook.repository";
export { HighlightRepository } from "./repositories/highlight.repository";
export { AnnotationRepository } from "./repositories/annotation.repository";
export { SessionRepository } from "./repositories/session.repository";
export { StatsRepository } from "./repositories/stats.repository";

// ── DB layer exports ────────────────────────────────────────────────────
export { withTransaction } from "./db/transaction";
export { getPool, checkPoolHealth, resetPool } from "./db/connection";
export { getDb, createDrizzleFromClient, resetDb, type DrizzleDB } from "./db/client";
export { sql } from "./db/sql";
export { logger } from "./db/logger";
export { DISPLAY_TIMEZONE, todayKeyInDisplayTz, dayKeyInDisplayTz, startOfTodayIsoInDisplayTz } from "./db/timezone";

// ── Domain layer exports ────────────────────────────────────────────────
export { Word } from "./domain/word.entity";
export { ReviewCard, type WordRef } from "./domain/review.entity";
export { Note } from "./domain/note.entity";
export { Wordbook } from "./domain/wordbook.entity";
export type * from "./domain";

// ── Error exports ───────────────────────────────────────────────────────
export {
  AppError,
  NotFoundError,
  ValidationError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  BusinessRuleError,
  DbConnectionError,
  errorToResponse,
  isDbConnectionError,
} from "./errors";

// ── Schema exports ──────────────────────────────────────────────────────
export * as httpSchemas from "./schemas/http";
export type * from "./schemas/service";

// ── Service layer exports ───────────────────────────────────────────────
export { createServices, type Services, type ServiceDeps } from "./services";
export { WordService } from "./services/word.service";
export { ReviewService, type FsrsAdapterFn } from "./services/review.service";
export { NoteService } from "./services/note.service";
export { WordbookService } from "./services/wordbook.service";
export { StatsService } from "./services/stats.service";
