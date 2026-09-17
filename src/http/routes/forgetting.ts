/**
 * One-click forgetting HTTP routes (ADR-0020).
 *
 * 独立前缀 /api/forgetting。HTTP 薄层：解析 body/query、附加 auth userId、只调
 * service。"遗忘 = 挂起"（永不删除/重置）；apply 的 confirmedAnchorIds 是 uuid
 * 数组，陈旧清单由 service 抛 422（路由层只做形状校验）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "./words";
import {
  forgettingApplySchema,
  forgettingPreviewQuerySchema,
  forgettingRestoreSchema,
} from "@/schemas/http";
import { validationError } from "../error-response";

export function forgettingRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // GET /preview — 零写入预览：锚点候选 + 将要挂起的行数。
  app.get("/preview", async (c) => {
    const parsed = forgettingPreviewQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.forgetting.preview({
      userId: c.get("userId"),
      bookId: parsed.data.bookId,
    });
    return c.json(result);
  });

  // POST /apply — 应用遗忘（用户确认锚点集；单事务 L1 挂起 + L2 暂停）。
  app.post("/apply", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = forgettingApplySchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.forgetting.apply({
      userId: c.get("userId"),
      bookId: parsed.data.bookId,
      confirmedAnchorIds: parsed.data.confirmedAnchorIds,
    });
    return c.json(result);
  });

  // POST /restore — 按批次回滚（批次不存在 → 404）。
  app.post("/restore", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = forgettingRestoreSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.forgetting.restore({
      userId: c.get("userId"),
      bookId: parsed.data.bookId,
      batchId: parsed.data.batchId,
    });
    return c.json(result);
  });

  return app;
}
