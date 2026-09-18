/**
 * 作文子空间 · 反馈路由（W6，ADR《writing-workspace》§6）。
 *
 * GET /tasks/:taskId/sheets/:sheetId/feedback           反馈读取（pending/ready）
 * GET /tasks/:taskId/sheets/:sheetId/feedback-context   agent 评阅上下文（owner+agent）
 * PUT /tasks/:taskId/sheets/:sheetId/feedback           反馈写入（owner+agent）
 *
 * 身份：lastEditor 由服务端 Principal 认定（bearer agentId ?? "owner"）——
 * 请求体不携带该字段（strict 拒越权键）。
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AppEnv } from "../words";
import { l3WritingFeedbackPutSchema } from "@/schemas/http";
import { WRITING_FEEDBACK_BYTES_MAX } from "@/domain/l3-writing";
import { jsonError, validationError } from "../../error-response";

export function writingFeedbackRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get("/tasks/:taskId/sheets/:sheetId/feedback", async (c) => {
    return c.json(await services.l3WritingFeedback.getFeedback(
      c.get("userId"),
      c.req.param("taskId"),
      c.req.param("sheetId"),
    ));
  });

  app.get("/tasks/:taskId/sheets/:sheetId/feedback-context", async (c) => {
    return c.json(await services.l3WritingFeedback.getContext(
      c.get("userId"),
      c.req.param("taskId"),
      c.req.param("sheetId"),
    ));
  });

  app.put("/tasks/:taskId/sheets/:sheetId/feedback", async (c) => {
    // 64KiB 上限在**完整解析前**生效：① 声明长度快闸（真实 HTTP 请求）；② 实测
    // 字节闸（流式/无声明长度兜底，先读原文再量——上限由全局 1MiB bodyLimit 兜底）；
    // 服务层 validated 体积校验为第二道防线。
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > WRITING_FEEDBACK_BYTES_MAX) {
      return jsonError(c, 413, "PAYLOAD_TOO_LARGE", "Feedback body exceeds the 64KiB limit");
    }
    const rawText = await c.req.text().catch(() => "");
    if (new TextEncoder().encode(rawText).byteLength > WRITING_FEEDBACK_BYTES_MAX) {
      return jsonError(c, 413, "PAYLOAD_TOO_LARGE", "Feedback body exceeds the 64KiB limit");
    }
    let body: unknown = {};
    try {
      body = rawText ? JSON.parse(rawText) : {};
    } catch {
      body = {};
    }
    const parsed = l3WritingFeedbackPutSchema.safeParse(body);
    if (!parsed.success) return validationError(c, parsed.error.flatten());
    const editor = c.get("principal").agentId ?? "owner";
    return c.json(await services.l3WritingFeedback.putFeedback(
      c.get("userId"),
      c.req.param("taskId"),
      c.req.param("sheetId"),
      parsed.data,
      editor,
    ));
  });

  return app;
}
