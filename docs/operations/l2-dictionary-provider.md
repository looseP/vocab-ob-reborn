# L2 Dictionary Provider

> Scope: Phase 2E.1 — the dictionary provider layer that grounds collocation
> drafts and collocation external prompts. This is the authoritative reference for provider behavior, the failure
> matrix, and the no-candidates policy. Deployment + env details live in
> [`l2-dictionary-provider-deployment.md`](./l2-dictionary-provider-deployment.md).

## 1. What the dictionary provider is

The `DictionaryProvider` interface (`src/dictionary/provider.ts`) is the
pluggable boundary for collocation candidate lookup. It performs a pure
network lookup and returns normalized `DictionaryCandidate`s; persistence and
business logic live in higher layers (`L2ContentService`).

```ts
interface DictionaryProvider {
  lookupCollocations(params: { lemma: string; pos?: string; limit?: number }):
    Promise<{ candidates: DictionaryCandidate[]; warning?: string }>;
}
```

The provider is **not** an authoritative learner dictionary. It is a
*candidate source*: it tells the L2 Composer which phrases *exist* as
collocations for a lemma, so the LLM can refine/annotate them rather than
invent new ones.

## 2. Datamuse — the default candidate provider

The current production provider is `DatamuseProvider`
(`src/dictionary/providers/datamuse.ts`), wired in `src/server.ts`.

- **Position**: free candidate provider. Good for adjective–noun and similar
  relation-based candidates. Not authoritative; does not replace a learner
  collocation dictionary.
- **No API key, no auth** — public HTTPS endpoint at `https://api.datamuse.com`.
- **POS-aware relation selection** (`selectRelation`): maps the word's POS to a
  Datamuse relation (`rel_jja`, `rel_jjb`, …). When no reliable relation exists
  for the POS, it returns empty candidates with a `warning` (no network call).

### Env var

```env
DATAMUSE_ENABLED=true   # truthy: "1" or "true"
```

When unset/disabled, no `DictionaryProvider` is injected into
`L2ContentService`. The service is still constructed; `confirmDraft` still
works; `generateDraft(collocation, ...)` and `buildExternalPrompt(collocation, ...)` return `NO_DICTIONARY_CANDIDATES`.

## 3. Failure matrix

`generateDraft` and `buildExternalPrompt` for `field=collocation` consult the
dictionary before any collocation content/prompt is produced. Every failure mode
degrades to `NO_DICTIONARY_CANDIDATES`; the LLM is **never** called as a
fallback, and external-prompt never emits an ungrounded collocation prompt. This
is the no-candidates policy.

| Situation | Dictionary result | LLM called? | L2 Composer behavior |
|-----------|-------------------|-------------|--------------------------|
| No `dictionaryProvider` configured | — | No | `NO_DICTIONARY_CANDIDATES`, warning "Dictionary provider not configured" |
| Provider throws (network down, auth, …) | caught → `candidates: []` + warning | No | `NO_DICTIONARY_CANDIDATES`, warning "Dictionary lookup failed: ..." |
| Provider returns non-OK HTTP | `candidates: []` + warning | No | `NO_DICTIONARY_CANDIDATES`, warning "Datamuse API returned <status>" |
| No reliable relation for POS | `candidates: []` + warning | No | `NO_DICTIONARY_CANDIDATES`, warning "No reliable collocation relation for POS ..." |
| Empty candidate list | `candidates: []` (+ optional warning) | No | `NO_DICTIONARY_CANDIDATES` (+ warning) |
| Candidates, but no LLM deps | `candidates: [...]` | No | dictionary-only draft (`sourceMode = "dictionary"`), items carry `provenance.source = "dictionary"` |
| Candidates + LLM, over budget | `candidates: [...]` | No (budget guard fires) | `OVER_BUDGET` |
| Candidates + LLM | `candidates: [...]` | Yes | LLM-refined draft (`sourceMode = "dictionary_llm_refined"`); ungrounded LLM items dropped |

### No-candidates policy (binding)

> When the dictionary has no candidates — for any reason — collocation draft
> generation and collocation external-prompt generation return
> `NO_DICTIONARY_CANDIDATES`. The service **never** falls back to an ungrounded
> LLM draft or ungrounded external prompt. Invented collocations would violate
> the candidate-grounding contract (the dictionary is the sole source of which
> phrases exist).

This is enforced structurally in `L2ContentService.generateDraft`: the
`collocation` branch returns `NO_DICTIONARY_CANDIDATES` before constructing any
LLM prompt, and the ungrounded collocation prompt template
(`buildCollocationPrompt`'s no-candidates branch) is dead code from the
service's perspective — kept only as a library function, never invoked by the
draft flow.

`L2ContentService.buildExternalPrompt` follows the same rule: for collocation it
looks up dictionary candidates before assembling prompt text. With candidates,
the returned prompt is v1-first and tells the external tool to use
`provenance.source = "external_chat"` plus dictionary evidence
(`dictionaryName` and `rawPhrase`).

### Ungrounded LLM output (drop not reject)

Even with a grounding instruction in the prompt, LLMs sometimes emit
collocations absent from the candidate list. `generateDraft` defensively
filters the LLM's output items, **dropping** any whose `phrase` is not in the
candidate set (case-insensitive, trimmed comparison) rather than rejecting the
whole draft. A `warning` is surfaced (`"Filtered N ungrounded collocation
item(s) not present in dictionary candidates"`) so the caller/operator can see
the filter fired. Invented phrases never reach `confirm`/DB.

## 4. DictionaryCandidate shape

```ts
interface DictionaryCandidate {
  phrase: string;          // normalized, LLM-readable
  headword?: string;       // e.g. the noun in an adj+noun collocation
  pos?: string;
  meaning?: string;
  example?: string;
  sourceName: string;      // "Datamuse"
  sourceEntryId?: string;
  sourceUrl?: string;      // query URL for traceability
  relation?: string;       // e.g. "rel_jja"
  score?: number;          // Datamuse score
  raw?: unknown;           // original API response item
}
```

The dictionary-only draft (`sourceMode = "dictionary"`) maps each candidate to
an item carrying `provenance.source = "dictionary"` + `dictionaryName` and an
`evidence` block, so the origin is never lost even when the LLM is absent.

## 5. Future provider tiers

The `DictionaryProvider` interface is the single integration point; adding a
new provider never touches `L2ContentService`. Planned tiers (not in Phase 2E):

- **Tier 1 — Datamuse (current default)**: free candidate source. Kept as the
  default for lightweight collocation candidate lookup.
- **Tier 2 — Wiktionary-derived structured data** (Kaikki/Wiktextract,
  WiktApi, dictionaryapi.dev): for definitions, examples, etymology, forms.
  **Not** a primary collocation source; used to enrich L2 items with evidence
  and feed future L3 linking. Implement as a separate `WiktionaryProvider`
  returning a different normalized shape — do **not** overload `DatamuseProvider`.
- **Tier 3 — Local corpus statistics from L3**: once Phase 3 exists, the user's
  own imported texts become the highest-quality ground truth. Long-term goal:
  `Datamuse candidates + Wiktionary evidence + L3 occurrences → LLM ranks only
  grounded candidates`.

### Oxford / Ozdic / other learner dictionaries

Good learner-facing content, but **do not scrape** them unless the license and
terms explicitly allow it. Only integrate via an official API or licensed
dataset, kept optional and isolated behind `DictionaryProvider`.

### Merriam-Webster / Sketch Engine / commercial corpus APIs

Not free-first. Defer until the product has a clear reason to pay for
corpus-quality collocation data.

## 6. Architecture boundary

The dictionary layer is independent of `db` / `repositories` / `services`
(ADR-001 layering). Providers perform pure network lookups and return
normalized candidates; persistence and business logic live in higher layers.
`dependency-cruiser` does not yet enforce a `dictionary-no-outbound` rule, but
the layer is factually clean (no imports of `db`/`repositories`/`services`).
