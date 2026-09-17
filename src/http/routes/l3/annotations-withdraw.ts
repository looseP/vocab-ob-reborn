/**
 * 注记撤回路由（v2 §4.7，ADR-0034 增补条 7）——独立薄路由：
 * annotations.ts 受复杂度棘轮约束（已登记文件不许比 base 增长），沿
 * capabilities/sheets-export 先例拆分并由 http/server.ts 直挂。
 *
 * POST /question-annotations/:id/withdraw：submitted→draft + 重挂题纸
 * （sheetId 缺省时 service 借原纸作用域幂等开纸），下次定格随新题纸重新升格。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3QuestionAnnotationWithdrawSchema } from "@/schemas/http";
import { validationError } from "../../error-response";

export function annotationsWithdrawRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.post("/question-annotations/:id/withdraw", async (c) => {
    const parsed = l3QuestionAnnotationWithdrawSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.l3Annotations.withdrawAnnotation({
      userId: c.get("userId"),
      id: c.req.param("id"),
      ...parsed.data,
    });
    return c.json(result);
  });

  return app;
}
