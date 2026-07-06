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

export async function withTransaction<T>(
  callback: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
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
