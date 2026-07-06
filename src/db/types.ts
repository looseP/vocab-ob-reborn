/**
 * DB shared types — framework-agnostic, no runtime dependencies.
 *
 * These mirror the result shapes of v1's lib/db/types.ts but drop the
 * Supabase-specific coupling (LOCAL_OWNER, FkMap, etc.) so the Repository
 * layer owns its own contracts.
 */

export interface DbError {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

/** PostgreSQL error shape returned by the `pg` driver. */
export interface PgError extends Error {
  code?: string;
  details?: string;
  hint?: string;
}

export interface DbResult<T> {
  data: T | null;
  error: DbError | null;
}

export interface DbArrayResult<T> {
  data: T[] | null;
  error: DbError | null;
  count?: number | null;
}

export interface PoolHealth {
  ok: boolean;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

/** A connection bound to a transaction — PoolClient from pg. */
export type TransactionClient = import("pg").PoolClient;
