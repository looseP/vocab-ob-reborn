/**
 * Words HTTP routes.
 *
 * Architecture constraint (dependency-cruiser enforced):
 * - http layer must NOT import @/db or @/repositories directly.
 * - All data access goes through the injected `services.words` service.
 *
 * Routes:
 *   GET  /              list words (validated via wordsQuerySchema)
 *   GET  /:slug         fetch a single word by slug
 */
import { Hono } from "hono";
import type { Services } from "@/services";
import type { AuthRole, Principal } from "@/http/middleware/auth";
import { noteEntryUpsertRequestSchema, wordsQuerySchema, wordSuggestQuerySchema } from "@/schemas/http";
import { validationError } from "../error-response";

export type AppEnv = {
  Variables: {
    role: AuthRole;
    userId: string;
    principal: Principal;
    requestId: string;
  };
};

export function wordRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  // POST /batch — bulk import words
  app.post("/batch", async (c) => {
    const body = await c.req.json();
    const words = body?.words;
    if (!Array.isArray(words) || words.length === 0) {
      return c.json({ error: "words array is required" }, 400);
    }
    if (words.length > 500) {
      return c.json({ error: "max 500 words per batch" }, 400);
    }
    const sanitized = words.slice(0, 500).map((w: Record<string, unknown>) => ({
      slug: String(w.slug ?? w.lemma ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      title: String(w.title ?? w.lemma ?? ""),
      lemma: String(w.lemma ?? w.title ?? ""),
      pos: w.pos ? String(w.pos) : null,
      cefr: w.cefr ? String(w.cefr) : null,
      ipa: w.ipa ? String(w.ipa) : null,
      short_definition: w.short_definition ? String(w.short_definition) : null,
    })).filter((w: { slug: string }) => w.slug.length > 0);
    const result = await services.words.batchCreate(sanitized);
    return c.json(result);
  });

  // GET / — paginated/filtered word list
  app.get("/", async (c) => {
    const parsed = wordsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const result = await services.words.getPublicWords({
      ...parsed.data,
      userId: c.get("userId"),
    });
    return c.json(result);
  });

  // GET /suggest — 输入联想（L1-2）：lemma / 拼音前缀 top-N。
  // 注意：必须注册在 GET /:slug 之前，否则 "/suggest" 会被当作 slug 命中。
  app.get("/suggest", async (c) => {
    const parsed = wordSuggestQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const items = await services.words.suggestWords(parsed.data.q, parsed.data.limit);
    return c.json({ items });
  });

  // GET /:slug — single word lookup; NotFoundError thrown by the service
  // is mapped to 404 by the global handleError middleware.
  // l2_promoted：当前用户是否已为该词晋升 L2 行（详情页"待扩展"提示）。
  app.get("/:slug", async (c) => {
    const userId = c.get("userId");
    const { word, l2Promoted } = await services.words.getWordBySlug(c.req.param("slug"), userId);
    return c.json({ ...word.toDetail(), l2_promoted: l2Promoted });
  });

  // GET /:slug/notes — 词的笔记条目(含已隐藏,详情页条目管理用)。
  // 条目制(2026-09-06):追加式写入,无版本链;hidden_at 非空 = 已隐藏。
  app.get("/:slug/notes", async (c) => {
    const userId = c.get("userId");
    const { word } = await services.words.getWordBySlug(c.req.param("slug"));
    const wordbook = await services.wordbooks.getOrCreateDefault(userId);
    const entries = await services.noteEntries.getEntries(userId, word.id, wordbook.id);
    // pg 驱动对 timestamptz 返回 Date 对象(类型标注为 string),new Date 两者兼容
    const toIso = (value: string | null) => (value ? new Date(value).toISOString() : null);
    return c.json({
      entries: entries.map((e) => ({
        id: e.id,
        content_md: e.content_md,
        hidden_at: toIso(e.hidden_at),
        created_at: toIso(e.created_at),
        updated_at: toIso(e.updated_at),
      })),
      hidden_count: entries.filter((e) => e.hidden_at !== null).length,
    });
  });

  // POST /:slug/notes/entries — 快记/添加一条笔记条目(追加式,无覆盖冲突)
  app.post("/:slug/notes/entries", async (c) => {
    const userId = c.get("userId");
    const parsed = noteEntryUpsertRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const { word } = await services.words.getWordBySlug(c.req.param("slug"));
    const entry = await services.noteEntries.addEntry(userId, word.id, parsed.data.content_md);
    return c.json({
      entry: {
        id: entry.id,
        content_md: entry.content_md,
        hidden_at: null,
        created_at: new Date(entry.created_at).toISOString(),
        updated_at: new Date(entry.updated_at).toISOString(),
      },
    }, 201);
  });

  // PUT /:slug/notes/entries/:entryId — 编辑单条内容(详情页)
  app.put("/:slug/notes/entries/:entryId", async (c) => {
    const userId = c.get("userId");
    const parsed = noteEntryUpsertRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return validationError(c, parsed.error.flatten());
    }
    const entry = await services.noteEntries.editEntry(userId, c.req.param("entryId"), parsed.data.content_md);
    return c.json({
      entry: {
        id: entry.id,
        content_md: entry.content_md,
        hidden_at: entry.hidden_at ? new Date(entry.hidden_at).toISOString() : null,
        created_at: new Date(entry.created_at).toISOString(),
        updated_at: new Date(entry.updated_at).toISOString(),
      },
    });
  });

  // DELETE /:slug/notes/entries/:entryId — 硬删除(破坏性,详情页专属,前端确认保护)
  app.delete("/:slug/notes/entries/:entryId", async (c) => {
    const userId = c.get("userId");
    await services.noteEntries.deleteEntry(userId, c.req.param("entryId"));
    return c.json({ ok: true });
  });

  // POST /:slug/notes/entries/:entryId/hide — 非破坏隐藏(翻卡面/详情页)
  app.post("/:slug/notes/entries/:entryId/hide", async (c) => {
    const userId = c.get("userId");
    const entry = await services.noteEntries.hideEntry(userId, c.req.param("entryId"));
    return c.json({
      entry: {
        id: entry.id,
        content_md: entry.content_md,
        hidden_at: entry.hidden_at ? new Date(entry.hidden_at).toISOString() : null,
        created_at: new Date(entry.created_at).toISOString(),
        updated_at: new Date(entry.updated_at).toISOString(),
      },
    });
  });

  // POST /:slug/notes/entries/:entryId/restore — 恢复已隐藏条目
  app.post("/:slug/notes/entries/:entryId/restore", async (c) => {
    const userId = c.get("userId");
    const entry = await services.noteEntries.restoreEntry(userId, c.req.param("entryId"));
    return c.json({
      entry: {
        id: entry.id,
        content_md: entry.content_md,
        hidden_at: entry.hidden_at ? new Date(entry.hidden_at).toISOString() : null,
        created_at: new Date(entry.created_at).toISOString(),
        updated_at: new Date(entry.updated_at).toISOString(),
      },
    });
  });

  return app;
}
