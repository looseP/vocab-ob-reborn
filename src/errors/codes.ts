/**
 * Machine-readable error codes — the single export for every code that can
 * appear in an HTTP error response body (ADR-0029 §6③).
 *
 * Kept as code rather than a document: a document would rot, while this value
 * set is pinned by tests (and can be checked mechanically by gates such as
 * api:governance). No code literal is allowed anywhere else in src/errors/.
 */
export const ERROR_CODES = {
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  CONFLICT: "CONFLICT",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  BUSINESS_RULE: "BUSINESS_RULE",
  DB_UNAVAILABLE: "DB_UNAVAILABLE",
  INTERNAL: "INTERNAL",
  FOREIGN_KEY_VIOLATION: "FOREIGN_KEY_VIOLATION",
  NOT_NULL_VIOLATION: "NOT_NULL_VIOLATION",
  CHECK_VIOLATION: "CHECK_VIOLATION",
  INVALID_INPUT: "INVALID_INPUT",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
