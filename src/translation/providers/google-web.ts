import type { TranslationProvider, TranslationResult } from "../provider";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
/** Google rejects very long `q` params; sentence-level inputs stay far below this. */
const MAX_INPUT_CHARS = 4_000;

interface GoogleWebProviderOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * Google web-translate endpoint — the same one Chrome calls for "translate to
 * Chinese" (`client=gtx`).
 *
 * **Unofficial and best-effort.** It needs no key, has no documented quota, and
 * in practice does not rate-limit light use — but Google can change or remove
 * it at any time, and it refuses requests that look like they originate from
 * cloud IP space. Treat it as "free until it isn't"; the persisted cache and
 * the MyMemory fallback are what make that acceptable here.
 *
 * Response shape (nested arrays, must be joined per-segment):
 *   [[["译文","原文",null,null,10], ["续译",...]], ..., ["en"], null, [1], ["en"]]
 * The first element is the per-segment translation; the tail carries language
 * detection. We join the segments and read the detected language defensively.
 */
export class GoogleWebProvider implements TranslationProvider {
  readonly id = "google-web";
  private readonly baseURL = "https://translate.googleapis.com/translate_a/single";
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: GoogleWebProviderOptions = {}) {
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

    const url =
      `${this.baseURL}?client=gtx&sl=${encodeURIComponent(params.sourceLang ?? "auto")}` +
      `&tl=${encodeURIComponent(params.targetLang)}&dt=t&q=${encodeURIComponent(text)}`;

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!res.ok) {
        return { text: "", provider: this.id, warning: `Google returned ${res.status}` };
      }

      const body = await res.text();
      if (Buffer.byteLength(body, "utf8") > this.maxResponseBytes) {
        return { text: "", provider: this.id, warning: "response exceeded size limit" };
      }

      const parsed: unknown = JSON.parse(body);
      if (!Array.isArray(parsed)) {
        return { text: "", provider: this.id, warning: "invalid response shape" };
      }

      // parsed[0] is the per-segment array; each segment[0] is a chunk of the
      // translation that must be concatenated in order.
      const segments = parsed[0];
      if (!Array.isArray(segments)) {
        return { text: "", provider: this.id, warning: "missing translation segments" };
      }
      const translated = segments
        .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
        .join("");

      // Language detection lives in the tail (e.g. ["en"], null, [1], ["en"]);
      // read it opportunistically — not all responses include it.
      let detected: string | undefined;
      for (const item of parsed) {
        if (Array.isArray(item) && typeof item[0] === "string" && /^[a-z]{2,3}$/i.test(item[0])) {
          detected = item[0].toLowerCase();
          break;
        }
      }

      if (!translated) {
        return { text: "", provider: this.id, warning: "empty translation" };
      }
      return { text: translated, provider: this.id, detectedSourceLanguage: detected };
    } catch {
      // Network/TLS/parse failures stay server-side; callers get a stable warning.
      return { text: "", provider: this.id, warning: "Google translate failed" };
    }
  }
}
