/**
 * Capture HTTP routes (R1 reading capture).
 *
 * Architecture constraint (dependency-cruiser enforced):
 * - http layer must NOT import @/db or @/repositories directly.
 * - All data access goes through the injected `services.capture` service.
 *
 * Routes:
 *   POST /   capture a headword (+ optional sentence / source metadata)
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import { captureRequestSchema } from "@/schemas/http";
import { validationError } from "../error-response";

export function captureRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const parsed = captureRequestSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const wordbookId = parsed.data.wordbookId
      ?? (await services.wordbooks.getOrCreateDefault(userId)).id;
    const result = await services.capture.capture({
      userId,
      wordbookId,
      headword: parsed.data.headword,
      sentence: parsed.data.sentence,
      sourceUrl: parsed.data.sourceUrl,
      obsidianRef: parsed.data.obsidianRef,
    });
    return c.json(result, 201);
  });

  return app;
}
