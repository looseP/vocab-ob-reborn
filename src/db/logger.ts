/**
 * Lightweight logger — replaces v1's @/lib/logger so v2 has zero coupling
 * to the old project. Outputs to stderr so it never interferes with
 * HTTP responses or stdout-based tooling.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MIN_LEVEL: Level = process.env.DB_LOG_LEVEL as Level ?? "info";

function log(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[MIN_LEVEL]) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${scope}]`;
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console.error(prefix, message, extra);
  } else {
    // eslint-disable-next-line no-console
    console.error(prefix, message);
  }
}

export const logger = {
  debug: (scope: string, msg: string, extra?: unknown) => log("debug", scope, msg, extra),
  info: (scope: string, msg: string, extra?: unknown) => log("info", scope, msg, extra),
  warn: (scope: string, msg: string, extra?: unknown) => log("warn", scope, msg, extra),
  error: (scope: string, msg: string, extra?: unknown) => log("error", scope, msg, extra),
};
