/**
 * PostgreSQL connection pool — singleton, with type-parser customization.
 *
 * Ported from v1's lib/db/pool.ts with two changes:
 * 1. Uses v2's lightweight logger (no @/lib/logger dependency).
 * 2. Loads .env via dotenv at first access (so scripts/tests don't need
 *    an external dotenv-cli wrapper).
 *
 * Type parsers (global side-effect, same as v1):
 * - NUMERIC / INT8 → JS number (pg default is string)
 * - TIMESTAMP / TIMESTAMPTZ / DATE → ISO string (pg default is Date, which
 *   breaks downstream `.slice(0,10)` usage)
 */

import { Pool, types, type QueryConfig } from "pg";
import { logger } from "./logger";
import type { PoolHealth } from "./types";

// Parse numeric/int8 as JS numbers instead of strings
types.setTypeParser(types.builtins.NUMERIC, (val) => parseFloat(val));
types.setTypeParser(types.builtins.INT8, (val) => parseInt(val, 10));

// Keep timestamps as ISO strings
types.setTypeParser(types.builtins.TIMESTAMP, (val) => val);
types.setTypeParser(types.builtins.TIMESTAMPTZ, (val) => val);
types.setTypeParser(types.builtins.DATE, (val) => val);

let _pool: Pool | null = null;
let _listenersAttached = false;

const POOL_MAX = parseInt(process.env.DB_POOL_MAX ?? "10", 10);
const POOL_IDLE_TIMEOUT_MS = parseInt(process.env.DB_IDLE_TIMEOUT_MS ?? "30000", 10);
const POOL_CONNECT_TIMEOUT_MS = parseInt(process.env.DB_CONNECT_TIMEOUT_MS ?? "5000", 10);
const POOL_KEEPALIVE_INITIAL_DELAY_MS = parseInt(
  process.env.DB_KEEPALIVE_DELAY_MS ?? "10000",
  10,
);

export function getPool(): Pool {
  if (!_pool) {
    // Load .env on first access — keeps the public API simple for callers
    // that don't use dotenv-cli.
    if (!process.env.DATABASE_URL) {
      try {
        // ESM dynamic import fallback — works under tsx
        const { config } = require("dotenv");
        config();
      } catch {
        // dotenv is a devDependency; if missing, rely on real env vars.
      }
    }
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not configured.");
    }
    _pool = new Pool({
      connectionString: url,
      max: POOL_MAX,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: POOL_KEEPALIVE_INITIAL_DELAY_MS,
      allowExitOnIdle: true,
    });
    _listenersAttached = false;
    attachPoolListeners(_pool);
  }
  return _pool;
}

function attachPoolListeners(pool: Pool): void {
  if (_listenersAttached) return;
  _listenersAttached = true;

  pool.on("error", (err: Error) => {
    logger.error("db", "Idle pool client error (auto-removed by pg)", err);
  });
  pool.on("connect", () => {
    logger.debug("db", "New client connected to pool");
  });
  pool.on("acquire", () => {
    logger.debug("db", "Client acquired from pool");
  });
  pool.on("remove", () => {
    logger.debug("db", "Client removed from pool");
  });
}

export async function checkPoolHealth(queryTimeoutMs = 400): Promise<PoolHealth> {
  const pool = getPool();
  try {
    const healthQuery = {
      text: "SELECT 1",
      query_timeout: queryTimeoutMs,
    } as QueryConfig & { query_timeout: number };
    await pool.query(healthQuery);
    return {
      ok: true,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    };
  } catch (err) {
    logger.error("db", "Health check query failed", err);
    return {
      ok: false,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    };
  }
}

export async function resetPool(): Promise<void> {
  if (!_pool) return;
  const oldPool = _pool;
  _pool = null;
  _listenersAttached = false;
  await oldPool.end();
  logger.info("db", "Pool reset completed");
}

export { getPool as pool };
