/**
 * Drizzle client — wraps the existing pg.Pool with Drizzle's query layer.
 *
 * Drizzle does NOT replace pg; it layers on top of it. We reuse the same
 * singleton pool from connection.ts so all DB access (Drizzle queries,
 * raw sql, transactions) shares one connection pool.
 *
 * M2 fix: resetDb() clears both _db and _pool so test/multi-env switches
 * don't hold stale references.
 */

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { getPool, resetPool } from "./connection";
import * as schema from "./schema";

export type DrizzleDB = NodePgDatabase<typeof schema>;

let _db: DrizzleDB | null = null;

export function getDb(): DrizzleDB {
  if (!_db) {
    _db = drizzle({ client: getPool(), schema });
  }
  return _db;
}

/**
 * Create a Drizzle instance bound to a specific PoolClient (for transactions).
 * Use this inside withTransaction() to get a tx-scoped Drizzle client.
 */
export function createDrizzleFromClient(client: PoolClient): DrizzleDB {
  return drizzle({ client, schema });
}

/**
 * Reset both the Drizzle client and the underlying pg.Pool.
 * Use this in test afterEach / multi-environment switches to avoid
 * holding stale connections.
 */
export async function resetDb(): Promise<void> {
  _db = null;
  await resetPool();
}
