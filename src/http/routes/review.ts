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

export function reviewRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/answer", async (c) => {
    const body = await c.req.json();
    const parsed = reviewAnswerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const userId = c.get("userId");
    const result = await services.reviews.submitAnswer(parsed.data, userId);
    return c.json(result);
  });

  app.post("/skip", async (c) => {
    const body = await c.req.json();
    const parsed = reviewSkipSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const userId = c.get("userId");
    const result = await services.reviews.skip(parsed.data, userId);
    return c.json(result);
  });

  app.post("/suspend", async (c) => {
    const body = await c.req.json();
    const parsed = reviewSuspendSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const userId = c.get("userId");
    const result = await services.reviews.suspend(parsed.data, userId);
    return c.json(result);
  });

  app.post("/undo", async (c) => {
    const body = await c.req.json();
    const parsed = reviewUndoSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const userId = c.get("userId");
    const result = await services.reviews.undo(parsed.data, userId);
    return c.json(result);
  });

  return app;
}
