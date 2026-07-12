import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ApiErrorBody = {
  error: string;
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
};

export function jsonError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: unknown,
  extensions?: Record<string, unknown>,
) {
  const requestId = (c.get("requestId") as string | undefined) ?? randomUUID();
  c.header("X-Request-ID", requestId);
  const body: ApiErrorBody = {
    error: message,
    code,
    message,
    ...(details === undefined ? {} : { details }),
    requestId,
    ...extensions,
  };
  return c.json(body, status);
}

export function validationError(c: Context, details: unknown, message = "Invalid request") {
  return jsonError(c, 400, "VALIDATION_ERROR", message, details);
}
