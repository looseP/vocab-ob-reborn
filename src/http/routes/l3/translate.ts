/**
 * 划词即译路由（2026-09-29）——**无状态**翻译。
 *
 * 与 `contextsRoutes` 里的 `/contexts/:id/translate` 的分工：
 * 那条以语境为主体（要 id、要 RLS、要落库），这条以文本为主体（给什么翻什么，
 * 零持久化）。用户「扫一眼译文」的用法属于后者。
 *
 * CSRF 策略 `none`：本端点不写任何表，因此不接受 sessionMutation。
 * 与 `POST /api/l3/practice-files/detail`（POST 只读）同一档。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3TextTranslateSchema } from "@/schemas/http";
import { validationError } from "../../error-response";

export function translateRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/translate-text", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = l3TextTranslateSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.translation.translateText({
      userId: c.get("userId"),
      text: parsed.data.text,
      targetLang: parsed.data.targetLang,
      sourceLang: parsed.data.sourceLang,
    });
    return c.json(result);
  });

  return app;
}
