# L3 Read and Graph API Contract

> Scope: Phase 3D read-only active L3 projections for context detail, word
> space, source space, and graph consumers.

All `/api/l3/*` routes require owner auth. Phase 3D read routes call
`L3ReadService` only. They do not create proposals, import jobs, active L3 rows,
recommendations, MCP actions, LLM requests, dictionary lookups, frontend state,
or L1/L2 progress changes.

Phase 3E recommendations may read this sealed graph/read contract as evidence,
but they are exposed through separate `/api/l3/recommendations*` endpoints.
Graph routes remain read-only and never create recommendation rows.

Phase 3G seals this at the HTTP layer: `/api/l3/graph` parses camelCase query
parameters, calls only `L3ReadService.getGraph`, returns `400` for route schema
errors, maps service `ValidationError` to `422`, maps missing/out-of-scope rows
to `404`, and maps unexpected failures to `500`.

## Endpoints

### GET `/api/l3/contexts/:id`

Returns a context detail projection:

```json
{
  "context": { "id": "uuid", "source_id": "uuid", "text": "A vivid context." },
  "source": { "id": "uuid", "title": "Essay" },
  "occurrences": [],
  "links": []
}
```

Missing or out-of-owner-scope contexts return `404 NOT_FOUND`.

### GET `/api/l3/words/:slug/space`

Query:

- `wordbookId` optional UUID
- `limit` optional, default `50`, max `100`
- `cursor` optional

Returns:

```json
{
  "word": { "id": "uuid", "slug": "vivid" },
  "contexts": [],
  "sources": [],
  "occurrences": [],
  "links": [],
  "stats": { "sourceCount": 0, "contextCount": 0, "occurrenceCount": 0, "linkCount": 0 },
  "limit": 50,
  "cursor": null,
  "nextCursor": null
}
```

When `wordbookId` is supplied, the word must exist in that wordbook and returned
contexts must come from sources whose `wordbook_id` matches it.

### GET `/api/l3/sources/:id/space`

Query:

- `limit` optional, default `50`, max `100`
- `cursor` optional

Returns one source plus context-level aggregated occurrences and links.

### GET `/api/l3/graph`

Query:

- `wordbookId` optional UUID
- `slug` optional word slug
- `sourceId` optional UUID
- `depth` optional, default `1`, max `2`
- `limit` optional, default `100`, max `300`
- `cursor` optional

`depth` is a bounded traversal budget, not permission to scan all L3 data.
Phase 3D.1 materializes the selected page of owner-scoped contexts, their
sources, occurrences, and directly stored context links. `depth=2` is accepted
for forward-compatible clients, but it does not recursively fetch additional
contexts, sources, L2 rows, external systems, recommendations, or dictionary
records beyond the bounded page.

## Node Contract

- `word:{wordId}` for active words
- `context:{contextId}` for active L3 contexts
- `source:{sourceId}` for active L3 sources
- `l2_item:{contentId|hash|sourceRef|targetId|stableHash(targetRef)}` for soft L2 references
- `topic:{stableHash(label|topic|name|targetId|targetRef)}` for soft topic references
- `external:{targetId|stableHash(targetRef)}` for soft external references

`l2_item`, `topic`, and `external` nodes are soft targets from
`l3_context_links.target_ref`. Phase 3D does not join L2 tables or external
systems.

Node ids are deterministic and de-duplicated by id. Active target nodes for
`word`, `context`, and `source` links use the stored active `target_id` from a
link that was validated on write/confirm. Graph reads do not perform additional
target-row joins; unsupported cross-owner active links cannot be created through
the Phase 3A/3B/3C service paths, and read queries only start from owner-scoped
contexts and sources.

Soft target ids use stable, sorted-json hashes when a natural id is absent:
`l2_item` prefers `contentId`, then `hash`, then `sourceRef`, then `targetId`;
`topic` prefers `label`, `topic`, `name`, then `targetId`, then `targetRef`;
`external` prefers `targetId`, then `targetRef`.

## Edge Contract

- `occurs_in`: `word -> context`
- `belongs_to`: `context -> source`
- context links: `context|word -> target` using the stored link type as
  `edge.type`

Edge ids are deterministic semantic ids. Duplicate rows that describe the same
semantic occurrence or context link collapse to one graph edge:

- `occurs_in` key: `wordId + contextId + surface + startOffset + endOffset`
- `belongs_to` key: `contextId + sourceId`
- context-link key:
  `linkType + targetType + sourceNodeId + targetNodeId + targetId + targetRef`

Output ordering is stable and independent of database row order:

- nodes sort by type priority (`word`, `context`, `source`, `l2_item`, `topic`,
  `external`), then `label`, then `id`
- edges sort by `type`, then `sourceNodeId`, then `targetNodeId`, then `id`

## Frontend Visualization Contract

Phase 4G visualizes this read model without changing it:

- The visual canvas may reorder nodes for deterministic display layout, but it
  must not add or remove graph response nodes.
- The visual canvas may reorder edges for deterministic display layering, but it
  must not add or remove graph response edges.
- Node and edge details shown by the frontend must come from the selected
  response node or edge object.
- Unknown node or edge types must render with safe fallback labels/styles and
  must not fail the read surface.
- Empty graph responses should render a clear empty state rather than an empty
  SVG that implies a rendering error.
- The frontend must not persist layout positions, create graph edits, infer
  missing context links, query extra backend routes, or treat visualization
  selection as active L3 mutation state.

## Frontend Cross-Navigation Contract

Phase 4H may use graph response data for local navigation handoffs, but it does
not expand the graph API:

- `context` nodes may open Context Detail only from explicit `contextId`.
- `source` nodes may open Source Space only from explicit `sourceId`.
- `word` nodes may open Word Space only from explicit `slug`; `wordId` alone is
  not enough because the frontend word read surface is slug-based.
- Optional `wordbookId` must be preserved when present in graph `ref` or
  `metadata`.
- Edge actions may open source/target node read surfaces only by resolving those
  endpoint nodes from the same graph response.
- The frontend must not infer slug/id from graph label, context surface text, or
  row order.
- `l2_item`, topic, external, unknown, and missing-target nodes are displayed as
  metadata-only targets unless a future read surface defines a stable frontend
  target.

Phase 4I release smoke does not change this contract. Graph selection and
selection navigation remain local display behavior over the latest
`GET /api/l3/graph` response. Browser smoke and Vitest coverage may assert that
selection exposes enabled or disabled actions, but they must not add a graph
edit path, issue extra API requests from selection alone, infer missing ids or
slugs, or expand the backend graph response.

## Error Semantics

- route schema errors return `400`
- business validation errors, including invalid cursors from repository decode,
  return `422`
- missing or out-of-scope active rows return `404`
- malformed `depth`, out-of-range `depth`, and out-of-range `limit` query
  parameters are route schema errors and return `400`
- a `slug + wordbookId` graph/word-space filter where the slug is not in that
  wordbook returns `404` before the graph repository read, avoiding cross-
  wordbook leakage

## Isolation

Phase 3D read SQL is `SELECT` only. It must not issue `INSERT`, `UPDATE`, or
`DELETE`, and must not touch `word_l2_content`, `user_word_progress`,
`user_word_l2_progress`, `UPDATE words`, import jobs, proposal tables,
recommendation tables, or active L3 write tables.
