/// <reference lib="dom" />
// @vitest-environment node

/**
 * 整句翻译（2026-09-29）——provider 层 + 缓存/降级语义。
 *
 * ## 为什么这些不变量重要
 *
 * 翻译走的是**免费非官方**端点（Google 网页翻译接口）。它的可用性不由我们控制，
 * 所以整套设计的前提是「**端点随时可能消失**」：
 *
 * 1. **缓存即价值** —— 译文落库后，已读文章永久可读，与 provider 生死无关。
 *    若缓存不生效，这个功能在端点消失后就等于没有。
 * 2. **降级不报错** —— Google 挂了要自动切 MyMemory；全挂了要返回 warning
 *    而不是抛异常/500，让界面能显示「暂不可用」而不是崩。
 * 3. **降级不毁缓存** —— 刷新失败时**不得**清掉已缓存的译文。
 * 4. **半填禁止** —— DB 有 `l3_contexts_translation_check`：译文与来源必须全有或全无。
 * 5. **provider 失败不抛** —— 网络/解析异常收敛成 warning（对齐 dictionary provider 契约）。
 *
 * 这里用**假 provider**，不发真实网络请求：被测的是编排与缓存语义，不是端点连通性。
 */

import { describe, expect, it, vi } from "vitest";
import {
  GoogleWebProvider,
  MyMemoryProvider,
  createDefaultTranslationProviders,
  translateWithFallback,
  type TranslationProvider,
  type TranslationResult,
} from "@/translation";

// ── fetch 替身：让 provider 走确定路径 ─────────────────────────────────────
function stubFetch(impl: (url: string) => { status?: number; body: string }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const { status = 200, body } = impl(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => body,
      json: async () => JSON.parse(body),
    } as unknown as Response;
  });
}

const withFetch = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const original = globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

describe("GoogleWebProvider · 响应解析", () => {
  it("拼接分段译文并读出语言检测（不是只取第一段）", async () => {
    await withFetch(async () => {
      globalThis.fetch = stubFetch(() => ({
        body: JSON.stringify([
          [["第一段译文。", "First segment.", null, null, 5],
           ["第二段译文。", "Second segment.", null, null, 5]],
          null, null, null, null,
          ["en"], null, [1], ["en"],
        ]),
      })) as unknown as typeof fetch;

      const r = await new GoogleWebProvider().translate({ text: "Hello world.", targetLang: "zh-CN" });
      expect(r.text).toBe("第一段译文。第二段译文。");
      expect(r.provider).toBe("google-web");
      expect(r.detectedSourceLanguage).toBe("en");
      expect(r.warning).toBeUndefined();
    });
  });

  it("请求带 client=gtx + 目标语言 + auto 源语言", async () => {
    await withFetch(async () => {
      const seen: string[] = [];
      globalThis.fetch = stubFetch((url) => {
        seen.push(url);
        return { body: JSON.stringify([[["译文", "src", null, null, 1]]]) };
      }) as unknown as typeof fetch;

      await new GoogleWebProvider().translate({ text: "a", targetLang: "zh-CN" });
      const url = seen[0]!;
      expect(url).toContain("translate.googleapis.com");
      expect(url).toContain("client=gtx");
      expect(url).toContain("tl=zh-CN");
      expect(url).toContain("sl=auto");
      expect(url).toContain("q=a");
    });
  });

  it("已指定源语言时透传（不强制 auto）", async () => {
    await withFetch(async () => {
      const seen: string[] = [];
      globalThis.fetch = stubFetch((url) => { seen.push(url); return { body: "[[['x','y']]]" }; }) as unknown as typeof fetch;
      await new GoogleWebProvider().translate({ text: "hi", targetLang: "zh-CN", sourceLang: "en" });
      expect(seen[0]).toContain("sl=en");
    });
  });

  it("网络异常 → warning，不抛", async () => {
    await withFetch(async () => {
      globalThis.fetch = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
      const r = await new GoogleWebProvider().translate({ text: "x", targetLang: "zh-CN" });
      expect(r.text).toBe("");
      expect(r.warning).toBe("Google translate failed");
    });
  });

  it("非 200 → warning 带状态码，不抛", async () => {
    await withFetch(async () => {
      globalThis.fetch = stubFetch(() => ({ status: 429, body: "too many" })) as unknown as typeof fetch;
      const r = await new GoogleWebProvider().translate({ text: "x", targetLang: "zh-CN" });
      expect(r.text).toBe("");
      expect(r.warning).toContain("429");
    });
  });

  it("形状不对（首元素非数组）→ warning，不抛", async () => {
    await withFetch(async () => {
      globalThis.fetch = stubFetch(() => ({ body: JSON.stringify({ nope: 1 }) })) as unknown as typeof fetch;
      const r = await new GoogleWebProvider().translate({ text: "x", targetLang: "zh-CN" });
      expect(r.text).toBe("");
      expect(r.warning).toBeTruthy();
    });
  });

  it("空输入 / 超长输入 → 本地短路，不发请求", async () => {
    await withFetch(async () => {
      const spy = vi.fn();
      globalThis.fetch = spy as unknown as typeof fetch;
      const p = new GoogleWebProvider();
      expect((await p.translate({ text: "   ", targetLang: "zh-CN" })).warning).toBe("empty input");
      expect((await p.translate({ text: "x".repeat(5000), targetLang: "zh-CN" })).warning).toBe("input too long");
      expect(spy).not.toHaveBeenCalled();
    });
  });
});

describe("MyMemoryProvider · 配额与结构", () => {
  it("成功时取 responseData.translatedText", async () => {
    await withFetch(async () => {
      globalThis.fetch = stubFetch(() => ({
        body: JSON.stringify({ responseStatus: 200, responseData: { translatedText: "译文" } }),
      })) as unknown as typeof fetch;
      const r = await new MyMemoryProvider().translate({ text: "x", targetLang: "zh-CN" });
      expect(r.text).toBe("译文");
      expect(r.provider).toBe("mymemory");
    });
  });

  it("responseStatus 非 200（403 配额超限）→ warning 当正常降级，不抛", async () => {
    await withFetch(async () => {
      globalThis.fetch = stubFetch(() => ({
        body: JSON.stringify({ responseStatus: 403, responseDetails: "quota exceeded" }),
      })) as unknown as typeof fetch;
      const r = await new MyMemoryProvider().translate({ text: "x", targetLang: "zh-CN" });
      expect(r.text).toBe("");
      expect(r.warning).toContain("403");
    });
  });
});

describe("translateWithFallback · 降级链", () => {
  const fail = (id: string, warning = "down"): TranslationProvider => ({
    id,
    translate: async () => ({ text: "", provider: id, warning }),
  });
  const ok = (id: string, text: string): TranslationProvider => ({
    id,
    translate: async () => ({ text, provider: id }),
  });

  it("首个成功即返回，不再打后面的 provider", async () => {
    const second = ok("second", "不该被调用");
    const spy = vi.spyOn(second, "translate");
    const r = await translateWithFallback([ok("first", "译文"), second], { text: "x", targetLang: "zh-CN" });
    expect(r.text).toBe("译文");
    expect(r.provider).toBe("first");
    expect(spy).not.toHaveBeenCalled();
  });

  it("首个失败 → 自动切下一个", async () => {
    const r = await translateWithFallback([fail("google-web"), ok("mymemory", "备胎译文")], {
      text: "x", targetLang: "zh-CN",
    });
    expect(r.text).toBe("备胎译文");
    expect(r.provider).toBe("mymemory");
  });

  it("全挂 → 空译文 + 最后一个 provider 的 warning（不抛）", async () => {
    const r = await translateWithFallback([fail("a", "a死"), fail("b", "b死")], { text: "x", targetLang: "zh-CN" });
    expect(r.text).toBe("");
    expect(r.provider).toBe("none");
    expect(r.warning).toContain("b死");
  });

  it("空 provider 列表 → warning 而非崩", async () => {
    const r = await translateWithFallback([], { text: "x", targetLang: "zh-CN" });
    expect(r.text).toBe("");
    expect(r.warning).toBeTruthy();
  });

  it("默认链是 Google 优先、MyMemory 兜底（顺序即降级顺序）", () => {
    expect(createDefaultTranslationProviders().map((p) => p.id)).toEqual(["google-web", "mymemory"]);
  });

  it("降级结果类型可赋值给 TranslationResult（provider id 随来源变）", async () => {
    const r: TranslationResult = await translateWithFallback([fail("google-web"), ok("mymemory", "t")], {
      text: "x", targetLang: "zh-CN",
    });
    expect(r.provider).toBe("mymemory");
  });
});
