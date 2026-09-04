# L2 Composer API Contract

> Scope: Phase 2E L2 Composer surface — the HTTP contract for the draft /
> external-prompt / confirm flow on `/api/l2/:slug/*`.
> Status: **Frozen** as of Phase 2E.1 (see ADR-0006). Changes require a new ADR.

This document is the authoritative HTTP contract for the L2 Composer. It is
intended for API consumers (UI, operators, external tool integrators) and
mirrors the behavior enforced by `src/http/routes/l2.ts` +
`src/services/l2-content.service.ts`. The service-layer contracts (DTO shapes,
source modes) live in `src/schemas/service/index.ts`.

## 1. Conventions

- All routes require owner auth (`Authorization: Bearer <OWNER_API_TOKEN>`).
- All request/response bodies are JSON (`Content-Type: application/json`).
- `:slug` is the word slug; the route resolves it to a `WordContext`
  (`lemma`, `pos`, `semanticField`, `shortDefinition`, `cefrTarget`).
- **Composer field vs. storage field**: the API accepts `example` as a field
  name, which maps to the canonical storage field `corpus`. The other fields
  (`collocation`, `synonym`, `antonym`) are identical in both vocabularies.
  Responses echo the composer-facing `field` and the canonical `storageField`.

## 2. POST /api/l2/:slug/draft

Generate an L2 content draft for one field of a word. Honors the daily token
budget and the field's source semantics. **Never throws** — failures are
returned as structured `error` results mapped to status codes.

### Request

```jsonc
{
  "field": "collocation | example | corpus | synonym | antonym",
  "source": "manual",                 // optional, default "manual"
  "styleProfileId": "academic",       // optional; applies to collocation/example
  "count": 5,                         // optional; positive integer
  "userInstruction": "free-text hint" // optional; threaded into the prompt
}
```

### Response — success (200)

```jsonc
{
  "draft": [ /* field-specific items, see §6 */ ],
  "raw": "<LLM raw output string>",
  "sourceMode": "internal_llm | dictionary | dictionary_llm_refined"
}
```

`sourceMode` is present only when the draft succeeded and indicates which
source produced it:
- `internal_llm` — corpus/synonym/antonym drafted by the LLM.
- `dictionary` — collocation drafted from dictionary candidates only (no LLM).
- `dictionary_llm_refined` — collocation candidates refined by the LLM.

### Response — errors

| Status | `error`                | When |
|-------:|------------------------|------|
| 400    | `VALIDATION_ERROR`     | Invalid field, or style profile scope mismatch |
| 422    | `NO_DICTIONARY_CANDIDATES` | `field=collocation` and dictionary had no candidates (or no provider configured). LLM is **never** called. Body includes `warning`. |
| 503    | `OVER_BUDGET`          | Daily LLM token budget exceeded (no LLM call) |
| 503    | `L2_CONTENT_UNAVAILABLE` | LLM required (corpus/synonym/antonym) but not configured |
| 500    | `LLM_ERROR` / `PARSE_FAILED` | LLM call threw / output was not parseable JSON. Body includes `message` and/or `raw`. |

### Field source rules

| Field | Source |
|-------|--------|
| `collocation` | Dictionary-grounded (B3). Dictionary candidates are looked up **before** any LLM call; the LLM only refines/annotates candidates. Ungrounded (no-candidates) → `NO_DICTIONARY_CANDIDATES`; the service **never** falls back to inventing collocations. Ungrounded LLM output items (phrases not in the candidate set) are **dropped** with a `warning` (drop not reject). |
| `example` / `corpus` | Internal LLM, with optional style profile (B4). Requires LLM; without it → `L2_CONTENT_UNAVAILABLE`. |
| `synonym` / `antonym` | Internal LLM. Requires LLM; without it → `L2_CONTENT_UNAVAILABLE`. |

## 3. POST /api/l2/:slug/external-prompt

Assemble a fully-formed prompt for an external chat tool **without calling the
LLM and without consuming the usage budget**. Works even when no LLM provider
is configured. The operator pastes the returned `prompt` into an external chat
tool, then confirms the result via `/confirm`.

For `field=collocation`, this endpoint is also dictionary-grounded: dictionary
candidates are looked up before prompt assembly. No provider, provider failure,
or empty candidates returns `NO_DICTIONARY_CANDIDATES`; the endpoint never emits
an ungrounded collocation prompt.

### Request

```jsonc
{
  "field": "collocation | example | corpus | synonym | antonym",
  "styleProfileId": "academic",        // optional
  "count": 5,                          // optional; positive integer
  "userInstruction": "free-text hint"  // optional
}
```

### Response (200)

```jsonc
{
  "field": "example",                  // composer-facing echo of the request field
  "storageField": "corpus",            // canonical storage field
  "styleProfileId": "academic",        // resolved profile id ("default" when none)
  "promptVersion": "l2-example-external-v1",  // stable version tag
  "promptHash": "<64-char sha256 hex>",       // sha256 of the assembled prompt text
  "prompt": "## system\n...\n\n## user\n...", // the assembled prompt text
  "expectedJsonSchema": { /* JSON-schema-ish description of expected output */ }
}
```

### Response — errors

| Status | `error`            | When |
|-------:|--------------------|------|
| 400    | `VALIDATION_ERROR` | Invalid field, or style profile scope mismatch, or `styleProfileId` given for synonym/antonym |
| 422    | `NO_DICTIONARY_CANDIDATES` | `field=collocation` and dictionary candidates are unavailable. No prompt is returned. |
| 500    | `INTERNAL_ERROR`   | Unexpected failure |

**Guarantees**: this endpoint does not call `llmProvider` and does not touch
`usageTracker`. It is safe to call repeatedly without budget impact. The
returned `expectedJsonSchema` is v1-first: external tools should return
`{ "schemaVersion": "l2-content-v1", "field": "...", "items": [...] }`, not a
legacy bare array.

## 4. POST /api/l2/:slug/confirm

Persist an approved draft and cascade the L2 cache + recheck inside a single
transaction (insert `word_l2_content` → `refreshL2Cache` → recompute
`l2_content_hash` → `markL2StaleForRecheck`). **Confirm is a pure DB cascade**
and never 503s for a missing LLM provider.

### Request — three accepted body shapes

The route normalizes the content payload into a single canonical value.
Precedence: `document` > `items` > `content`.

#### Shape 1 — legacy (bare array)

```jsonc
{
  "field": "collocation",
  "content": [ /* field-specific legacy items, see §6 */ ],
  "source": "manual"            // optional, default "manual"
}
```

#### Shape 2 — items (wrapped into a v1 document by the route)

```jsonc
{
  "field": "example",
  "items": [ /* v1 items carrying provenance */ ],
  "source": "external_chat",
  "sourceRef": "chatgpt://conv/abc-123"   // optional → word_l2_content.source_ref
}
```

#### Shape 3 — document (v1 wrapper passed through verbatim)

```jsonc
{
  "field": "example",
  "document": {
    "schemaVersion": "l2-content-v1",
    "field": "example",
    "items": [ /* v1 items carrying provenance */ ]
  },
  "source": "external_chat",
  "sourceRef": "chatgpt://conv/abc-123"
}
```

### Response

```jsonc
// success
{ "ok": true }
```

### Response — errors

| Status | `error`            | When |
|-------:|--------------------|------|
| 400    | `VALIDATION_ERROR` | Invalid field, or content/items/document do not conform to the field's schema (legacy or v1). Nothing is persisted. |
| 422    | (via service `ValidationError`) | Malformed content that bypassed the route's pre-check (defense-in-depth; the service re-validates with `parseL2Content`). |
| 404    | `NOT_FOUND`        | Word slug not found |
| 500    | `INTERNAL_ERROR`   | Unexpected failure |

### Validation contract

- The route validates content with `isValidL2Content(storageField, content)`
  **before** calling the service (→ 400 on mismatch).
- The service re-validates with `parseL2Content(field, content)` inside
  `confirmDraft` (defense-in-depth → `ValidationError` → 422) so callers that
  bypass HTTP can't write bad rows.
- **Provenance/evidence are never stripped.** The v1 wrapper and its item
  schemas use `.passthrough()`, so `provenance` (source, dictionaryName,
  dictionaryUrl, promptHash, externalTool, …) and `evidence` (rawPhrase,
  rawExample, …) round-trip through parse → insert intact.
- Dictionary-sourced collocations (`provenance.source` =
  `dictionary` | `dictionary_llm_refined`) must carry a `dictionaryName` (in
  provenance or evidence) — a dictionary claim without a dictionary name is
  rejected (superRefine).
- v1 collocations with any non-`manual` source (`llm`, `llm_edited`,
  `external_chat`, `dictionary`, `dictionary_llm_refined`) must carry
  dictionary evidence (`provenance.dictionaryName` or `evidence.dictionaryName`).
  `external_chat` collocations additionally require `evidence.rawPhrase`.

## 5. Field mapping (example → corpus)

| Request `field` | `storageField` | Stored JSONB column |
|-----------------|----------------|---------------------|
| `example`       | `corpus`       | `words.corpus_items` |
| `corpus`        | `corpus`       | `words.corpus_items` |
| `collocation`   | `collocation`  | `words.collocations` |
| `synonym`       | `synonym`      | `words.synonym_items` |
| `antonym`       | `antonym`      | `words.antonym_items` |

`example` is the composer-facing name; `corpus` is the storage name. The route
accepts both and always passes the canonical storage field to the service.

## 6. Item shapes

### Collocation (legacy)

```jsonc
[{ "phrase": "...", "gloss": "...", "tone": "formal|neutral|informal",
   "example": "...", "exampleTranslation": "..." }]
```

### Collocation (v1)

```jsonc
[{ "phrase": "...", "meaning": "...", "gloss": "...", "tone": "...",
   "example": "...", "exampleTranslation": "...",
   "provenance": { "source": "manual|llm|llm_edited|external_chat|dictionary|dictionary_llm_refined", ... },
   "evidence": { "dictionaryName": "...", "rawPhrase": "...", ... } }]
```
`phrase` is the only hard-required content field; `provenance` is mandatory.
For v1 collocation, `manual` items may omit dictionary evidence. Every
machine-generated/non-manual item must include dictionary evidence. For
`external_chat` collocations, `evidence.rawPhrase` is also required.

### Corpus / example (legacy)

```jsonc
[{ "text": "...", "translation": "...", "source": "..." }]
```

### Corpus / example (v1)

```jsonc
[{ "sentence": "...", // or legacy "text"
   "translation": "...", "usageNote": "...", "source": "...",
   "provenance": { "source": "...", ... } }]
```
Either `sentence` or `text` is required.

### Synonym / antonym (legacy only — no v1 schema yet)

```jsonc
[{ "word": "...", "semanticDiff": "...", "tone": "formal|neutral|informal",
   "usage": "...", "delta": "...", "object": "..." }]
```

## 7. Error code semantics

| Code | HTTP | Meaning |
|------|-----:|---------|
| `VALIDATION_ERROR` | 400 / 422 | Request body or content failed schema validation. 400 = route pre-check; 422 = service defense-in-depth. |
| `NO_DICTIONARY_CANDIDATES` | 422 | `field=collocation` and the dictionary had no candidates (no provider, provider failed, or empty result). Recoverable "no data" state; LLM never called. |
| `OVER_BUDGET` | 503 | Daily LLM token budget exceeded. No LLM call made. |
| `L2_CONTENT_UNAVAILABLE` | 503 | Field requires the LLM (corpus/synonym/antonym) but no LLM provider is configured. |
| `LLM_ERROR` | 500 | The LLM provider threw (network, auth, …). `message` included. Usage not recorded. |
| `PARSE_FAILED` | 500 | LLM output could not be parsed as JSON. `raw` included. Usage IS recorded (the call succeeded). |
| `NOT_FOUND` | 404 | Word slug not found. |
| `INTERNAL_ERROR` | 500 | Unexpected failure. |

## 8. Source / provenance values

Stored in `word_l2_content.source` and in each v1 item's `provenance.source`:

| Value | Meaning |
|-------|---------|
| `manual` | User-entered content |
| `llm` | Generated by the internal LLM |
| `llm_edited` | LLM-generated then user-edited |
| `external_chat` | Produced via the external-prompt flow (operator paste). Collocations must also carry dictionary evidence. |
| `dictionary` | Dictionary candidates only (no LLM refinement) |
| `dictionary_llm_refined` | Dictionary candidates refined by the LLM |

## 9. Non-goals (Phase 2E)

- L2 Composer is **not** a chat endpoint. There is no streaming, no
  multi-turn, no tool-use. Drafts are single-shot JSON.
- External-prompt output is **non-persistent and non-token-consuming** until
  confirmed via `/confirm`.
- Phase 2E does **not** introduce the L3 schema (see ADR-0005 / ADR-0006).
