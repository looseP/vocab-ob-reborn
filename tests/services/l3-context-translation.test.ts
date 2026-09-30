/// <reference lib="dom" />
// @vitest-environment node

/**
 * `L3ContextService.translateContext` —— 缓存语义（2026-09-29）。
 *
 * 翻译是**唯一**一个「外部依赖随时可能消失」的功能，所以它的正确性不在
 * 「能不能翻出来」，而在**端点消失后已读过的内容还在不在**。这些用例锁的
 * 就是那件事：
 *
 * 1. 首次调用走 provider 并**落库**（此后免费离线）。
 * 2. 二次调用命中缓存，**不再触碰 provider**（provider 全挂也不影响）。
 * 3. `refresh: true` 强制重翻（provider 挂了则**保留旧译文**）。
 * 4. provider 全挂时**不动数据库**、返回 warning，不抛。
 * 5. 译文与来源成对写入（DB CHECK 的前置保证）。
 * 6. 他人的 context → NotFound（owner 隔离，不能借翻译接口探测存在性）。
 */

import { describe, expect, it, vi } from "vitest";
import { L3ContextService } from "@/services/l3-context.service";
import { NotFoundError } from "@/errors";
import type { L3ContextRow } from "@/domain";
import type { IL3ContextRepository } from "@/repositories/interfaces";
import type { TranslationProvider } from "@/translation";

const USER = "u1";
const CTX = "ctx-1";

function row(over: Partial<L3ContextRow> = {}): L3ContextRow {
  return {
    id: CTX,
    source_id: "src-1",
    user_id: USER,
    context_type: "sentence",
    text: "The court ruled that the defendant had violated the terms.",
    normalized_text: null,
    language: "en",
    translation: null,
    translation_src: null,
    position: {},
    metadata: {},
    created_at: "2026-09-29T00:00:00Z",
    updated_at: "2026-09-29T00:00:00Z",
    ...over,
  };
}

function harness(opts: { context?: L3ContextRow | null } = {}) {
  const stored = { current: opts.context === undefined ? row() : opts.context };
  const setTranslation = vi.fn(async (userId: string, contextId: string, translation: string | null, source: string | null) => {
    if (stored.current?.user_id !== userId || stored.current?.id !== contextId) return null;
    stored.current = { ...stored.current, translation, translation_src: source };
    return stored.current;
  });
  const lock = vi.fn(async (userId: string, contextId: string) =>
    stored.current && stored.current.user_id === userId && stored.current.id === contextId ? stored.current : null);

  const repo = { lockContextByIdForUser: lock, setContextTranslation: setTranslation } as unknown as IL3ContextRepository;

  const providers: TranslationProvider[] = [];
  // 记录事务入参：`translateContext` **必须**走 withActorRepository，即把
  // { actorId } 传给事务 —— RLS 依此设置 auth.uid()。漏掉它 owner-RLS 会把
  // 用户自己的行也过滤掉，表现为「刚创建的 context 却报 NotFound」
  // （2026-09-29 真机实测踩到；纯 mock 测不出来，因为 mock 不带 RLS）。
  const txRunner = (<T,>(callback: (tx: unknown) => Promise<T>, options?: { actorId?: string }) => {
    seenActorIds.push(options?.actorId);
    return callback({});
  }) as never;
  const seenActorIds: (string | undefined)[] = [];
  const repositoryFactory = (() => ({ l3Context: repo })) as never;
  const service = new L3ContextService(
    repo as never, undefined, txRunner, repositoryFactory, providers,
  );
  return { service, providers, stored, setTranslation, lock, seenActorIds };
}

const provider = (id: string, result: { text: string; warning?: string }): TranslationProvider => ({
  id,
  translate: vi.fn(async () => ({ provider: id, ...result })),
});

describe("translateContext · 缓存即价值", () => {
  it("事务必须带 actorId（RLS 身份）—— 否则自己的行也查不到", async () => {
    const h = harness();
    h.providers.push(provider("google-web", { text: "译文" }));
    await h.service.translateContext({ userId: USER, contextId: CTX });
    // 回归锁：2026-09-29 真机实测「刚 quick-context 建的 context 立刻 translate
    // 却报 NotFound」—— 根因是绕过 withActorRepository 直接 txRunner，RLS 无身份。
    expect(h.seenActorIds).toContain(USER);
  });

  it("首次：调 provider 并落库（译文 + 来源成对）", async () => {
    const h = harness();
    h.providers.push(provider("google-web", { text: "法院裁定被告违反了协议条款。" }));

    const r = await h.service.translateContext({ userId: USER, contextId: CTX });
    expect(r.translation).toBe("法院裁定被告违反了协议条款。");
    expect(r.cached).toBe(false);
    expect(r.provider).toBe("google-web");
    // 落库：两列同时写，满足 l3_contexts_translation_check
    expect(h.setTranslation).toHaveBeenCalledWith(USER, CTX, "法院裁定被告违反了协议条款。", "google-web");
    expect(h.stored.current?.translation).toBe("法院裁定被告违反了协议条款。");
    expect(h.stored.current?.translation_src).toBe("google-web");
  });

  it("二次：命中缓存，provider 一次都不碰（哪怕它已失效）", async () => {
    const p = provider("google-web", { text: "译文" });
    const h = harness({ context: row({ translation: "已缓存译文", translation_src: "google-web" }) });
    h.providers.push(p);

    const r = await h.service.translateContext({ userId: USER, contextId: CTX });
    expect(r.translation).toBe("已缓存译文");
    expect(r.cached).toBe(true);
    expect(p.translate).not.toHaveBeenCalled();
    expect(h.setTranslation).not.toHaveBeenCalled();
  });

  it("端点全挂时，已缓存的语境仍然可读（这正是缓存的意义）", async () => {
    const dead: TranslationProvider = { id: "dead", translate: async () => ({ text: "", provider: "dead", warning: "gone" }) };
    const h = harness({ context: row({ translation: "离线译文", translation_src: "google-web" }) });
    h.providers.push(dead);

    const r = await h.service.translateContext({ userId: USER, contextId: CTX });
    expect(r.translation).toBe("离线译文");
    expect(r.cached).toBe(true);
  });
});

describe("translateContext · 失败语义", () => {
  it("provider 全挂：无缓存时返回空 + warning，不抛", async () => {
    const h = harness();
    h.providers.push({ id: "dead", translate: async () => ({ text: "", provider: "dead", warning: "gone" }) });

    const r = await h.service.translateContext({ userId: USER, contextId: CTX });
    expect(r.translation).toBe("");
    expect(r.warning).toBeTruthy();
    expect(h.setTranslation).not.toHaveBeenCalled();
  });

  it("refresh 时 provider 挂掉 → 保留旧译文，不清空", async () => {
    const h = harness({ context: row({ translation: "旧译文", translation_src: "google-web" }) });
    h.providers.push({ id: "dead", translate: async () => ({ text: "", provider: "dead", warning: "gone" }) });

    const r = await h.service.translateContext({ userId: USER, contextId: CTX, refresh: true });
    // 关键：译文没丢
    expect(r.translation).toBe("旧译文");
    expect(h.stored.current?.translation).toBe("旧译文");
    // 且没有把 DB 改成空
    expect(h.setTranslation).not.toHaveBeenCalled();
  });

  it("refresh 成功 → 覆盖旧译文", async () => {
    const h = harness({ context: row({ translation: "旧译文", translation_src: "google-web" }) });
    h.providers.push(provider("mymemory", { text: "新译文" }));

    const r = await h.service.translateContext({ userId: USER, contextId: CTX, refresh: true });
    expect(r.translation).toBe("新译文");
    expect(r.cached).toBe(false);
    expect(h.stored.current?.translation).toBe("新译文");
  });

  it("自动降级：Google 挂 → MyMemory 顶上，落库来源记 mymemory", async () => {
    const h = harness();
    h.providers.push(
      { id: "google-web", translate: async () => ({ text: "", provider: "google-web", warning: "404" }) },
      provider("mymemory", { text: "备胎译文" }),
    );
    const r = await h.service.translateContext({ userId: USER, contextId: CTX });
    expect(r.translation).toBe("备胎译文");
    expect(r.provider).toBe("mymemory");
    expect(h.setTranslation).toHaveBeenCalledWith(USER, CTX, "备胎译文", "mymemory");
  });
});

describe("translateContext · 边界与隔离", () => {
  it("他人的 context → NotFound（不泄漏存在性）", async () => {
    const h = harness({ context: row({ user_id: "someone-else" }) });
    h.providers.push(provider("google-web", { text: "译文" }));
    await expect(h.service.translateContext({ userId: USER, contextId: CTX })).rejects.toBeInstanceOf(NotFoundError);
    expect(h.setTranslation).not.toHaveBeenCalled();
  });

  it("context 不存在 → NotFound", async () => {
    const h = harness({ context: null });
    h.providers.push(provider("google-web", { text: "译文" }));
    await expect(h.service.translateContext({ userId: USER, contextId: CTX })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("空 userId / contextId → 校验失败，不打网络", async () => {
    const h = harness();
    const p = provider("google-web", { text: "译文" });
    h.providers.push(p);
    await expect(h.service.translateContext({ userId: "", contextId: CTX })).rejects.toBeTruthy();
    expect(p.translate).not.toHaveBeenCalled();
  });

  it("默认目标语言 zh-CN；可覆盖（覆盖需 refresh，否则命中缓存不再翻）", async () => {
    const h = harness();
    const p = provider("google-web", { text: "訳" });
    h.providers.push(p);
    await h.service.translateContext({ userId: USER, contextId: CTX });
    expect(p.translate).toHaveBeenCalledWith(expect.objectContaining({ targetLang: "zh-CN" }));

    // 第二次即使传 ja 也会命中已落库的 zh-CN 译文 —— 缓存优先于 targetLang。
    // 这是刻意的：改目标语言必须显式 refresh，否则「换语言」会静默失效。
    const cached = await h.service.translateContext({ userId: USER, contextId: CTX, targetLang: "ja" });
    expect(cached.cached).toBe(true);
    expect(p.translate).toHaveBeenCalledTimes(1);

    // 显式 refresh 才真正重翻
    await h.service.translateContext({ userId: USER, contextId: CTX, targetLang: "ja", refresh: true });
    expect(p.translate).toHaveBeenLastCalledWith(expect.objectContaining({ targetLang: "ja" }));
  });

  it("已知源语言透传给 provider（短句少误判）", async () => {
    const h = harness({ context: row({ language: "en" }) });
    const p = provider("google-web", { text: "译" });
    h.providers.push(p);
    await h.service.translateContext({ userId: USER, contextId: CTX });
    expect(p.translate).toHaveBeenCalledWith(expect.objectContaining({ sourceLang: "en" }));
  });
});
