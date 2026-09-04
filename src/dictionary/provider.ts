/**
 * Dictionary provider layer — pluggable dictionary/collocation sources.
 *
 * This layer is intentionally independent of db/llm/repositories/services
 * (see ADR-001 layering). Providers here perform pure network lookups and
 * return normalized {@link DictionaryCandidate}s; persistence and business
 * logic live in higher layers.
 */

export interface DictionaryCandidate {
  phrase: string;
  headword?: string;
  pos?: string;
  meaning?: string;
  example?: string;
  sourceName: string;
  sourceEntryId?: string;
  sourceUrl?: string;
  relation?: string;
  score?: number;
  raw?: unknown;
}

export interface DictionaryLookupResult {
  candidates: DictionaryCandidate[];
  warning?: string;
}

export interface DictionaryProvider {
  lookupCollocations(params: {
    lemma: string;
    pos?: string;
    limit?: number;
  }): Promise<DictionaryLookupResult>;
}
