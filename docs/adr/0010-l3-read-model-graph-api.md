# ADR-0010: L3 Read Model and Graph API

- **Status**: Accepted
- **Date**: 2026-07-08
- **Phase**: Phase 3D
- **Builds on**: ADR-0007, ADR-0008, ADR-0009

## Context

Phase 3A established confirmed owner/manual active L3 writes. Phase 3B added the
proposal review pipeline, and Phase 3C/3C.1 sealed deterministic import as a
proposal producer. UI and agent consumers now need a stable way to read active
L3 source, context, occurrence, and link evidence without adding another write
path.

## Decision

Phase 3D adds read-only service and HTTP projections:

- `GET /api/l3/contexts/:id`
- `GET /api/l3/words/:slug/space`
- `GET /api/l3/sources/:id/space`
- `GET /api/l3/graph`

The read service only calls `IL3ContextRepository` read methods. It does not
write `l3_sources`, `l3_contexts`, `l3_occurrences`, `l3_context_links`,
proposal tables, import jobs, L1/L2 progress tables, `word_l2_content`, or
`words` JSONB/cache columns.

## Graph Contract

Graph nodes are stable, agent-readable records:

- `word:{wordId}`
- `context:{contextId}`
- `source:{sourceId}`
- `l2_item:{contentId|hash|sourceRef|targetId|stableHash(targetRef)}`
- `topic:{stableHash(label|topic|name|targetId|targetRef)}`
- `external:{targetId|stableHash(targetRef)}`

Graph edges include:

- `word -> context` as `occurs_in`
- `context -> source` as `belongs_to`
- `context|word -> target` from `l3_context_links`

`l2_item`, `topic`, and `external` targets remain soft nodes. Phase 3D does not
join L2 content, dictionary, LLM output, or recommendation data.

Phase 3D.1 seals the graph identity contract:

- nodes are de-duplicated by deterministic node id
- occurrence edges are semantic ids keyed by word, context, surface, and offsets
- context-link edges are semantic ids keyed by link type, source node, target
  node, target id, and sorted target ref
- duplicate database rows for the same semantic occurrence/link produce one
  graph edge
- nodes sort by type priority, then label, then id
- edges sort by type, source node, target node, then id

Active `word`, `context`, and `source` link targets are emitted from stored
`target_id` values that were validated during active writes or proposal confirm.
The read graph does not add extra target-row joins. This keeps Phase 3D read-only
and bounded; cross-owner active targets are excluded by the supported write and
confirm service paths, and graph queries still begin from owner-scoped sources
and contexts.

## Bounds and Isolation

Word/source space endpoints default to `limit=50` and cap at `100`. Graph
defaults to `limit=100`, caps at `300`, defaults to `depth=1`, and caps at
`depth=2`. Repository queries are user-scoped and use deterministic
`created_at DESC, id DESC` pagination.

`depth` is reserved as a traversal budget for graph consumers. Phase 3D.1
returns the bounded page of owner-scoped contexts, sources, occurrences, and
direct stored links; it does not recursively traverse into extra contexts,
sources, L2 records, external systems, recommendations, or dictionary data.

Wordbook-scoped reads respect `l3_sources.wordbook_id`: a word space or graph
filter with `wordbookId` only returns contexts from sources in that wordbook.
If a `slug + wordbookId` pair does not resolve to a word in that wordbook, the
service returns `404` before graph repository access.

## Consequences

- Active L3 write semantics remain unchanged.
- Import/proposal/confirm remains the only unreviewed-to-active upgrade path.
- UI and agents can consume active L3 evidence through stable read contracts.
- Phase 3D intentionally does not implement recommendation ranking, MCP,
  frontend work, LLM parsing, dictionary lookup, or L2 joins.
