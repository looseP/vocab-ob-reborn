/**
 * Vocab-note import HTTP routes (P3).
 *
 * Architecture constraint (dependency-cruiser enforced):
 * - http layer must NOT import @/db or @/repositories directly.
 * - All data access goes through the injected `services.vocabImport` service.
 *
 * Routes:
 *   POST /vocab-notes   import L1 collection-note files (hash-guarded upsert)
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import { vocabNotesImportRequestSchema } from "@/schemas/http";
import { validationError } from "../error-response";

export function importRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/vocab-notes", async (c) => {
    const body = await c.req.json();
    const parsed = vocabNotesImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.vocabImport.importFiles(
      parsed.data.files.map((file) => ({
        path: file.path,
        content: file.content,
        updatedAt: file.updatedAt ?? null,
      })),
      {
        strictness: parsed.data.strictness,
        dryRun: parsed.data.dryRun,
      },
    );
    return c.json(result);
  });

  return app;
}
