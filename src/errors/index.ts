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

  // pg constraint / invalid-input errors — caused by client input, not by the
  // infrastructure. Must stay AFTER isDbConnectionError so a connection-state
  // SQLSTATE is never reinterpreted as a client error.
  const constraint = toConstraintViolationResponse(error);
  if (constraint) {
    return constraint;
  }

  // Unknown error — don't leak internals
  return {
    status: 500,
    body: { error: "Internal server error", code: "INTERNAL" },
  };
}

/**
 * SQLSTATE → HTTP mapping for constraint violations and invalid input.
 *
 * These are all caused by user-supplied data reaching the database, so they are
 * reported as 4xx with a fixed, user-safe message. Nothing that Postgres
 * reports (`detail`, `constraint`, `table`, `column`, raw `message`) is ever
 * copied into the response body.
 *
 * NOTE: 42501 (insufficient_privilege / RLS violation) is deliberately absent.
 * RLS failures are security-relevant and must keep surfacing as 500 until they
 * are handled explicitly by the owning route.
 */
const CONSTRAINT_VIOLATION_MAP: Record<
  string,
  { status: number; code: string; error: string }
> = {
  // foreign_key_violation — referenced row does not exist
  "23503": {
    status: 422,
    code: "FOREIGN_KEY_VIOLATION",
    error: "Referenced resource does not exist.",
  },
  // unique_violation — duplicate / already-present row
  "23505": {
    status: 409,
    code: "CONFLICT",
    error: "Resource already exists.",
  },
  // not_null_violation — required field missing
  "23502": {
    status: 400,
    code: "NOT_NULL_VIOLATION",
    error: "Required field is missing.",
  },
  // check_violation — value rejected by a CHECK constraint
  "23514": {
    status: 400,
    code: "CHECK_VIOLATION",
    error: "Value is not allowed.",
  },
  // invalid_text_representation — e.g. malformed uuid / bad enum literal
  "22P02": {
    status: 400,
    code: "INVALID_INPUT",
    error: "Invalid input format.",
  },
};

/** True when the error is a database constraint / invalid-input violation. */
export function isConstraintViolation(error: unknown): boolean {
  return getConstraintViolationSpec(error) !== null;
}

/**
 * Build the HTTP response for a constraint violation, or null when the error is
 * not one. Response body never contains database internals.
 */
function toConstraintViolationResponse(error: unknown): {
  status: number;
  body: { error: string; code: string; details?: unknown };
} | null {
  const spec = getConstraintViolationSpec(error);
  if (!spec) return null;
  return { status: spec.status, body: { error: spec.error, code: spec.code } };
}

/** Look up the mapping entry for the error's SQLSTATE, if any. */
function getConstraintViolationSpec(
  error: unknown,
): { status: number; code: string; error: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  if (typeof code !== "string" || code.length === 0) return null;
  // Own-property check: a plain lookup would resolve inherited Object.prototype
  // keys ("constructor", "toString", "__proto__", ...) and produce a malformed
  // response instead of falling through to the 500 branch.
  return Object.hasOwn(CONSTRAINT_VIOLATION_MAP, code)
    ? CONSTRAINT_VIOLATION_MAP[code]
    : null;
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
