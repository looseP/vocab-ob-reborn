/**
 * Review HTTP routes.
 *
 * Architecture constraint (dependency-cruiser enforced):
 * - http layer must NOT import @/db or @/repositories directly.
 * - All data access goes through the injected `services.reviews` service.
 *
 * Service method signatures (from ReviewService):
 *   submitAnswer(input, userId)   — userId from auth context
 *   skip(input, userId)           — userId from auth context
 *   suspend(input, userId)        — userId from auth context
 *   undo(input, userId)           — userId from auth context
 *
 * Routes:
 *   POST /answer    submit a review rating
 *   POST /skip      skip the current card
 *   POST /suspend   suspend a card
 *   POST /undo      undo the last review log entry
 *   POST /cards     enqueue a word as a new L1 card (R0)
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import {
  addToReviewSchema,
  batchAddToReviewSchema,
  clearL1WeakSignalSchema,
  reviewAnswerSchema,
  reviewSkipSchema,
  reviewSuspendSchema,
  reviewUndoSchema,
} from "@/schemas/http";
import { validationError } from "../error-response";

export function reviewRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // GET /queue — fetch review queue (due cards + today's session)
  app.get("/queue", async (c) => {
    const userId = c.get("userId");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const mode = c.req.query("mode") === "cram" ? "cram" : c.req.query("mode") === "preview" ? "preview" : "review";
    // 自由复习勾选入口（P2）：wordIds 逗号分隔，按用户选定顺序浏览
    const wordIdsParam = c.req.query("wordIds");
    const wordIds = wordIdsParam ? wordIdsParam.split(",").filter(Boolean) : undefined;
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const queue = await services.reviews.getQueue(userId, wordbook.id, limit, mode, wordIds, offset);
    return c.json(queue);
  });

  // GET /drill/queue — cram 练习变体候选（cloze/definition 自测），纯读无副作用
  app.get("/drill/queue", async (c) => {
    const userId = c.get("userId");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const items = await services.reviews.getDrillCandidates(userId, wordbook.id, limit);
    return c.json({ items });
  });

  // GET /stats — review statistics
  app.get("/stats", async (c) => {
    const userId = c.get("userId");
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const stats = await services.reviews.getStats(userId, wordbook.id);
    return c.json(stats);
  });

  // GET /stats/dashboard — 仪表盘汇总统计（连续打卡/7d/30d/预测/评分分布）
  // 接线原项目 StatsService（StatsRepository 按 Asia/Shanghai 显示时区聚合）。
  app.get("/stats/dashboard", async (c) => {
    const userId = c.get("userId");
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const [summary, ratingDist] = await Promise.all([
      services.stats.getDashboardSummary(userId, wordbook.id),
      services.stats.getRatingDistribution(userId, wordbook.id),
    ]);
    return c.json({
      ...summary,
      ratingDist,
      forecast: services.stats.computeForecast(summary),
    });
  });

  // GET /leeches — words with high lapse count
  app.get("/leeches", async (c) => {
    const userId = c.get("userId");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const leeches = await services.reviews.getLeeches(userId, wordbook.id, limit);
    return c.json({ items: leeches, total: leeches.length });
  });

  // GET /timeline — recent review log entries
  app.get("/timeline", async (c) => {
    const userId = c.get("userId");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const timeline = await services.reviews.getTimeline(userId, wordbook.id, limit);
    return c.json({ items: timeline, total: timeline.length });
  });

  // GET /heatmap — daily review counts for heatmap
  app.get("/heatmap", async (c) => {
    const userId = c.get("userId");
    const days = Math.min(parseInt(c.req.query("days") ?? "365", 10) || 365, 730);
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const heatmap = await services.reviews.getHeatmap(userId, wordbook.id, days);
    return c.json({ items: heatmap });
  });

  app.post("/answer", async (c) => {
    const body = await c.req.json();
    const parsed = reviewAnswerSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const result = await services.reviews.submitAnswer(parsed.data, userId);
    return c.json(result);
  });

  app.post("/skip", async (c) => {
    const body = await c.req.json();
    const parsed = reviewSkipSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const result = await services.reviews.skip(parsed.data, userId);
    return c.json(result);
  });

  app.post("/suspend", async (c) => {
    const body = await c.req.json();
    const parsed = reviewSuspendSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const result = await services.reviews.suspend(parsed.data, userId);
    return c.json(result);
  });

  app.post("/undo", async (c) => {
    const body = await c.req.json();
    const parsed = reviewUndoSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const result = await services.reviews.undo(parsed.data, userId);
    return c.json(result);
  });

  // POST /weak-signal/clear — clear the L1 weak-signal flag for a word (P1-4)
  app.post("/weak-signal/clear", async (c) => {
    const body = await c.req.json();
    const parsed = clearL1WeakSignalSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const wordbookId = parsed.data.wordbookId
      ?? (await services.wordbooks.getOrCreateDefault(userId)).id;
    const result = await services.reviews.clearL1WeakSignal(
      { wordId: parsed.data.wordId, wordbookId },
      userId,
    );
    return c.json(result);
  });

  // POST /cards — enqueue a word as a new L1 card (R0)
  app.post("/cards", async (c) => {
    const body = await c.req.json();
    const parsed = addToReviewSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const wordbookId = parsed.data.wordbookId
      ?? (await services.wordbooks.getOrCreateDefault(userId)).id;
    const result = await services.reviews.enqueueCard(
      { wordId: parsed.data.wordId, wordbookId },
      userId,
    );
    return c.json(result, 201);
  });

  // POST /cards/batch — enqueue multiple words; duplicates count as skipped
  app.post("/cards/batch", async (c) => {
    const body = await c.req.json();
    const parsed = batchAddToReviewSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const wordbookId = parsed.data.wordbookId
      ?? (await services.wordbooks.getOrCreateDefault(userId)).id;
    const result = await services.reviews.enqueueCards(
      { wordIds: parsed.data.wordIds, wordbookId },
      userId,
    );
    return c.json(result);
  });

  return app;
}
