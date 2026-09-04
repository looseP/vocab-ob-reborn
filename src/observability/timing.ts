/**
 * Query timing — wraps repository queries with duration logging.
 *
 * Slow queries (>threshold) are logged at warn level.
 * All queries can be logged at debug level when LOG_LEVEL=debug.
 */

import { logger } from "./logger";

const SLOW_QUERY_THRESHOLD_MS = 100;

/**
 * Wrap an async DB operation with timing + logging.
 * Usage:
 *   const rows = await timedQuery("words.findBySlug", "SELECT ...", async () => {
 *     return this.query(...);
 *   });
 */
export async function timedQuery<T>(
  operation: string,
  sqlPreview: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    const elapsed = Date.now() - start;

    if (elapsed > SLOW_QUERY_THRESHOLD_MS) {
      logger.warn("db.slow", `Slow query: ${operation}`, {
        operation,
        ms: elapsed,
        sql: sqlPreview.slice(0, 200),
      });
    } else {
      logger.debug("db.query", operation, { ms: elapsed });
    }

    return result;
  } catch (error) {
    const elapsed = Date.now() - start;
    logger.error("db.error", `Query failed: ${operation}`, {
      operation,
      ms: elapsed,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
