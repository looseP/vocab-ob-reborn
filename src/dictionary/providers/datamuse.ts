import type {
  DictionaryProvider,
  DictionaryLookupResult,
  DictionaryCandidate,
} from "../provider";
import { buildPhrase, selectRelation } from "../normalizer";

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
  private baseURL = "https://api.datamuse.com";

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
      const res = await fetch(url);
      if (!res.ok) {
        return {
          candidates: [],
          warning: `Datamuse API returned ${res.status}`,
        };
      }
      const data = (await res.json()) as Array<{
        word: string;
        score: number;
        tags?: string[];
      }>;
      const candidates: DictionaryCandidate[] = data.map((d) => ({
        phrase: buildPhrase(params.lemma, d.word, params.pos),
        headword: d.word,
        sourceName: "Datamuse",
        sourceUrl: url,
        relation: relation.rel,
        score: d.score,
        raw: d,
      }));
      return { candidates };
    } catch (err) {
      return {
        candidates: [],
        warning: `Datamuse lookup failed: ${(err as Error).message}`,
      };
    }
  }
}
