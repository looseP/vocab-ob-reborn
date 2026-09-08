/**
 * L3 推荐域路由：generate/list/get/accept/reject。
 * 自 2026-09-08 起 l3.ts 按资源域拆分（499/500 复杂度门禁触顶），路径与语义不变。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3RecommendationGenerateSchema,
  l3RecommendationListQuerySchema,
  l3RecommendationRejectSchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";

export function recommendationsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/recommendations/generate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3RecommendationGenerateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
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
      return validationError(c, parsed.error.flatten());
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
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.l3Recommendation.rejectRecommendation({
      userId: c.get("userId"),
      recommendationId: c.req.param("id"),
      reviewNote: parsed.data.reviewNote ?? null,
    });
    return c.json(result);
  });

  return app;
}
