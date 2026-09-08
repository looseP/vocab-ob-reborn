/**
 * L3 导入域路由：raw-text / structured 两条 proposal-only 导入路径。
 * 自 2026-09-08 起 l3.ts 按资源域拆分（499/500 复杂度门禁触顶），路径与语义不变。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3RawTextImportCreateSchema,
  l3StructuredImportCreateSchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";
import { asJson } from "./shared";

export function importsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/imports/raw-text", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3RawTextImportCreateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Import.createRawTextImportProposal({
      userId: c.get("userId"),
      ...parsed.data,
      wordbookId: parsed.data.wordbookId ?? null,
      source: {
        ...parsed.data.source,
        author: parsed.data.source.author ?? null,
        url: parsed.data.source.url ?? null,
        language: parsed.data.source.language ?? null,
        metadata: asJson(parsed.data.source.metadata ?? {}),
      },
      targetWords: parsed.data.targetWords,
      options: parsed.data.options,
      provenance: asJson(parsed.data.provenance ?? {}),
    });
    return c.json(result, 201);
  });

  app.post("/imports/structured", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3StructuredImportCreateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Import.createStructuredImportProposal({
      userId: c.get("userId"),
      ...parsed.data,
      wordbookId: parsed.data.wordbookId ?? null,
      source: {
        ...parsed.data.source,
        author: parsed.data.source.author ?? null,
        url: parsed.data.source.url ?? null,
        language: parsed.data.source.language ?? null,
        metadata: asJson(parsed.data.source.metadata ?? {}),
      },
      contexts: parsed.data.contexts.map((context) => ({
        ...context,
        clientRef: context.clientRef ?? null,
        normalizedText: context.normalizedText ?? null,
        language: context.language ?? null,
        position: asJson(context.position ?? {}),
        metadata: asJson(context.metadata ?? {}),
        occurrences: context.occurrences.map((occurrence) => ({
          ...occurrence,
          lemma: occurrence.lemma ?? null,
          startOffset: occurrence.startOffset ?? null,
          endOffset: occurrence.endOffset ?? null,
          confidence: occurrence.confidence ?? null,
          evidence: asJson(occurrence.evidence ?? {}),
        })),
        links: context.links.map((link) => ({
          ...link,
          wordId: link.wordId ?? null,
          targetId: link.targetId ?? null,
          targetRef: asJson(link.targetRef ?? {}),
          confidence: link.confidence ?? null,
          provenance: asJson(link.provenance ?? {}),
        })),
      })),
      provenance: asJson(parsed.data.provenance ?? {}),
    });
    return c.json(result, 201);
  });

  return app;
}
