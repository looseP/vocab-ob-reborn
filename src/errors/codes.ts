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
  /**
   * 葫芦页结算：`total` 与本页存活词数不符（D1 / 修订轮 R11）。
   *
   * 与 VALIDATION_ERROR 分开的理由：这不是「客户端提交错了」，而是**页内词集
   * 已变化**（定格词被上架/下架）—— 客户端手里的 total 在取页之后过期了。
   * 给稳定码后前端可以自动重取本页，而不是把用户丢到错误页。HTTP 仍 422。
   */
  HULU_PAGE_ALIVE_MISMATCH: "HULU_PAGE_ALIVE_MISMATCH",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
