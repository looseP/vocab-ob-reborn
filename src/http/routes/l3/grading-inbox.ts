/**
 * 待评卷清单路由（ADR-0038 决策 2）——**独立薄路由**。
 *
 * 为什么独立：`routes/l3/grading.ts` 与 `sheets-archive.ts` 均受复杂度棘轮冻结在
 * 基线，而本端点是**新面**（同 papers-update / papers-authoring 先例：拆模块，
 * 不抬基线）。
 *
 * GET /grading/pending-sheets  待评卷清单（**minRole=agent**）
 *
 * 授权判据（ADR-0029 决策 1「agent 读全量」+ 决策 6 的按面分级）：本面只给**身份与
 * 计数**——哪张题纸、可评几题、已评几题、何时定格、标题。**不含**题干、选项、答案、
 * 解析、作答、注记：取料走 `grading-context`（那里带答案，是 D8 的显式例外面）。
 * 相比开放 `GET /api/l3/sheets`（owner 的个人台面列表，含 draft）更小、更窄。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3PendingGradingQuerySchema } from "@/schemas/http";
import { validationError } from "../../error-response";

export function gradingInboxRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/grading/pending-sheets", async (c) => {
    const parsed = l3PendingGradingQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    return c.json(await services.l3Grading.listPendingGrading(c.get("userId"), parsed.data.limit));
  });

  return app;
}
