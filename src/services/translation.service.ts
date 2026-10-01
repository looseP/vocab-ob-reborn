/**
 * 无状态整句翻译（2026-09-29）。
 *
 * ## 为什么单独一个 service
 *
 * 翻译有两条路：
 *
 * 1. **带语境**（`L3ContextService.translateContext`）——译文落进
 *    `l3_contexts.translation`。适合「这句话我要留着用」。
 * 2. **不带语境**（本文件）——给一段文本就还一段译文，**不碰数据库**。
 *    适合「扫一眼，读完就走」。
 *
 * 第 2 条是主用法。2026-09-29 的实测反馈是：把入口挂在「圈记 → 句尾小标号 →
 * 相关词汇面板」之后，等于要求用户先做一件他不做的事（他的 `l3_contexts`
 * 当时只有 1 行圈记）。所以这里刻意**不要求 context 存在**。
 *
 * ## 缓存为什么不在这里
 *
 * 落库缓存对第 1 条路有意义（语境是长期资产）。第 2 条路的缓存放在**浏览器
 * localStorage**（`frontend/lib/translationCache.ts`）——理由同样来自那条反馈：
 * 「不用存」。写进 `l3_contexts` 会凭空造出一堆没有 occurrence、没有来源的
 * 语境行，污染按语境做的统计。
 *
 * ## 失败语义
 *
 * provider 全挂时**不抛异常**，返回空译文 + `warning`（仍走 200）。理由同
 * `translateContext`：翻译是增强不是前提，界面据此显示「暂不可用」，而不是
 * 把一次划词变成一个错误页。
 */
import {
  createDefaultTranslationProviders,
  translateWithFallback,
  type TranslationProvider,
} from "@/translation";

export interface TranslateTextInput {
  /** 仅用于鉴权与日志；本 service 不按用户隔离数据（无状态）。 */
  userId: string;
  text: string;
  targetLang?: string;
  sourceLang?: string;
}

export interface TranslateTextResult {
  /** 原样回显，便于前端把译文与选区对齐，不必自己留着原文。 */
  text: string;
  translation: string;
  provider: string;
  /** 无状态路径永不命中服务端缓存，恒为 false（保持与带语境路径同形）。 */
  cached: false;
  warning?: string;
}

export const DEFAULT_TARGET_LANG = "zh-CN";

export class TranslationService {
  constructor(
    private readonly providers: TranslationProvider[] = createDefaultTranslationProviders(),
  ) {}

  async translateText(input: TranslateTextInput): Promise<TranslateTextResult> {
    const text = input.text.trim();
    const result = await translateWithFallback(this.providers, {
      text,
      targetLang: input.targetLang ?? DEFAULT_TARGET_LANG,
      sourceLang: input.sourceLang,
    });

    return {
      text,
      translation: result.text,
      provider: result.provider,
      cached: false,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }
}
