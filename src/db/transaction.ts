/**
 * Transaction support — v2 simplified design.
 *
 * Key difference from v1: the callback receives a raw `PoolClient` instead
 * of a pseudo-supabase client. This means:
 * - `tx.query(text, values)` for raw SQL (SELECT ... FOR UPDATE, advisory locks)
 * - Repositories created via `createRepositories(tx)` share this connection
 * - No more `.from()` / `.rpc()` builder API — Repositories own all SQL
 *
 * Usage:
 *   await withTransaction(async (tx) => {
 *     const repos = createRepositories(tx);
 *     const card = await repos.reviews.findDueCards(userId, wbId, 1);
 *     await repos.reviews.saveAnswer(card[0].id, schedule, key);
 *   });
 */

import type { PoolClient } from "pg";
import { getPool } from "./connection";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Identity that may be safely projected into PostgreSQL RLS policies.
 *
 * The caller must obtain actorId from an authenticated principal, never from
 * a request header/body/query parameter. Omitting it is still supported for
 * infrastructure transactions that deliberately do not read RLS-protected
 * user data (health checks, migrations, and bootstrap jobs).
 */
export interface TransactionOptions {
  actorId?: string;
}

export type TransactionCallback<T> = (tx: PoolClient) => Promise<T>;

function assertActorId(actorId: string): void {
  if (!UUID_RE.test(actorId)) {
    throw new Error("Transaction actorId must be a UUID");
  }
}

function shouldSetActorClaim(actorId: string | undefined): actorId is string {
  if (actorId === undefined) return false;
  assertActorId(actorId);
  return true;
}

/**
 * Run a callback on one PostgreSQL transaction connection.
 *
 * When an authenticated actor is supplied, `set_config(..., true)` scopes the
 * RLS claim to this transaction only. It therefore cannot survive COMMIT,
 * ROLLBACK, or the pool client being reused by another request.
 */
export async function withTransaction<T>(
  callback: TransactionCallback<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const actorId = shouldSetActorClaim(options.actorId) ? options.actorId : undefined;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (actorId) {
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true)",
        [actorId],
      );
    }
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ROLLBACK itself failed — still re-throw the original error
    }
    throw error;
  } finally {
    client.release();
  }
}
