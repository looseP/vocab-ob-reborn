import type {
  DictionaryProvider,
  DictionaryLookupResult,
  DictionaryCandidate,
} from "../provider";
import { buildPhrase, selectRelation } from "../normalizer";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

interface DatamuseProviderOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * Datamuse API provider — https://api.datamuse.com
 *
 * Uses POS-aware relation selection (see {@link selectRelation}) to query
 * collocations. Returns {@link DictionaryCandidate}s with phrases normalized
 * via {@link buildPhrase}. Network failures and non-OK responses surface as
 * empty results with a `warning` rather than thrown errors, so callers can
 * degrade gracefully.
 */
export class DatamuseProvider implements DictionaryProvider {
  private readonly baseURL = "https://api.datamuse.com";
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: DatamuseProviderOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  async lookupCollocations(params: {
    lemma: string;
    pos?: string;
    limit?: number;
  }): Promise<DictionaryLookupResult> {
    const limit = params.limit ?? 5;
    const relation = selectRelation(params.pos);

    if (!relation) {
      return {
        candidates: [],
        warning: `No reliable collocation relation for POS "${params.pos ?? "unknown"}"`,
      };
    }

    try {
      const url = `${this.baseURL}/words?${relation.rel}=${encodeURIComponent(params.lemma)}&max=${limit}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) {
        return {
          candidates: [],
          warning: `Datamuse API returned ${res.status}`,
        };
      }

      const declaredLength = Number(res.headers?.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
        return { candidates: [], warning: "Datamuse response exceeded size limit" };
      }

      let parsed: unknown;
      if (typeof res.text === "function") {
        const body = await res.text();
        if (Buffer.byteLength(body, "utf8") > this.maxResponseBytes) {
          return { candidates: [], warning: "Datamuse response exceeded size limit" };
        }
        parsed = JSON.parse(body);
      } else {
        // Compatibility for fetch adapters/test doubles that only expose json().
        parsed = await res.json();
        if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > this.maxResponseBytes) {
          return { candidates: [], warning: "Datamuse response exceeded size limit" };
        }
      }
      if (!Array.isArray(parsed)) {
        return { candidates: [], warning: "Datamuse API returned an invalid response" };
      }
      const data = parsed.filter(
        (item): item is { word: string; score: number; tags?: string[] } =>
          item !== null &&
          typeof item === "object" &&
          typeof (item as { word?: unknown }).word === "string" &&
          typeof (item as { score?: unknown }).score === "number",
      );
      const candidates: DictionaryCandidate[] = data.slice(0, limit).map((d) => ({
        phrase: buildPhrase(params.lemma, d.word, params.pos),
        headword: d.word,
        sourceName: "Datamuse",
        sourceUrl: url,
        relation: relation.rel,
        score: d.score,
        raw: d,
      }));
      return { candidates };
    } catch {
      // Provider/network details stay server-side; callers receive a stable,
      // non-sensitive warning suitable for HTTP responses and logs.
      return {
        candidates: [],
        warning: "Datamuse lookup failed",
      };
    }
  }
}
