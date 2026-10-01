/**
 * 划词翻译的前端调用（2026-09-29）。
 *
 * 走无状态端点 `POST /api/l3/translate-text` —— 不要求语境存在、不落库。
 * 服务端无状态、客户端有缓存（localStorage），分工见 `utils/translationCache.ts`。
 */
import { apiFetch } from "./client";
import { readCachedTranslation, writeCachedTranslation } from "@/frontend/utils/translationCache";

export interface TranslateTextResponse {
  text: string;
  translation: string;
  provider: string;
  cached: false;
  warning?: string;
}

export interface TranslateTextOutcome {
  translation: string;
  provider: string;
  /** 命中浏览器缓存（本次没发网络请求）。 */
  fromCache: boolean;
  /** provider 全挂时的原因；译文为空。 */
  warning?: string;
}

/**
 * 翻一段文本，命中浏览器缓存则不发请求。
 *
 * **失败不抛**：返回空译文 + `warning`，由界面显示「暂不可用」。
 * 划词是增强动作，一次失败的划词不该变成一个错误弹窗。
 */
export async function translateText(
  text: string,
  targetLang = "zh-CN",
  options: { sourceLang?: string; signal?: AbortSignal } = {},
): Promise<TranslateTextOutcome> {
  const cached = readCachedTranslation(text, targetLang);
  if (cached) {
    return { translation: cached.translation, provider: cached.provider, fromCache: true };
  }

  const res = await apiFetch<TranslateTextResponse>("/l3/translate-text", {
    method: "POST",
    body: JSON.stringify({
      text,
      targetLang,
      ...(options.sourceLang ? { sourceLang: options.sourceLang } : {}),
    }),
    timeoutMs: 20_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (res.translation) {
    writeCachedTranslation(text, targetLang, { translation: res.translation, provider: res.provider });
    return { translation: res.translation, provider: res.provider, fromCache: false };
  }
  return {
    translation: "",
    provider: res.provider,
    fromCache: false,
    warning: res.warning ?? "translation unavailable",
  };
}
