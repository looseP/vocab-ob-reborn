/**
 * Wordbooks HTTP routes.
 *
 * Routes:
 *   GET  /           list user's wordbooks
 *   GET  /default    get or create default wordbook
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AuthRole, Principal } from "@/http/middleware/auth";

export type AppEnv = {
  Variables: {
    role: AuthRole;
    userId: string;
    principal: Principal;
    requestId: string;
  };
};

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

  return app;
}
