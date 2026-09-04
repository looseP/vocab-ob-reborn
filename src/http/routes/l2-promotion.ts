/**
 * L2 manual promotion HTTP route — Phase F 主动晋升入口.
 *
 * Split from routes/l2.ts to honor the route-complexity ratchet (l2.ts
 * line/route budget is frozen). Mounted at /api/l2 by http/server.ts.
 *
 * Semantics: skips the L1 stable-plateau gate (S≥21d ∧ ≥5 reviews ∧
 * good/easy) but keeps idempotency and the inheritance arithmetic —
 * 低 S 触底 1.0d floor。与自动晋升（outbox l2_transition effect）同一插入路径。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import { BusinessRuleError } from "@/errors";
import type { AppEnv } from "./words";

export function l2PromotionRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // POST /:slug/promote — 把当前用户默认词书中的该词立即晋升到 L2 轨。
  app.post("/:slug/promote", async (c) => {
    const userId = c.get("userId");
    const slug = c.req.param("slug");

    const { word } = await services.words.getWordBySlug(slug);
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const progress = await services.reviews.getProgressSnapshot(userId, wordbook.id, word.id);
    if (!progress) {
      // 无 L1 行则无继承来源——晋升前置条件是加入复习
      throw new BusinessRuleError("该词尚未加入复习，请先在词条库将其加入复习后再晋升");
    }

    const result = await services.l2Transition.promoteNow({
      user_id: userId,
      wordbook_id: wordbook.id,
      word_id: word.id,
      // 新卡 stability 可能为 null → 0（inherit floor 1.0d 兜底，语义与自动链路一致）
      stability: progress.stability ?? 0,
      difficulty: progress.difficulty,
      review_count: progress.review_count,
      last_rating: progress.last_rating,
    });
    return c.json({ ok: true, alreadyPromoted: result.alreadyPromoted, l2DueAt: result.l2DueAt });
  });

  return app;
}
