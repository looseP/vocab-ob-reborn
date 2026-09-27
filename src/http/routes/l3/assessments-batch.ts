/**
 * 评析批量读路由（2026-09-27）——从 `assessments.ts` 拆出，与
 * `annotations-withdraw.ts` 同款理由：单文件路由数/行数受复杂度棘轮冻结
 * （`scripts/verify-route-complexity.ts`），拆薄是既有做法而不是绕过门禁。
 *
 * GET /question-assessments?questionIds=<uuid,...>：本卷题目的评析。
 *
 * 存在理由是**计数**（S-1）：卷面父层要回答「这一卷有几条评析被纯净模式隐藏了」，
 * 而单题 GET（`/questions/:id/assessment`）只能一条条问、要 N 个请求。父层数不出
 * 条数就无法在「已隐藏 N 处」声明条里如实告知 ⇒ 那条登记在案的偏离就无法关闭。
 *
 * 归属：只返回读到的，不为「他人/不存在的题」报错（同注记批量口）。SQL 按
 * `user_id` 过滤 + RLS 隔离；批量读的语义是「这批题里有哪些评析」，不是
 * 「这批题是否都存在」。身份沿单题 GET：owner 可读，agent 可读（挂题不挂题纸）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3QuestionAssessmentListQuerySchema } from "@/schemas/http";
import { validationError } from "../../error-response";

export function questionAssessmentsBatchRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/question-assessments", async (c) => {
    const parsed = l3QuestionAssessmentListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Assessments.listForQuestions(c.get("userId"), parsed.data.questionIds));
  });

  return app;
}
