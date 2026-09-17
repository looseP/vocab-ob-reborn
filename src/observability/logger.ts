/**
 * Structured logger — outputs JSON lines to stderr.
 *
 * Slow query detection (>100ms) is handled by timedQuery() in
 * BaseRepository.query(), which wraps every DB call.
 *
 * stdout/stderr remain the single source of truth (ADR-0026 explicitly
 * rejects application-layer log double-writing). Rotation and retention are
 * the container runtime's job (Docker json-file `max-size`/`max-file`); this
 * module must never write to a file.
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

/**
 * Correlation context stamped onto every entry a bound logger emits.
 *
 * `requestId` is promoted to a top-level JSON field (never nested under
 * `meta`) so an operator can grep the exact id the client received in the
 * `X-Request-ID` response header.
 */
export interface LogContext {
  requestId?: string;
}

export interface Logger {
  debug(scope: string, msg: string, meta?: Record<string, unknown>): void;
  info(scope: string, msg: string, meta?: Record<string, unknown>): void;
  warn(scope: string, msg: string, meta?: Record<string, unknown>): void;
  error(scope: string, msg: string, meta?: Record<string, unknown>): void;
  /**
   * Return a logger that stamps `context` on every entry it emits, for example
   * `logger.withMeta({ requestId })`. Binding is additive: a child logger
   * inherits its parent's context and may override individual fields.
   */
  withMeta(context: LogContext): Logger;
}

function log(
  level: LogLevel,
  scope: string,
  msg: string,
  meta?: Record<string, unknown>,
  requestId?: string,
): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[MIN_LEVEL]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(requestId ? { requestId } : {}),
    ...(meta ? { meta } : {}),
  };

  // eslint-disable-next-line no-console
  console.error(JSON.stringify(entry));
}

function createLogger(context: LogContext): Logger {
  return {
    debug: (s, m, meta) => log("debug", s, m, meta, context.requestId),
    info: (s, m, meta) => log("info", s, m, meta, context.requestId),
    warn: (s, m, meta) => log("warn", s, m, meta, context.requestId),
    error: (s, m, meta) => log("error", s, m, meta, context.requestId),
    withMeta: (next) => createLogger({ requestId: next.requestId ?? context.requestId }),
  };
}

export const logger: Logger = createLogger({});
