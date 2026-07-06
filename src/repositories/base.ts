/**
 * BaseRepository — shared transaction-injection logic.
 *
 * Key design:
 * - Constructed with an optional `PoolClient` (a transaction connection).
 * - `executor` resolves to the tx client if present, otherwise the global pool.
 * - `requireTx()` asserts a transaction is active — for methods that MUST
 *   run inside a transaction (advisory lock, FOR UPDATE, multi-statement).
 * - `query()`/`queryOne()` are wrapped with `timedQuery` for observability.
 */

import type { Pool, PoolClient } from "pg";
import { getPool } from "../db/connection";
import { BusinessRuleError } from "../errors";
import { timedQuery } from "../observability/timing";

export abstract class BaseRepository {
  constructor(protected readonly tx?: PoolClient) {}

  protected get executor(): Pool | PoolClient {
    return this.tx ?? getPool();
  }

  /**
   * Assert that this repository is bound to a transaction.
   * Methods that use advisory locks, SELECT FOR UPDATE, or multi-statement
   * atomicity MUST call this first.
   */
  protected requireTx(): PoolClient {
    if (!this.tx) {
      throw new BusinessRuleError(
        `${this.constructor.name} method requires an active transaction — ` +
        `use createRepositories(tx) inside withTransaction()`,
      );
    }
    return this.tx;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg returns any rows; we narrow at call site
  protected async query<T = any>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return timedQuery(
      this.constructor.name,
      text,
      async () => {
        const result = await this.executor.query(text, params);
        return result.rows as T[];
      },
    );
  }

  protected async queryOne<T = any>(
    text: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }
}
