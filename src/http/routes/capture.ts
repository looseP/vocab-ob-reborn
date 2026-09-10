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
import { captureResponseSchema } from "../capture-response-contract";
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
    // Validate the response against the published contract before serialising.
    // `captureResponseSchema` already drives docs/api/openapi.json, but nothing
    // used to check a real payload against it — which is how l3Status stayed
    // frozen at the literal "deferred" while the runtime returned "captured".
    // A ZodError here surfaces as a 500 on purpose: a broken contract must fail
    // loudly rather than drift silently.
    return c.json(captureResponseSchema.parse(result), 201);
  });

  return app;
}
