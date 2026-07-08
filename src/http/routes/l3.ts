/**
 * L3 context-space HTTP routes.
 *
 * HTTP stays thin: parse body/query, attach auth userId, call service only.
 */

import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import type { Json } from "@/domain";
import {
  l3ContextCreateSchema,
  l3ContextLinkCreateSchema,
  l3GraphQuerySchema,
  l3LimitCursorQuerySchema,
  l3OccurrenceCreateSchema,
  l3ProposalCreateSchema,
  l3ProposalListQuerySchema,
  l3ProposalRejectSchema,
  l3RawTextImportCreateSchema,
  l3RecommendationGenerateSchema,
  l3RecommendationListQuerySchema,
  l3RecommendationRejectSchema,
  l3SourceSpaceQuerySchema,
  l3SourceCreateSchema,
  l3StructuredImportCreateSchema,
  l3WordSpaceQuerySchema,
} from "@/schemas/http";

function asJson(value: unknown): Json {
  return value as Json;
}

export function l3Routes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/sources", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3SourceCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Context.createSource({
      userId: c.get("userId"),
      ...parsed.data,
      wordbookId: parsed.data.wordbookId ?? null,
      author: parsed.data.author ?? null,
      url: parsed.data.url ?? null,
      language: parsed.data.language ?? null,
      metadata: asJson(parsed.data.metadata ?? {}),
    });
    return c.json(result, 201);
  });

  app.post("/contexts", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3ContextCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Context.createContext({
      userId: c.get("userId"),
      ...parsed.data,
      normalizedText: parsed.data.normalizedText ?? null,
      language: parsed.data.language ?? null,
      position: asJson(parsed.data.position ?? {}),
      metadata: asJson(parsed.data.metadata ?? {}),
    });
    return c.json(result, 201);
  });

  app.post("/occurrences", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3OccurrenceCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Context.createOccurrence({
      userId: c.get("userId"),
      ...parsed.data,
      lemma: parsed.data.lemma ?? null,
      startOffset: parsed.data.startOffset ?? null,
      endOffset: parsed.data.endOffset ?? null,
      confidence: parsed.data.confidence ?? null,
      evidence: asJson(parsed.data.evidence ?? {}),
    });
    return c.json(result, 201);
  });

  app.post("/context-links", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3ContextLinkCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Context.createContextLink({
      userId: c.get("userId"),
      ...parsed.data,
      contextId: parsed.data.contextId ?? null,
      wordId: parsed.data.wordId ?? null,
      targetId: parsed.data.targetId ?? null,
      targetRef: asJson(parsed.data.targetRef ?? {}),
      confidence: parsed.data.confidence ?? null,
      provenance: asJson(parsed.data.provenance ?? {}),
    });
    return c.json(result, 201);
  });

  app.get("/contexts/:id", async (c) => {
    const result = await services.l3Read.getContextDetail({
      userId: c.get("userId"),
      contextId: c.req.param("id"),
    });
    return c.json(result);
  });

  app.get("/words/:slug/space", async (c) => {
    const parsed = l3WordSpaceQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Read.getWordSpace({
      userId: c.get("userId"),
      slug: c.req.param("slug"),
      wordbookId: parsed.data.wordbookId ?? null,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.get("/sources/:id/space", async (c) => {
    const parsed = l3SourceSpaceQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Read.getSourceSpace({
      userId: c.get("userId"),
      sourceId: c.req.param("id"),
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.get("/graph", async (c) => {
    const parsed = l3GraphQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Read.getGraph({
      userId: c.get("userId"),
      wordbookId: parsed.data.wordbookId ?? null,
      slug: parsed.data.slug ?? null,
      sourceId: parsed.data.sourceId ?? null,
      depth: parsed.data.depth,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.get("/words/:slug/contexts", async (c) => {
    const parsed = l3LimitCursorQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Context.listContextsForWord({
      userId: c.get("userId"),
      slug: c.req.param("slug"),
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.get("/sources/:id/contexts", async (c) => {
    const parsed = l3LimitCursorQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Context.listContextsForSource({
      userId: c.get("userId"),
      sourceId: c.req.param("id"),
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.post("/imports/raw-text", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3RawTextImportCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
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
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
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

  app.post("/proposals", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3ProposalCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Proposal.createProposal({
      userId: c.get("userId"),
      ...parsed.data,
      wordbookId: parsed.data.wordbookId ?? null,
      title: parsed.data.title ?? null,
      summary: parsed.data.summary ?? null,
      inputHash: parsed.data.inputHash ?? null,
      proposedBy: parsed.data.proposedBy ?? null,
      provenance: asJson(parsed.data.provenance ?? {}),
      items: parsed.data.items.map((item) => ({
        itemType: item.itemType,
        clientRef: item.clientRef ?? null,
        payload: asJson(item.payload),
      })),
    });
    return c.json(result, 201);
  });

  app.post("/recommendations/generate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3RecommendationGenerateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Recommendation.generateRecommendations({
      userId: c.get("userId"),
      wordbookId: parsed.data.wordbookId ?? null,
      mode: parsed.data.mode,
      seedSlug: parsed.data.seedSlug ?? null,
      limit: parsed.data.limit ?? null,
      horizonDays: parsed.data.horizonDays ?? null,
      dryRun: parsed.data.dryRun ?? null,
    });
    return c.json(result, 201);
  });

  app.get("/recommendations", async (c) => {
    const parsed = l3RecommendationListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Recommendation.listRecommendations({
      userId: c.get("userId"),
      status: parsed.data.status,
      recommendationType: parsed.data.recommendationType ?? null,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.get("/recommendations/:id", async (c) => {
    const result = await services.l3Recommendation.getRecommendation({
      userId: c.get("userId"),
      recommendationId: c.req.param("id"),
    });
    return c.json(result);
  });

  app.post("/recommendations/:id/accept", async (c) => {
    const result = await services.l3Recommendation.acceptRecommendation({
      userId: c.get("userId"),
      recommendationId: c.req.param("id"),
    });
    return c.json(result);
  });

  app.post("/recommendations/:id/reject", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3RecommendationRejectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Recommendation.rejectRecommendation({
      userId: c.get("userId"),
      recommendationId: c.req.param("id"),
      reviewNote: parsed.data.reviewNote ?? null,
    });
    return c.json(result);
  });

  app.get("/proposals", async (c) => {
    const parsed = l3ProposalListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Proposal.listProposals({
      userId: c.get("userId"),
      status: parsed.data.status,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    return c.json(result);
  });

  app.get("/proposals/:id", async (c) => {
    const result = await services.l3Proposal.getProposal({
      userId: c.get("userId"),
      proposalId: c.req.param("id"),
    });
    return c.json(result);
  });

  app.post("/proposals/:id/validate", async (c) => {
    const result = await services.l3Proposal.validateProposal({
      userId: c.get("userId"),
      proposalId: c.req.param("id"),
    });
    return c.json(result);
  });

  app.post("/proposals/:id/confirm", async (c) => {
    const result = await services.l3Proposal.confirmProposal({
      userId: c.get("userId"),
      proposalId: c.req.param("id"),
    });
    return c.json(result);
  });

  app.post("/proposals/:id/reject", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3ProposalRejectSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "VALIDATION_ERROR", details: parsed.error.flatten() }, 400);
    }
    const result = await services.l3Proposal.rejectProposal({
      userId: c.get("userId"),
      proposalId: c.req.param("id"),
      reviewNote: parsed.data.reviewNote ?? null,
    });
    return c.json(result);
  });

  return app;
}
