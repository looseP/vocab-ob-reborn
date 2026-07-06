/**
 * Structured logger — outputs JSON lines to stderr.
 *
 * Slow query detection (>100ms) is handled by timedQuery() in
 * BaseRepository.query(), which wraps every DB call.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MIN_LEVEL: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) ?? "info";

export interface Logger {
  debug(scope: string, msg: string, meta?: Record<string, unknown>): void;
  info(scope: string, msg: string, meta?: Record<string, unknown>): void;
  warn(scope: string, msg: string, meta?: Record<string, unknown>): void;
  error(scope: string, msg: string, meta?: Record<string, unknown>): void;
}

function log(
  level: LogLevel,
  scope: string,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[MIN_LEVEL]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(meta ? { meta } : {}),
  };

  // eslint-disable-next-line no-console
  console.error(JSON.stringify(entry));
}

export const logger: Logger = {
  debug: (s, m, meta) => log("debug", s, m, meta),
  info: (s, m, meta) => log("info", s, m, meta),
  warn: (s, m, meta) => log("warn", s, m, meta),
  error: (s, m, meta) => log("error", s, m, meta),
};
