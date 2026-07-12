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
    return c.json(word);
  });

  return app;
}
