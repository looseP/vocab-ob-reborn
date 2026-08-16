/**
 * Words HTTP routes.
 *
 * Architecture constraint (dependency-cruiser enforced):
 * - http layer must NOT import @/db or @/repositories directly.
 * - All data access goes through the injected `services.words` service.
 *
 * Routes:
 *   GET  /              list words (validated via wordsQuerySchema)
 *   GET  /:slug         fetch a single word by slug
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AuthRole, Principal } from "@/http/middleware/auth";
import { wordsQuerySchema } from "@/schemas/http";
import { validationError } from "../error-response";

export type AppEnv = {
  Variables: {
    role: AuthRole;
    userId: string;
    principal: Principal;
    requestId: string;
  };
};

export function wordRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // POST /batch — bulk import words
  app.post("/batch", async (c) => {
    const body = await c.req.json();
    const words = body?.words;
    if (!Array.isArray(words) || words.length === 0) {
      return c.json({ error: "words array is required" }, 400);
    }
    if (words.length > 500) {
      return c.json({ error: "max 500 words per batch" }, 400);
    }
    const sanitized = words.slice(0, 500).map((w: Record<string, unknown>) => ({
      slug: String(w.slug ?? w.lemma ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      title: String(w.title ?? w.lemma ?? ""),
      lemma: String(w.lemma ?? w.title ?? ""),
      pos: w.pos ? String(w.pos) : null,
      cefr: w.cefr ? String(w.cefr) : null,
      ipa: w.ipa ? String(w.ipa) : null,
      short_definition: w.short_definition ? String(w.short_definition) : null,
    })).filter((w: { slug: string }) => w.slug.length > 0);
    const result = await services.words.batchCreate(sanitized);
    return c.json(result);
  });

  // GET / — paginated/filtered word list
  app.get("/", async (c) => {
    const parsed = wordsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.words.getPublicWords({
      ...parsed.data,
      userId: c.get("userId"),
    });
    return c.json(result);
  });

  // GET /:slug — single word lookup; NotFoundError thrown by the service
  // is mapped to 404 by the global handleError middleware.
  app.get("/:slug", async (c) => {
    const { word } = await services.words.getWordBySlug(c.req.param("slug"));
    return c.json(word.toDetail());
  });

  return app;
}
