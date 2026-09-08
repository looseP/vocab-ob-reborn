/**
 * L2 candidate-pool HTTP routes — Phase G（Agent 候选流）.
 *
 * Split file to honor the route-complexity ratchet. Mounted at /api/l2.
 * Candidates are word_l2_content rows with is_active=false: written by the
 * MCP server (`propose_l2_content`), reviewed by the user in the word
 * detail composer panel (accept = activate + cache refresh + soft re-card).
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import { uuidSchema } from "@/schemas/http";
import { mapToStorageField, safeParseL2Content } from "@/schemas/service";
import { jsonError, validationError } from "../error-response";
import type { AppEnv } from "./words";

function parseUuid(value: string): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function l2CandidateRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // POST /:slug/candidates — MCP propose 入口：写入 is_active=false 候选行。
  // Body 兼容 confirm 的三种形态（document > items > content），field=example
  // 映射为 corpus。候选不出题、不进缓存，直到用户在 Composer 面板采纳。
  app.post("/:slug/candidates", async (c) => {
    const userId = c.get("userId");
    const slug = c.req.param("slug");
    const body = await c.req.json().catch(() => ({}));

    const storageField = mapToStorageField(body.field);
    if (storageField === null) {
      return jsonError(c, 400, "VALIDATION_ERROR", "Invalid field");
    }

    let content: unknown;
    if (body.document !== undefined && body.document !== null) {
      content = body.document;
    } else if (body.items !== undefined && body.items !== null) {
      // v1 条目的 provenance 必填；外部 Agent 通常不带——注入默认溯源，
      // 免得 MCP 调用方必须感知 provenance 细节（document 形态则原样尊重）。
      const items = Array.isArray(body.items) ? body.items : [];
      content = {
        schemaVersion: "l2-content-v1",
        field: body.field,
        items: items.map((item: unknown) =>
          item && typeof item === "object" && !Array.isArray(item) && (item as { provenance?: unknown }).provenance === undefined
            ? { ...(item as Record<string, unknown>), provenance: { source: "external_chat" } }
            : item,
        ),
      };
    } else {
      content = body.content;
    }

    const parsedContent = safeParseL2Content(storageField, content);
    if (!parsedContent.success) {
      // 附带首个 zod issue，外部 Agent 可以据此自纠（如 collocation 缺
      // evidence.rawPhrase 时直接指出）。
      const issues = (parsedContent.error as { issues?: Array<{ message: string }> } | null)?.issues;
      const issue = issues?.[0];
      return jsonError(
        c,
        400,
        "VALIDATION_ERROR",
        `Invalid content for field "${storageField}"${issue ? `: ${issue.message}` : ""}`,
      );
    }

    const source = typeof body.source === "string" && body.source.length > 0 ? body.source : "external_chat";
    const sourceRef = typeof body.sourceRef === "string" ? body.sourceRef : null;

    const { word } = await services.words.getWordBySlug(slug);
    try {
      const result = await services.l2content.proposeCandidates(word.id, storageField, content, {
        source,
        sourceRef,
        actorId: userId,
      });
      return c.json({ candidateId: result.candidateId, itemCount: result.itemCount });
    } catch (err) {
      if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "ValidationError") {
        return validationError(c, { errors: [(err as Error).message] });
      }
      throw err;
    }
  });

  // GET /:slug/candidates — 列出该词的全部待选候选
  app.get("/:slug/candidates", async (c) => {
    const userId = c.get("userId");
    const { word } = await services.words.getWordBySlug(c.req.param("slug"));
    const items = await services.l2content.listCandidates(word.id, userId);
    return c.json({
      items: items.map((candidate) => ({
        id: candidate.id,
        field: candidate.field,
        itemCount: candidate.items.length,
        items: candidate.items,
        source: candidate.source,
        createdAt: candidate.createdAt,
      })),
    });
  });

  // POST /:slug/candidates/:candidateId/accept — 采纳（可传 itemIndexes 只采纳勾选子集；mode=replace 时停用同字段旧行）
  app.post("/:slug/candidates/:candidateId/accept", async (c) => {
    const userId = c.get("userId");
    const slug = c.req.param("slug");
    const candidateId = parseUuid(c.req.param("candidateId"));
    if (!candidateId) {
      return validationError(c, { fieldErrors: { candidateId: ["Invalid uuid"] } });
    }
    const body = await c.req.json().catch(() => ({}));
    let itemIndexes: number[] | undefined;
    if (Array.isArray(body?.itemIndexes) && body.itemIndexes.length > 0) {
      const parsed: number[] = body.itemIndexes.map((v: unknown) => Number(v));
      if (parsed.some((n) => !Number.isInteger(n) || n < 0)) {
        return validationError(c, { fieldErrors: { itemIndexes: ["must be non-negative integers"] } });
      }
      itemIndexes = parsed;
    }
    const mode = body?.mode === "replace" ? "replace" : "append";
    const { word } = await services.words.getWordBySlug(slug);
    const result = await services.l2content.acceptCandidate(word.id, candidateId, itemIndexes, userId, mode);
    return c.json({ ok: true, itemCount: result.itemCount, replacedCount: result.replacedCount });
  });

  // POST /:slug/candidates/:candidateId/reject — 拒绝（硬删）
  app.post("/:slug/candidates/:candidateId/reject", async (c) => {
    const userId = c.get("userId");
    const slug = c.req.param("slug");
    const candidateId = parseUuid(c.req.param("candidateId"));
    if (!candidateId) {
      return validationError(c, { fieldErrors: { candidateId: ["Invalid uuid"] } });
    }
    const { word } = await services.words.getWordBySlug(slug);
    await services.l2content.rejectCandidate(word.id, candidateId, userId);
    return c.json({ ok: true });
  });

  // GET /:slug/l2-rows — 管理面板：行列出（active + retired，候选不在此列）
  app.get("/:slug/l2-rows", async (c) => {
    const userId = c.get("userId");
    const { word } = await services.words.getWordBySlug(c.req.param("slug"));
    const rows = await services.l2content.listContentRows(word.id, userId);
    return c.json(rows);
  });

  // POST /:slug/l2-rows/:rowId/deactivate — 停用生效行（转 retired 留档，重算缓存）
  app.post("/:slug/l2-rows/:rowId/deactivate", async (c) => {
    const userId = c.get("userId");
    const rowId = parseUuid(c.req.param("rowId"));
    if (!rowId) {
      return validationError(c, { fieldErrors: { rowId: ["Invalid uuid"] } });
    }
    const { word } = await services.words.getWordBySlug(c.req.param("slug"));
    await services.l2content.deactivateContentRow(word.id, rowId, userId);
    return c.json({ ok: true });
  });

  // DELETE /:slug/l2-rows/:rowId — 硬删内容行（active 或 retired），active 需重算缓存
  app.delete("/:slug/l2-rows/:rowId", async (c) => {
    const userId = c.get("userId");
    const rowId = parseUuid(c.req.param("rowId"));
    if (!rowId) {
      return validationError(c, { fieldErrors: { rowId: ["Invalid uuid"] } });
    }
    const { word } = await services.words.getWordBySlug(c.req.param("slug"));
    await services.l2content.deleteContentRow(word.id, rowId, userId);
    return c.json({ ok: true });
  });

  // DELETE /:slug/l2-rows/:rowId/items/:index — 条目化管理：移除单个生成单元
  // （一句话/一个搭配/一个词）。行内条目清空后整行自动转存档。active 需重算缓存。
  app.delete("/:slug/l2-rows/:rowId/items/:index", async (c) => {
    const userId = c.get("userId");
    const rowId = parseUuid(c.req.param("rowId"));
    const index = Number(c.req.param("index"));
    if (!rowId) {
      return validationError(c, { fieldErrors: { rowId: ["Invalid uuid"] } });
    }
    if (!Number.isInteger(index) || index < 0) {
      return validationError(c, { fieldErrors: { index: ["Invalid item index"] } });
    }
    const { word } = await services.words.getWordBySlug(c.req.param("slug"));
    const result = await services.l2content.removeContentRowItem(word.id, rowId, index, userId);
    return c.json({ ok: true, remaining: result.remaining, rowDeactivated: result.rowDeactivated });
  });

  // POST /:slug/l2-rows/:rowId/items/:index/hide — 条目化管理：隐藏单个生成单元
  // （数据保留在行内可恢复，退出展示与出题）。active 需重算缓存。
  app.post("/:slug/l2-rows/:rowId/items/:index/hide", async (c) => {
    const userId = c.get("userId");
    const rowId = parseUuid(c.req.param("rowId"));
    const index = Number(c.req.param("index"));
    if (!rowId) {
      return validationError(c, { fieldErrors: { rowId: ["Invalid uuid"] } });
    }
    if (!Number.isInteger(index) || index < 0) {
      return validationError(c, { fieldErrors: { index: ["Invalid item index"] } });
    }
    const { word } = await services.words.getWordBySlug(c.req.param("slug"));
    const result = await services.l2content.hideContentRowItem(word.id, rowId, index, userId);
    return c.json({ ok: true, remaining: result.remaining, hiddenCount: result.hiddenCount });
  });

  // POST /:slug/l2-rows/:rowId/hidden/:index/restore — 条目化管理：恢复已隐藏的生成单元
  app.post("/:slug/l2-rows/:rowId/hidden/:index/restore", async (c) => {
    const userId = c.get("userId");
    const rowId = parseUuid(c.req.param("rowId"));
    const index = Number(c.req.param("index"));
    if (!rowId) {
      return validationError(c, { fieldErrors: { rowId: ["Invalid uuid"] } });
    }
    if (!Number.isInteger(index) || index < 0) {
      return validationError(c, { fieldErrors: { index: ["Invalid hidden index"] } });
    }
    const { word } = await services.words.getWordBySlug(c.req.param("slug"));
    const result = await services.l2content.restoreContentRowItem(word.id, rowId, index, userId);
    return c.json({ ok: true, remaining: result.remaining, hiddenCount: result.hiddenCount });
  });

  return app;
}
