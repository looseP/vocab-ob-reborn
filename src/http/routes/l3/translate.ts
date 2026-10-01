/**
 * 翻译路由（2026-09-29）—— 两条路径，都在这里。
 *
 * ## 为什么要独立成文件、且由 server.ts 直挂
 *
 * `l3/contexts.ts` 与 `l3/index.ts` 都受**路由复杂度棘轮**冻结：以 git base 的
 * 实测复杂度为上限，不许增长（`scripts/verify-route-complexity.ts`
 * `baseSource ? measure(baseSource) : bootstrap`）。仓库对「父文件被冻结时怎么加
 * 端点」已有既定做法：新建薄路由文件、**server.ts 直挂**，绕开组合器 ——
 * `spaces.ts` / `annotations.ts` / `sheets-export.ts` / `sheets-archive.ts` /
 * `summary.ts` / `capabilities.ts` / `lists.ts` 全是这个先例。
 *
 * 第一次实现把 `/contexts/:id/translate` 放进了 `contexts.ts`、并把本文件挂进
 * `l3/index.ts`，结果正好撞门禁（27>25 行 / 138>123 行 / 9>8 路由）。改成现在
 * 这个形态后 `index.ts` 与 `contexts.ts` 回到 main 的规模，增长全部落在新文件上。
 *
 * ## 两条路径的分工
 *
 * - `POST /contexts/:id/translate` —— **带语境**：要 context id、要 RLS 身份、
 *   译文落 `l3_contexts.translation`。适合「这句我要留着」。
 * - `POST /translate-text` —— **无状态**：给什么翻什么，不要求语境存在、零持久化。
 *   适合「扫一眼，读完就走」（用户主用法）。
 *
 * 失败语义相同：provider 全挂仍返 200 + `warning` + 空译文。翻译是增强不是前提。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3TextTranslateSchema } from "@/schemas/http";
import { validationError } from "../../error-response";
import { invalidIdResponse, parseRouteUuid } from "./shared";

export function translateRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // 带语境：按需生成 + 落库缓存。手动触发，不做自动翻译。
  app.post("/contexts/:id/translate", async (c) => {
    const contextId = parseRouteUuid(c.req.param("id"));
    if (!contextId) return invalidIdResponse(c);
    const body = await c.req.json().catch(() => ({}));
    const result = await services.l3Context.translateContext({
      userId: c.get("userId"),
      contextId,
      targetLang: typeof body.targetLang === "string" ? body.targetLang : undefined,
      refresh: body.refresh === true,
    });
    return c.json(result);
  });

  // 无状态：划词即译。CSRF=none（同 POST 只读档），零写入。
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
