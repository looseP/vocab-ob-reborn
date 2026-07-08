import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { errorToResponse, AppError } from "@/errors";
import { logger } from "@/observability/logger";

/**
 * Global error handler for Hono.
 *
 * Maps AppError subclasses to their declared HTTP status via
 * errorToResponse(). Unknown errors are logged and reduced to a
 * generic 500 to avoid leaking internals.
 */
export function handleError(err: Error, c: Context) {
  if (err instanceof AppError) {
    const { status, body } = errorToResponse(err);
    return c.json(body, status as ContentfulStatusCode);
  }

  logger.error("http", "Unhandled error", {
    message: err.message,
    stack: err.stack,
  });
  const { status, body } = errorToResponse(err);
  return c.json(body, status as ContentfulStatusCode);
}
