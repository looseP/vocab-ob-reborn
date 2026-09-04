/**
 * Unified domain error hierarchy.
 *
 * All application errors extend AppError. Each subclass declares its HTTP
 * status code and machine-readable code, so the Route layer can uniformly
 * map errors to HTTP responses via errorToResponse().
 *
 * Usage:
 *   throw new NotFoundError("Word", slug);
 *   throw new BusinessRuleError("Cannot answer a suspended card");
 *   throw new ConflictError("Idempotency key already used");
 */

export abstract class AppError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly code: string;

  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    // Preserve stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/** Resource not found (404). */
export class NotFoundError extends AppError {
  readonly httpStatus = 404;
  readonly code = "NOT_FOUND";

  constructor(
    public readonly resourceType: string,
    public readonly identifier: string,
    cause?: unknown,
  ) {
    super(`${resourceType} not found: ${identifier}`, cause, { resourceType, identifier });
  }
}

/** Input validation failed (422). */
export class ValidationError extends AppError {
  readonly httpStatus = 422;
  readonly code = "VALIDATION_ERROR";

  constructor(
    message: string,
    public readonly field?: string,
    cause?: unknown,
  ) {
    super(message, cause, field ? { field } : undefined);
  }
}

/** Conflict — duplicate resource, idempotency collision (409). */
export class ConflictError extends AppError {
  readonly httpStatus = 409;
  readonly code = "CONFLICT";
}

/** Unauthorized — not authenticated (401). */
export class UnauthorizedError extends AppError {
  readonly httpStatus = 401;
  readonly code = "UNAUTHORIZED";
}

/** Forbidden — authenticated but not allowed (403). */
export class ForbiddenError extends AppError {
  readonly httpStatus = 403;
  readonly code = "FORBIDDEN";
}

/** Business rule violation (422). */
export class BusinessRuleError extends AppError {
  readonly httpStatus = 422;
  readonly code = "BUSINESS_RULE";
}

/** Database connection unavailable (503). */
export class DbConnectionError extends AppError {
  readonly httpStatus = 503;
  readonly code = "DB_UNAVAILABLE";
}

/**
 * Map any thrown error to an HTTP response shape.
 * Route layer uses this to avoid per-route error handling.
 */
export function errorToResponse(error: unknown): {
  status: number;
  body: { error: string; code: string; details?: unknown };
} {
  if (error instanceof AppError) {
    return {
      status: error.httpStatus,
      body: {
        error: error.message,
        code: error.code,
        ...(error.meta ? { details: error.meta } : {}),
      },
    };
  }

  // pg connection errors — detect by SQLSTATE / errno
  if (isDbConnectionError(error)) {
    return {
      status: 503,
      body: { error: "Service temporarily unavailable.", code: "DB_UNAVAILABLE" },
    };
  }

  // Unknown error — don't leak internals
  return {
    status: 500,
    body: { error: "Internal server error", code: "INTERNAL" },
  };
}

/** SQLSTATE codes and errno patterns indicating connection failures. */
const DB_CONNECTION_SQLSTATES = new Set([
  "08000", "08003", "08006", "08001", "08004", "57P03",
]);
const DB_CONNECTION_ERRNOS = new Set([
  "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "EPIPE",
  "EHOSTUNREACH", "ENETUNREACH",
]);

export function isDbConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as Record<string, unknown>;
  const code = err.code as string | undefined;

  if (code && DB_CONNECTION_SQLSTATES.has(code)) return true;
  if (code && DB_CONNECTION_ERRNOS.has(code)) return true;

  const msg = (err.message as string | undefined)?.toLowerCase() ?? "";
  if (
    msg.includes("connection terminated") ||
    msg.includes("connection refused") ||
    msg.includes("connect econnrefused") ||
    msg.includes("getaddrinfo enotfound")
  ) {
    return true;
  }

  return false;
}
