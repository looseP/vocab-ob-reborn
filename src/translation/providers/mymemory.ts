import type { TranslationProvider, TranslationResult } from "../provider";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_INPUT_CHARS = 4_000;

interface MyMemoryProviderOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * MyMemory — https://mymemory.translated.net (documented, free).
 *
 * Anonymous quota is 5000 characters/day; we treat the `responseStatus` field
 * (403 when the quota is exhausted) as a normal warning, not an exception, so
 * the service can fall back gracefully. This is the backup for when the Google
 * endpoint is unreachable.
 */
export class MyMemoryProvider implements TranslationProvider {
  readonly id = "mymemory";
  private readonly baseURL = "https://api.mymemory.translated.net/get";
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: MyMemoryProviderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  async translate(params: {
    text: string;
    targetLang: string;
    sourceLang?: string;
  }): Promise<TranslationResult> {
    const text = params.text.trim();
    if (!text) return { text: "", provider: this.id, warning: "empty input" };
    if (text.length > MAX_INPUT_CHARS) {
      return { text: "", provider: this.id, warning: "input too long" };
    }

    const langpair = `${params.sourceLang && params.sourceLang !== "auto" ? params.sourceLang : "en"}|${params.targetLang}`;
    const url = `${this.baseURL}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) {
        return { text: "", provider: this.id, warning: `MyMemory returned ${res.status}` };
      }

      const body = await res.text();
      if (Buffer.byteLength(body, "utf8") > this.maxResponseBytes) {
        return { text: "", provider: this.id, warning: "response exceeded size limit" };
      }

      const parsed = JSON.parse(body) as {
        responseStatus?: number;
        responseData?: { translatedText?: string };
      };
      // 200 = ok, 403 = quota exhausted (a normal, expected condition here).
      if (parsed.responseStatus && parsed.responseStatus !== 200) {
        return { text: "", provider: this.id, warning: `MyMemory status ${parsed.responseStatus}` };
      }
      const translated = parsed.responseData?.translatedText ?? "";
      if (!translated) {
        return { text: "", provider: this.id, warning: "empty translation" };
      }
      return { text: translated, provider: this.id };
    } catch {
      return { text: "", provider: this.id, warning: "MyMemory translate failed" };
    }
  }
}
