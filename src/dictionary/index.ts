/**
 * Dictionary barrel — unified entry point for dictionary providers,
 * normalization helpers, and public types.
 *
 * Callers should import from `@/dictionary` rather than reaching into
 * concrete provider modules.
 */

export type {
  DictionaryProvider,
  DictionaryCandidate,
  DictionaryLookupResult,
} from "./provider";
export { DatamuseProvider } from "./providers/datamuse";
export { buildPhrase, selectRelation } from "./normalizer";
