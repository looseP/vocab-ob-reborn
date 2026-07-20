/**
 * Review HTTP routes.
 *
 * Architecture constraint (dependency-cruiser enforced):
 * - http layer must NOT import @/db or @/repositories directly.
 * - All data access goes through the injected `services.reviews` service.
 *
 * Service method signatures (from ReviewService):
 *   submitAnswer(input, userId)   — userId from auth context
 *   skip(input, userId)           — userId from auth context
 *   suspend(input, userId)        — userId from auth context
 *   undo(input, userId)           — userId from auth context
 *
 * Routes:
 *   POST /answer    submit a review rating
 *   POST /skip      skip the current card
 *   POST /suspend   suspend a card
 *   POST /undo      undo the last review log entry
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import {
  reviewAnswerSchema,
  reviewSkipSchema,
  reviewSuspendSchema,
  reviewUndoSchema,
} from "@/schemas/http";
import { validationError } from "../error-response";

export function reviewRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // GET /queue — fetch review queue (due cards + today's session)
  app.get("/queue", async (c) => {
    const userId = c.get("userId");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const queue = await services.reviews.getQueue(userId, wordbook.id, limit);
    return c.json(queue);
  });

  app.post("/answer", async (c) => {
    const body = await c.req.json();
    const parsed = reviewAnswerSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const result = await services.reviews.submitAnswer(parsed.data, userId);
    return c.json(result);
  });

  app.post("/skip", async (c) => {
    const body = await c.req.json();
    const parsed = reviewSkipSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const result = await services.reviews.skip(parsed.data, userId);
    return c.json(result);
  });

  app.post("/suspend", async (c) => {
    const body = await c.req.json();
    const parsed = reviewSuspendSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const result = await services.reviews.suspend(parsed.data, userId);
    return c.json(result);
  });

  app.post("/undo", async (c) => {
    const body = await c.req.json();
    const parsed = reviewUndoSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const result = await services.reviews.undo(parsed.data, userId);
    return c.json(result);
  });

  return app;
}
