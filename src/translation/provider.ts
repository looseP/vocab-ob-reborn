/**
 * Translation provider layer — pluggable sentence translation.
 *
 * Independent of db/llm/repositories/services (see ADR-001 layering). Providers
 * here perform pure network lookups and return a normalized
 * {@link TranslationResult}; caching and persistence live in higher layers
 * (the translation is written onto the L3 context row so it survives provider
 * death — see `l3-context.service.ts`).
 *
 * Two providers, tried in order by the service:
 *  1. {@link GoogleWebProvider}  — the endpoint Chrome's "translate to Chinese"
 *     uses. No key, no registration. **Unofficial** (undocumented internal
 *     Google API): no SLA, can vanish, and will refuse traffic from cloud IPs.
 *     Fine for this project's local/self-hosted use; if you ever deploy to a
 *     cloud host, switch to a keyed provider (the service seam is the only
 *     thing that changes).
 *  2. {@link MyMemoryProvider} — documented, 5000 chars/day anonymous. The
 *     safety net for when Google 404s.
 *
 * Mirrors the dictionary provider contract ({@link ../dictionary/provider.ts}):
 * timeout, response-size cap, defensive parsing, and **no thrown errors** —
 * a failed lookup returns a `warning` so the caller can degrade gracefully.
 */

export interface TranslationResult {
  /** Translated text, or empty string when the provider could not translate. */
  text: string;
  /** Stable provider id, persisted alongside the text so we know its origin. */
  provider: string;
  /** Auto-detected source language when the provider reports one. */
  detectedSourceLanguage?: string;
  /** Non-sensitive failure reason suitable for HTTP responses and logs. */
  warning?: string;
}

export interface TranslationProvider {
  /** Provider id persisted in `translation_src`. */
  readonly id: string;
  translate(params: { text: string; targetLang: string; sourceLang?: string }): Promise<TranslationResult>;
}
