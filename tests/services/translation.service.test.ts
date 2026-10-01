/**
 * 无状态划词翻译 service（2026-09-29）。
 *
 * ## 关键不变量
 *
 * 1. **失败不抛** —— provider 全挂返回空译文 + warning。划词是增强动作，
 *    一次失败的划词不该变成一个错误弹窗（与 `translateContext` 同策略）。
 * 2. **零写入** —— 本 service 不持有任何 repository。缓存刻意放在浏览器
 *    localStorage：落库会造出一堆没有 occurrence 的语境行，污染读模型。
 * 3. **原文回显** —— 响应里带 `text`，前端不必自己留着选区文本去对齐。
 * 4. **默认 zh-CN** —— UI 还没有语言选择器，但参数已通。
 * 5. **文本先 trim** —— 用户划词常带首尾空白/换行，不处理会让 provider 猜错语种。
 */

import { describe, expect, it, vi } from "vitest";
import { TranslationService, DEFAULT_TARGET_LANG } from "@/services/translation.service";
import type { TranslationProvider } from "@/translation";

const ok = (id: string, text: string): TranslationProvider => ({
  id,
  translate: vi.fn(async () => ({ text, provider: id })),
});

const fail = (id: string, warning = "down"): TranslationProvider => ({
  id,
  translate: vi.fn(async () => ({ text: "", provider: id, warning })),
});

describe("TranslationService.translateText", () => {
  it("翻译成功：回显原文 + 译文 + 来源，且 cached 恒为 false", async () => {
    const service = new TranslationService([ok("google-web", "法院裁定被告违反了协议条款。")]);
    const r = await service.translateText({ userId: "u1", text: "The court ruled that the defendant had violated the terms." });

    expect(r.translation).toBe("法院裁定被告违反了协议条款。");
    expect(r.text).toBe("The court ruled that the defendant had violated the terms.");
    expect(r.provider).toBe("google-web");
    // 无状态路径没有服务端缓存，恒 false —— 保持与 translateContext 同形，
    // 前端可复用同一套解析逻辑。
    expect(r.cached).toBe(false);
    expect(r.warning).toBeUndefined();
  });

  it("默认目标语言 zh-CN，可覆盖", async () => {
    const p = ok("google-web", "訳");
    const service = new TranslationService([p]);
    await service.translateText({ userId: "u1", text: "hello" });
    expect(p.translate).toHaveBeenCalledWith(expect.objectContaining({ targetLang: DEFAULT_TARGET_LANG }));

    await service.translateText({ userId: "u1", text: "hello", targetLang: "ja" });
    expect(p.translate).toHaveBeenLastCalledWith(expect.objectContaining({ targetLang: "ja" }));
  });

  it("源语言透传（已知语种时省掉 provider 猜测）", async () => {
    const p = ok("google-web", "译");
    await new TranslationService([p]).translateText({ userId: "u1", text: "hi", sourceLang: "en" });
    expect(p.translate).toHaveBeenCalledWith(expect.objectContaining({ sourceLang: "en" }));
  });

  it("未给源语言时传 undefined（不编造默认语种）", async () => {
    const p = ok("google-web", "译");
    await new TranslationService([p]).translateText({ userId: "u1", text: "hi" });
    expect(p.translate).toHaveBeenCalledWith(expect.objectContaining({ sourceLang: undefined }));
  });

  it("文本先 trim 再送 provider（划词常带首尾空白/换行）", async () => {
    const p = ok("google-web", "译");
    const r = await new TranslationService([p]).translateText({ userId: "u1", text: "  hello\n world  " });
    expect(p.translate).toHaveBeenCalledWith(expect.objectContaining({ text: "hello\n world" }));
    expect(r.text).toBe("hello\n world");
  });

  it("provider 全挂 → 空译文 + warning，**不抛**", async () => {
    const service = new TranslationService([fail("google-web", "404"), fail("mymemory", "403")]);
    const r = await service.translateText({ userId: "u1", text: "hello" });
    expect(r.translation).toBe("");
    expect(r.provider).toBe("none");
    expect(r.warning).toContain("403");
  });

  it("自动降级：首个 provider 挂 → 第二个顶上", async () => {
    const service = new TranslationService([fail("google-web"), ok("mymemory", "备胎译文")]);
    const r = await service.translateText({ userId: "u1", text: "hello" });
    expect(r.translation).toBe("备胎译文");
    expect(r.provider).toBe("mymemory");
  });

  it("provider 列表为空 → warning 而非崩", async () => {
    const r = await new TranslationService([]).translateText({ userId: "u1", text: "hello" });
    expect(r.translation).toBe("");
    expect(r.warning).toBeTruthy();
  });

  it("只持有 provider 列表，不持有任何 repository/db 句柄（结构上不可能写库）", () => {
    // 这是「缓存放浏览器、不写数据库」那条决策的守卫：万一有人后来给这个
    // service 注入 repository，own-property 断言会立刻失败。
    // 顺带避免 `new TranslationService()` 走默认 provider 发真实网络请求。
    const service = new TranslationService([ok("google-web", "x")]);
    expect(Object.keys(service)).toEqual(["providers"]);
    expect(Array.isArray((service as unknown as { providers: unknown[] }).providers)).toBe(true);
  });
});
