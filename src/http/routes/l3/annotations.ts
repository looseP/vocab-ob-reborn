/**
 * 做题注记（原文分析条目）与规律标签字典路由（批次一，0033）。
 *
 * 独立薄路由：l3/index.ts 组合器受复杂度棘轮冻结（同 papers/spaces 先例），
 * 由 http/server.ts 直挂。:id 不做 uuid 预校验，不存在/非属主统一由 service
 * 转 404。POST 锚点幂等命中返回 200，新建返回 201；DELETE 为软删 204。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import {
  l3AnnotationTagDictSchema,
  l3QuestionAnnotationCreateSchema,
  l3QuestionAnnotationListQuerySchema,
  l3QuestionAnnotationPatchSchema,
} from "@/schemas/http";
import { validationError } from "../../error-response";

export function annotationsRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/question-annotations", async (c) => {
    const parsed = l3QuestionAnnotationListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Annotations.listForQuestions(c.get("userId"), parsed.data.questionIds));
  });

  app.post("/question-annotations", async (c) => {
    const parsed = l3QuestionAnnotationCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.l3Annotations.createAnnotation({ userId: c.get("userId"), ...parsed.data });
    return c.json({ item: result.item }, result.idempotent ? 200 : 201);
  });

  app.patch("/question-annotations/:id", async (c) => {
    const parsed = l3QuestionAnnotationPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const result = await services.l3Annotations.patchAnnotation({
      userId: c.get("userId"),
      id: c.req.param("id"),
      ...parsed.data,
    });
    return c.json(result);
  });

  app.delete("/question-annotations/:id", async (c) => {
    await services.l3Annotations.deleteAnnotation(c.get("userId"), c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/annotation-tags", async (c) => {
    return c.json(await services.l3Annotations.getTagDict(c.get("userId")));
  });

  app.put("/annotation-tags", async (c) => {
    const parsed = l3AnnotationTagDictSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Annotations.replaceTagDict({ userId: c.get("userId"), ...parsed.data }));
  });

  return app;
}
