/**
 * Translation barrel — unified entry for translation providers.
 *
 * Follows the same shape as `src/llm/index.ts` and `src/dictionary/`: callers
 * import from here and never touch concrete providers. The service layer is
 * responsible for provider ordering and caching; this module only assembles
 * the default chain.
 */
import type { TranslationProvider, TranslationResult } from "./provider";
import { GoogleWebProvider } from "./providers/google-web";
import { MyMemoryProvider } from "./providers/mymemory";

export type { TranslationProvider, TranslationResult };
export { GoogleWebProvider } from "./providers/google-web";
export { MyMemoryProvider } from "./providers/mymemory";

/**
 * Default chain, tried in order. The free Google endpoint leads; MyMemory is the
 * documented safety net. To move to a keyed provider later (e.g. when deploying
 * to a cloud host, where Google's endpoint refuses traffic), add a provider here
 * and put it first — no other layer changes.
 */
export function createDefaultTranslationProviders(): TranslationProvider[] {
  return [new GoogleWebProvider(), new MyMemoryProvider()];
}

/**
 * Run providers in order until one returns a non-empty translation.
 * Returns the first success; if all fail, the last warning is surfaced.
 */
export async function translateWithFallback(
  providers: TranslationProvider[],
  params: { text: string; targetLang: string; sourceLang?: string },
): Promise<TranslationResult> {
  let lastWarning = "no translation provider configured";
  for (const provider of providers) {
    const result = await provider.translate(params);
    if (result.text) return result;
    if (result.warning) lastWarning = `${provider.id}: ${result.warning}`;
  }
  return { text: "", provider: "none", warning: lastWarning };
}
