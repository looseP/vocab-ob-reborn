/**
 * Wordbooks HTTP routes.
 *
 * Routes:
 *   GET  /                 list user's wordbooks
 *   GET  /default          get or create default wordbook
 *   POST /                 create a wordbook
 *   GET  /:id              wordbook detail (with word count)
 *   POST /:id/words        add words to a wordbook
 *
 * Route order matters: the static `/default` segment is registered before the
 * `/:id` parameter segment so it is never captured as an id.
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AuthRole, Principal } from "@/http/middleware/auth";
import { uuidSchema, wordbookAddWordsSchema, wordbookCreateSchema } from "@/schemas/http";
import { NotFoundError } from "@/errors";
import { validationError } from "../error-response";

export type AppEnv = {
  Variables: {
    role: AuthRole;
    userId: string;
    principal: Principal;
    requestId: string;
  };
};

function parseRouteUuid(value: string): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function wordbookRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // GET / — list user's wordbooks
  app.get("/", async (c) => {
    const userId = c.get("userId");
    const wordbooks = await services.wordbooks.findAllByUser(userId);
    return c.json({
      items: wordbooks.map((wb) => ({
        id: wb.id,
        name: wb.name,
        description: wb.description,
        isDefault: wb.isDefault,
      })),
      total: wordbooks.length,
    });
  });

  // GET /default — get or create default wordbook
  app.get("/default", async (c) => {
    const userId = c.get("userId");
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    return c.json({
      id: wordbook.id,
      name: wordbook.name,
      description: wordbook.description,
      isDefault: wordbook.isDefault,
    });
  });

  // POST / — create a wordbook
  app.post("/", async (c) => {
    const userId = c.get("userId");
    const parsed = wordbookCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const wordbook = await services.wordbooks.create({ userId, ...parsed.data });
    return c.json({
      id: wordbook.id,
      name: wordbook.name,
      description: wordbook.description,
      isDefault: wordbook.isDefault,
    }, 201);
  });

  // GET /:id — wordbook detail with word count
  app.get("/:id", async (c) => {
    const userId = c.get("userId");
    const wordbookId = parseRouteUuid(c.req.param("id"));
    if (!wordbookId) {
      return validationError(c, { fieldErrors: { id: ["Invalid uuid"] } });
    }
    const wordbook = await services.wordbooks.findById(userId, wordbookId);
    if (!wordbook) {
      throw new NotFoundError("Wordbook", wordbookId);
    }
    const wordCount = await services.wordbooks.getWordCount(userId, wordbookId);
    return c.json({
      id: wordbook.id,
      name: wordbook.name,
      description: wordbook.description,
      isDefault: wordbook.isDefault,
      wordCount,
    });
  });

  // POST /:id/words — add words to a wordbook
  app.post("/:id/words", async (c) => {
    const userId = c.get("userId");
    const wordbookId = parseRouteUuid(c.req.param("id"));
    if (!wordbookId) {
      return validationError(c, { fieldErrors: { id: ["Invalid uuid"] } });
    }
    const parsed = wordbookAddWordsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    // Ownership is resolved before the write so a foreign wordbook yields 404
    // instead of surfacing the RLS policy as an opaque 500.
    const wordbook = await services.wordbooks.findById(userId, wordbookId);
    if (!wordbook) {
      throw new NotFoundError("Wordbook", wordbookId);
    }
    await services.wordbooks.addWords(userId, wordbookId, parsed.data.wordIds);
    return c.json({ ok: true as const, added: parsed.data.wordIds.length });
  });

  return app;
}
