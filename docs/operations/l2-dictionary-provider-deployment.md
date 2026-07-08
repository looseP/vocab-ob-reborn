# L2 Dictionary Provider Deployment Notes

> Scope: Phase 2D L2 Composer dictionary grounding.
> Goal: make collocation draft behavior explicit in production and document free/stable dictionary-source choices.

## 1. Current Production Switch

The current backend wires the dictionary provider in `src/server.ts`.

```env
DATAMUSE_ENABLED=true
```

Accepted truthy values:

```txt
1
true
```

When enabled, the server constructs `DatamuseProvider` and injects it into `L2ContentService`.

When disabled or unset:

- `L2ContentService` is still created.
- `confirmDraft()` still works for manual, external chat, and already-structured content.
- `example/corpus` draft still depends on LLM configuration.
- `collocation` draft returns `NO_DICTIONARY_CANDIDATES` instead of falling back to ungrounded LLM generation.

This is intentional. Collocation should fail safely rather than invent phrases.

## 2. Required Env for Full L2 Composer

Minimum for manual/external confirm only:

```env
# no LLM required
# no dictionary required
```

For example/corpus generation:

```env
LLM_PROVIDER=openai
LLM_MODEL=...
LLM_API_KEY=...
LLM_BASE_URL=... # optional, for OpenAI-compatible gateways
```

For dictionary-grounded collocation generation:

```env
DATAMUSE_ENABLED=true
```

For dictionary-grounded collocation with LLM refinement:

```env
DATAMUSE_ENABLED=true
LLM_PROVIDER=openai
LLM_MODEL=...
LLM_API_KEY=...
```

## 3. Runtime Behavior Matrix

| Request | Dictionary configured | LLM configured | Expected behavior |
|---|---:|---:|---|
| `confirm` manual/external | no | no | works |
| `draft` example/corpus | any | no | `L2_CONTENT_UNAVAILABLE` |
| `draft` collocation | no | any | `NO_DICTIONARY_CANDIDATES` |
| `draft` collocation | yes, no candidates | any | `NO_DICTIONARY_CANDIDATES` |
| `draft` collocation | yes, candidates | no | dictionary-only draft |
| `draft` collocation | yes, candidates | yes | dictionary candidates refined by LLM |
| `external-prompt` | any | any | works; no LLM call; no usage budget |

## 4. Recommended Free/Stable Source Strategy

### Tier 1: Keep Datamuse as the default collocation candidate provider

Use Datamuse for lightweight collocation candidate lookup.

Why:

- Free public API.
- No API key.
- Simple HTTP integration.
- Useful relation constraints for adjective/noun pair candidates.
- Good fit for MVP dictionary-grounded collocation.

Limitations:

- It is a candidate source, not a full authoritative dictionary.
- It is strongest for simple relation-based candidates, especially adjective-noun patterns.
- It does not replace a learner collocation dictionary.

Implementation rule:

- Keep Datamuse output as `DictionaryCandidate`.
- Preserve `sourceName = "Datamuse"`, `relation`, `sourceUrl`, `score`, and `raw`.
- Let LLM rank/explain/filter candidates, but never invent candidates outside the list.

### Tier 2: Add Wiktionary-derived structured data for dictionary evidence

Use Wiktionary-derived structured data to enrich definitions, examples, forms, translations, etymology, and lexical relations.

Recommended options:

1. `Kaikki/Wiktextract` offline dumps.
2. `WiktApi` if you want a self-hostable structured API over Wiktionary-derived data.
3. `dictionaryapi.dev` / Free Dictionary API as a lightweight online fallback for definitions/pronunciation/examples.

Best use in this project:

- Not as the primary collocation source.
- Use it to enrich L2 items with definitions, usage examples, etymology, forms, and lexical metadata.
- Use it as evidence for L2 Graph and future L3 linking.

Implementation recommendation:

- Add a separate provider such as `WiktionaryProvider`.
- Do not overload `DatamuseProvider`.
- Return a different normalized shape if needed, for example `DictionaryEntryEvidence`, then map selected fields into `L2ContentProvenance` / `evidence`.

### Tier 3: Build local corpus statistics from L3 over time

The most reliable long-term source for this app is the user's own L3 context space.

Once Phase 3 exists, L3 can provide:

- authentic occurrences from user-imported texts/subtitles/articles;
- phrase frequency within the user's real materials;
- examples tied to exact source/context/span;
- evidence links from L2 collocation/example items to L3 contexts.

This should eventually become the highest-quality ground truth for the user's personal learning graph.

Recommended future approach:

```txt
Datamuse candidates
  + Wiktionary-derived entry evidence
  + L3 authentic occurrences
  -> LLM ranks/explains only grounded candidates
```

## 5. Optional Sources, With Caution

### Merriam-Webster Dictionary API

Potentially useful for non-commercial/personal use, but it requires an API key and has daily limits. Treat it as optional enrichment, not the default free provider.

### Ozdic / Oxford / other learner dictionaries

Good learner-facing content, but do not scrape them unless the license and terms explicitly allow it.

Recommendation:

- Do not add scraping-based providers.
- Only add them through an official API or licensed dataset.
- Keep any such provider optional and isolated behind `DictionaryProvider`.

### Sketch Engine / commercial corpus APIs

Good quality, but not free-first. Defer until the product has a clear reason to pay for corpus-quality collocation data.

## 6. Deployment Checklist

Before production deploy:

- [ ] Decide whether collocation draft should be enabled in this environment.
- [ ] If yes, set `DATAMUSE_ENABLED=true`.
- [ ] Confirm outbound HTTPS access to `https://api.datamuse.com`.
- [ ] Confirm logs show `Dictionary provider configured: Datamuse`.
- [ ] Confirm `/api/l2/:slug/draft` for `field=collocation` returns candidates or a safe `NO_DICTIONARY_CANDIDATES`.
- [ ] Confirm no ungrounded collocation fallback is enabled.
- [ ] Confirm `external-prompt` works without LLM usage.
- [ ] Confirm `confirm` works without LLM provider for manual/external content.

## 7. Failure Policy

Provider failure must never produce invented collocations.

If Datamuse is unreachable, rate-limited, or returns no candidates:

```json
{
  "error": "NO_DICTIONARY_CANDIDATES",
  "warning": "..."
}
```

Allowed fallback:

- dictionary-only draft when candidates exist but LLM is unavailable.
- external prompt generation.
- manual user entry.
- external chat paste followed by confirm validation.

Not allowed:

- silently calling LLM to invent collocations;
- marking invented collocations as dictionary-sourced;
- writing draft content before confirm.

## 8. Phase 3 Note

Do not solve L3 here.

When Phase 3 starts, add L3 as a separate `l3_` table family and use it as evidence/context. L3 must not enter FSRS directly and must not be mixed into `word_l2_content` as raw context blobs.
