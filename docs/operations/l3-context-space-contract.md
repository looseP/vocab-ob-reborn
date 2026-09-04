# L3 Context Space Contract

> Scope: Phase 3A backend foundation for authentic contexts, sources,
> occurrences, links, and minimal import jobs.

All `/api/l3/*` routes require owner auth. The HTTP layer only calls
`L3ContextService`; it does not import repositories, DB, dictionary, or LLM.

Phase 3A writes are confirmed owner/manual writes. They are not an agent
proposal system. Phase 3B adds `/api/l3/proposals*` for automated or unreviewed
agent/import/external candidates; those candidates must be confirmed before they
can write active L3 rows.

Phase 3C adds `/api/l3/imports/*` as a deterministic proposal producer. Import
routes create import jobs and proposal items only. Active L3 rows still enter
through confirmed owner/manual Phase 3A writes or Phase 3B proposal confirm.

Phase 3D adds read-only projections for active L3 evidence:
`GET /api/l3/contexts/:id`, `GET /api/l3/words/:slug/space`,
`GET /api/l3/sources/:id/space`, and `GET /api/l3/graph`. These routes do not
add write surface and do not change import/proposal/confirm semantics.

Phase 3E adds `/api/l3/recommendations*` as a suggestion layer. Recommendation
generation may read L1/L2/L3/FSRS signals and write recommendation run/items,
but it does not write active L3 rows or learning progress. Accepting a
`link_gap` recommendation creates a proposal bridge only; active links still
require normal proposal confirmation.

## Table Family

| Table | Purpose |
| --- | --- |
| `l3_sources` | Source metadata such as article/book/video/manual/web title, author, URL, language, and metadata. |
| `l3_contexts` | A concrete sentence, paragraph, excerpt, dialogue, or note from a source. |
| `l3_occurrences` | A word occurrence inside a context, linked by `word_id` and optional offsets/evidence. |
| `l3_context_links` | Extensible graph links between contexts, words, L2 items, topics, sources, or external refs. |
| `l3_import_jobs` | Import bookkeeping for deterministic Phase 3C import-to-proposal jobs. |
| `l3_recommendation_runs` | Phase 3E deterministic recommendation generation runs. |
| `l3_recommendation_items` | Phase 3E auditable recommendation candidates with evidence and status. |

Owner isolation is enforced twice:

- service methods scope sources, contexts, target lookups, and optional
  `wordbookId` to the authenticated owner
- DB constraints add `(id, user_id)` owner keys and composite child FKs for
  source -> context -> occurrence/link ownership

## API

### POST `/api/l3/sources`

Request:

```json
{
  "wordbookId": "optional-wordbook-uuid",
  "sourceType": "article",
  "title": "Essay on attention",
  "author": "A. Writer",
  "url": "https://example.com/essay",
  "language": "en",
  "metadata": { "origin": "manual" }
}
```

If `wordbookId` is supplied, it must belong to the authenticated owner. Otherwise
the request returns `404 NOT_FOUND`.

Response `201`:

```json
{
  "source": {
    "id": "uuid",
    "user_id": "uuid",
    "wordbook_id": null,
    "source_type": "article",
    "title": "Essay on attention",
    "author": "A. Writer",
    "url": "https://example.com/essay",
    "language": "en",
    "metadata": { "origin": "manual" },
    "created_at": "2026-07-08T00:00:00.000Z",
    "updated_at": "2026-07-08T00:00:00.000Z"
  }
}
```

### POST `/api/l3/contexts`

Request:

```json
{
  "sourceId": "uuid",
  "contextType": "sentence",
  "text": "She gave a vivid account of the storm.",
  "normalizedText": "she gave a vivid account of the storm.",
  "language": "en",
  "position": { "section": "intro", "start": 0, "end": 40 },
  "metadata": { "reviewed": true }
}
```

Response `201`:

```json
{
  "context": {
    "id": "uuid",
    "source_id": "uuid",
    "user_id": "uuid",
    "context_type": "sentence",
    "text": "She gave a vivid account of the storm.",
    "normalized_text": "she gave a vivid account of the storm.",
    "language": "en",
    "position": { "section": "intro", "start": 0, "end": 40 },
    "metadata": { "reviewed": true },
    "created_at": "2026-07-08T00:00:00.000Z",
    "updated_at": "2026-07-08T00:00:00.000Z"
  }
}
```

### POST `/api/l3/occurrences`

Request:

```json
{
  "contextId": "uuid",
  "slug": "vivid",
  "surface": "vivid",
  "lemma": "vivid",
  "startOffset": 11,
  "endOffset": 16,
  "confidence": 1,
  "evidence": { "method": "manual" }
}
```

Response `201`:

```json
{
  "occurrence": {
    "id": "uuid",
    "context_id": "uuid",
    "word_id": "uuid",
    "user_id": "uuid",
    "surface": "vivid",
    "lemma": "vivid",
    "start_offset": 11,
    "end_offset": 16,
    "confidence": "1.0000",
    "evidence": { "method": "manual" },
    "created_at": "2026-07-08T00:00:00.000Z"
  }
}
```

If both offsets are supplied, `text.slice(startOffset, endOffset)` must match
`surface` exactly using case-sensitive comparison. Partial offsets are invalid.
When the source has `wordbook_id`, `wordId`/`slug` must resolve inside that
wordbook. When the source has no `wordbook_id`, word lookup remains global while
the L3 row itself remains owner-scoped.

### POST `/api/l3/context-links`

Request:

```json
{
  "contextId": "uuid",
  "wordId": "uuid",
  "linkType": "illustrates",
  "targetType": "word",
  "targetId": "uuid",
  "confidence": 0.9,
  "provenance": { "source": "manual" }
}
```

Response `201`:

```json
{
  "link": {
    "id": "uuid",
    "user_id": "uuid",
    "context_id": "uuid",
    "word_id": "uuid",
    "link_type": "illustrates",
    "target_type": "word",
    "target_id": "uuid",
    "target_ref": {},
    "confidence": "0.9000",
    "provenance": { "source": "manual" },
    "created_at": "2026-07-08T00:00:00.000Z"
  }
}
```

Target validation:

- `targetType=word` requires UUID `targetId` and the word must exist. If
  `contextId` is supplied and the context source has `wordbook_id`, the target
  word must resolve inside that same wordbook.
- `targetType=context` requires UUID `targetId` owned by the authenticated user.
- `targetType=source` requires UUID `targetId` owned by the authenticated user.
- `targetType=l2_item` is a soft reference: `targetRef.field` is required plus
  one of `targetRef.contentId`, `targetRef.hash`, or `targetRef.sourceRef`.
- `targetType=external` and `targetType=topic` may use `targetRef` as a soft
  external/topic reference.

If `contextId` and anchor `wordId` are both supplied and the context source has
`wordbook_id`, the anchor word must also resolve inside that same wordbook. A
link without `contextId` keeps global word validation for anchor and target
words because no source wordbook scope is available.

### GET `/api/l3/words/:slug/contexts`

Query:

- `limit` optional, default `50`, max `100`
- `cursor` optional opaque page cursor
- malformed `cursor` returns `422 VALIDATION_ERROR`; it never falls back to the
  first page

Response `200`:

```json
{
  "items": [
    {
      "context": {
        "id": "uuid",
        "source_id": "uuid",
        "user_id": "uuid",
        "context_type": "sentence",
        "text": "She gave a vivid account of the storm.",
        "normalized_text": "she gave a vivid account of the storm.",
        "language": "en",
        "position": {},
        "metadata": {},
        "created_at": "2026-07-08T00:00:00.000Z",
        "updated_at": "2026-07-08T00:00:00.000Z"
      },
      "source": {
        "id": "uuid",
        "user_id": "uuid",
        "wordbook_id": null,
        "source_type": "article",
        "title": "Essay on attention",
        "author": null,
        "url": null,
        "language": "en",
        "metadata": {},
        "created_at": "2026-07-08T00:00:00.000Z",
        "updated_at": "2026-07-08T00:00:00.000Z"
      },
      "occurrence": {
        "id": "uuid",
        "context_id": "uuid",
        "word_id": "uuid",
        "user_id": "uuid",
        "surface": "vivid",
        "lemma": "vivid",
        "start_offset": 11,
        "end_offset": 16,
        "confidence": "1.0000",
        "evidence": {},
        "created_at": "2026-07-08T00:00:00.000Z"
      },
      "links": []
    }
  ],
  "limit": 50,
  "cursor": null,
  "nextCursor": null
}
```

### GET `/api/l3/sources/:id/contexts`

Returns context-level items scoped to a source owned by the authenticated user.
Each context appears once and aggregates all occurrences and links attached to
that context.

Response item shape:

```json
{
  "items": [
    {
      "context": { "id": "uuid", "text": "She gave a vivid account of the storm." },
      "source": { "id": "uuid", "title": "Essay on attention" },
      "occurrences": [
        { "id": "uuid", "surface": "vivid" },
        { "id": "uuid", "surface": "storm" }
      ],
      "links": []
    }
  ],
  "limit": 50,
  "cursor": null,
  "nextCursor": null
}
```

## Error Semantics

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `VALIDATION_ERROR` | Body or query failed route-level Zod validation. |
| 404 | `NOT_FOUND` | Source, context, or word does not exist or is outside user scope. |
| 422 | `VALIDATION_ERROR` | Business validation failed, such as invalid offsets, surface mismatch, malformed cursor, or invalid link target reference. |
| 500 | `INTERNAL` | Unexpected failure. |

## Isolation Guarantee

Phase 3A L3 writes only the `l3_` table family. They do not:

- write `words` JSONB content columns
- write `word_l2_content`
- modify `user_word_progress`
- modify `user_word_l2_progress`
- update L1/L2 content hashes or stale/recheck flags
- import dictionary or LLM modules
- consume LLM usage budget

## Future Extension Points

- import parser workers can create `l3_import_jobs` and proposal items
- recommendation builders can create `l3_recommendation_runs` and
  `l3_recommendation_items`, then bridge accepted `link_gap` items into
  proposals
- full-text or vector search can index `l3_contexts.text`
- L2 dictionary/corpus providers can read occurrences as a grounded evidence tier
- agent workflows can add richer `l3_context_links` targets without changing the
  core review scheduling tables
