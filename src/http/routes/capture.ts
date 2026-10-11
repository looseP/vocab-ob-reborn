/**
 * Capture HTTP routes (R1 reading capture).
 *
 * Architecture constraint (dependency-cruiser enforced):
 * - http layer must NOT import @/db or @/repositories directly.
 * - All data access goes through the injected `services.capture` service.
 *
 * Routes:
 *   POST /   capture a headword (+ optional sentence / source metadata)
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import { captureRequestSchema } from "@/schemas/http";
import { captureResponseSchema } from "../capture-response-contract";
import { validationError } from "../error-response";

export function captureRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const parsed = captureRequestSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const userId = c.get("userId");
    const wordbookId = parsed.data.wordbookId
      ?? (await services.wordbooks.getOrCreateDefault(userId)).id;
    const result = await services.capture.capture({
      userId,
      wordbookId,
      headword: parsed.data.headword,
      sentence: parsed.data.sentence,
      sourceUrl: parsed.data.sourceUrl,
      obsidianRef: parsed.data.obsidianRef,
    });
    // 入本即记流水（设计稿 2026-10-11 §5.1）：在捕获事务之外 best-effort 追加当日
    // 流水条目。两处刻意为之：① 不进捕获事务 —— appendEntry 撞 seq 唯一索引时需
    // 重开事务重试（Postgres 在 23505 后 abort 当前事务），塞进捕获事务会把入本
    // 一起拖回滚；② 失败吞掉 —— 记流水是账本便利，不该阻塞用户的入本动作
    // （与 L3 三件套 best-effort 同哲学）。
    let entrySeq: number | null = null;
    try {
      const entry = await services.dailyCapture.appendEntry({
        userId,
        entryType: "word",
        // 有原句记原句（账本价值最高），否则记词形（zod 已 trim）
        content: parsed.data.sentence ?? result.word.title,
        meta: {
          wordSlugs: [result.word.slug],
          ...(parsed.data.sourceUrl ? { sourceUrl: parsed.data.sourceUrl } : {}),
          ...(parsed.data.obsidianRef ? { obsidianRef: parsed.data.obsidianRef } : {}),
        },
      });
      entrySeq = entry.seq;
    } catch {
      // best-effort：留痕失败不阻塞入本（entrySeq 回 null，前端照常提示入本成功）
    }
    // Validate the response against the published contract before serialising.
    // `captureResponseSchema` already drives docs/api/openapi.json, but nothing
    // used to check a real payload against it — which is how l3Status stayed
    // frozen at the literal "deferred" while the runtime returned "captured".
    // A ZodError here surfaces as a 500 on purpose: a broken contract must fail
    // loudly rather than drift silently.
    return c.json(captureResponseSchema.parse({ ...result, entrySeq }), 201);
  });

  return app;
}
