# L3 Import API Contract

> Scope: Phase 3C deterministic import-to-proposal builder for raw text and
> structured L3 context candidates.

All `/api/l3/imports/*` routes require owner auth. Routes call
`L3ImportService` only. They do not import repositories, DB, dictionary, LLM,
MCP, recommendation, parser internals, or frontend code.

## Relationship to Proposals

Import routes are proposal producers. They create `l3_import_jobs` as
`processing`, then call the existing Phase 3B proposal service to create a
pending `l3_proposals` envelope and ordered `l3_proposal_items`. Successful
proposal creation marks the import job `completed`; proposal creation failure
marks it `failed`.

Import routes never write active L3 rows:

- `l3_sources`
- `l3_contexts`
- `l3_occurrences`
- `l3_context_links`

Only `POST /api/l3/proposals/:id/confirm` can promote import-generated proposal
items into active L3 evidence.

## Parser Behavior

Raw text parsing is deterministic and intentionally narrow:

- default context split is sentence mode on `.`, `?`, `!`, `。`, `？`, `！`
- paragraph mode splits on blank lines
- original context text is preserved
- `maxContexts` defaults to `50` and is capped at `200`
- `minContextLength` defaults to `3`
- `maxOccurrencesPerWordPerContext` defaults to `3`
- occurrence generation only uses explicit `targetWords`
- target words are resolved and deduplicated by resolved `wordId`; slug is the
  fallback key if a resolver cannot provide an id
- target slug matching is exact word-boundary matching and case-insensitive
- `surface` preserves the original source slice
- `startOffset` and `endOffset` are relative to the generated context text
- max-context truncation emits `Context limit reached; remaining contexts
  skipped.`
- `skippedContextCount` includes contexts skipped for `minContextLength` and
  contexts skipped after `maxContexts` is reached

No lemmatization, synonym expansion, dictionary lookup, LLM parsing, vector
search, or full-text search is performed in Phase 3C.

## Endpoints

### POST `/api/l3/imports/raw-text`

Request:

```json
{
  "wordbookId": "00000000-0000-4000-8000-000000000001",
  "source": {
    "sourceType": "article",
    "title": "Essay on attention",
    "url": "https://example.com/essay",
    "language": "en",
    "metadata": { "origin": "paste" }
  },
  "text": "She gave a vivid account of the storm. The storm grew stronger.",
  "targetWords": [
    { "slug": "vivid" },
    { "slug": "storm" }
  ],
  "options": {
    "contextType": "sentence",
    "maxContexts": 50,
    "maxOccurrencesPerWordPerContext": 3
  },
  "provenance": { "source": "manual_import" }
}
```

Response `201`:

```json
{
  "importJob": {
    "id": "uuid",
    "user_id": "uuid",
    "status": "completed",
    "input_hash": "sha256",
    "stats": {
      "contextCount": 2,
      "occurrenceCount": 3,
      "linkCount": 0,
      "skippedContextCount": 0,
      "warnings": []
    }
  },
  "proposal": {
    "id": "uuid",
    "source_type": "import",
    "status": "pending",
    "proposed_by": "l3_import_builder"
  },
  "items": [],
  "parseStats": {
    "contextCount": 2,
    "occurrenceCount": 3,
    "linkCount": 0,
    "skippedContextCount": 0,
    "warnings": []
  }
}
```

If `targetWords` is omitted or empty, raw import creates only source and context
proposal items and returns a warning that occurrences were not generated.
Duplicate target words do not create duplicate occurrence proposal items.

### POST `/api/l3/imports/structured`

Request:

```json
{
  "wordbookId": "00000000-0000-4000-8000-000000000001",
  "source": {
    "sourceType": "manual",
    "title": "Collected examples",
    "language": "en"
  },
  "contexts": [
    {
      "clientRef": "ctx-1",
      "contextType": "sentence",
      "text": "She gave a vivid account of the storm.",
      "language": "en",
      "occurrences": [
        {
          "slug": "vivid",
          "surface": "vivid",
          "startOffset": 11,
          "endOffset": 16,
          "confidence": 1
        }
      ],
      "links": [
        {
          "linkType": "illustrates",
          "targetType": "external",
          "targetRef": { "url": "https://example.com" }
        }
      ]
    }
  ],
  "provenance": { "source": "external_agent" }
}
```

Response `201` uses the same envelope as raw text import. Structured import
sets `parseStats.contextCount` from `contexts.length`,
`parseStats.occurrenceCount` from supplied occurrence count, and
`parseStats.linkCount` from supplied link count.

## Proposal Item Rules

Every import proposal starts with a source item:

- `clientRef = "source-1"`
- payload contains source metadata
- payload inherits `wordbookId` when supplied

Each context creates one context item:

- raw context refs use `context-{n}`
- structured imports may supply `clientRef`
- payload uses `sourceRef = "source-1"`

Each occurrence creates one occurrence item:

- payload uses `contextRef`
- payload includes `wordId` or `slug`, `surface`, offsets, confidence, and
  evidence
- raw text evidence includes `importJobId`, `method:
  deterministic_text_match`, and `source: raw_text_import`

Structured links create `context_link` items with `contextRef`, optional anchor
`wordId`, target fields, confidence, and provenance. Raw text import does not
auto-generate links.

For `targetType=context` and `targetType=source`, structured import requires an
active `targetId`. Intra-proposal target references such as
`targetRef.contextRef` or `targetRef.sourceRef` are not supported in Phase 3C.1;
confirm the proposal first, then create a link to the active context/source id.

## Error Semantics

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `VALIDATION_ERROR` | HTTP body failed route-level schema validation. |
| 404 | `NOT_FOUND` | Wordbook or target word does not exist or is outside owner scope. |
| 422 | `VALIDATION_ERROR` | Business validation failed, such as empty source title, text over service limit, malformed target word, or invalid structured enums. |
| 500 | `INTERNAL` | Unexpected failure. If this happens after an import job exists, the job is marked `failed`. |

## Isolation Guarantee

Import creation SQL may write only:

- `l3_import_jobs`
- `l3_proposals`
- `l3_proposal_items`

It must not write:

- `l3_sources`
- `l3_contexts`
- `l3_occurrences`
- `l3_context_links`
- `word_l2_content`
- `user_word_progress`
- `user_word_l2_progress`
- `words` JSONB cache columns or content hash columns

The parser helper is pure and does not import DB, repositories, HTTP, LLM,
dictionary, MCP, recommendation, or frontend modules.
