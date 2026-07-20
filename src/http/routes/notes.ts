/**
 * Notes HTTP routes.
 *
 * Routes:
 *   GET  /           list user's notes
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";

export function noteRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // GET / — list user's notes
  app.get("/", async (c) => {
    const userId = c.get("userId");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const notes = await services.notes.listNotes(userId, limit, offset);
    return c.json({
      items: notes,
      total: notes.length,
    });
  });

  return app;
}
