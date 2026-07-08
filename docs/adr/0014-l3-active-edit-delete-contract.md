# ADR-0014: L3 Active Edit/Delete Contract

- **Status**: Accepted
- **Date**: 2026-07-08
- **Phase**: Phase 5C
- **Builds on**: ADR-0005, ADR-0007, ADR-0008, ADR-0010, ADR-0013

## Context

Phase 3A created the confirmed owner/manual active L3 write surface for
`l3_sources`, `l3_contexts`, `l3_occurrences`, and `l3_context_links`.
Phase 3B/3C/3E then added proposal, import, and recommendation producers for
unreviewed candidates. Phase 4B-4I added read/review/recommend/graph frontend
surfaces, and Phase 5B added a centralized Manual Editor for additive active
creates.

The remaining manual mutation question is edit/delete. Edit/delete can be useful
for owner correction, but it can also invalidate occurrence offsets, graph
semantics, recommendation evidence, and audit history. This ADR defines the
contract before implementation. Phase 5C is design-only: no production code,
endpoint, schema, migration, or frontend UI is added in this phase.

## Decision

Manual single-record, owner-authenticated, strongly validated edit/delete may
eventually act directly on active L3 rows, just like Phase 3A/5B confirmed
manual creates. This does not relax the proposal rule:

- proposal confirm remains the only upgrade path from unreviewed candidate rows
  into active L3 evidence
- import, recommendation, agent, MCP, LLM, parser, external-tool, and bulk
  edit/delete candidates must not bypass proposal/review/confirm or a future
  dedicated review pipeline
- Manual Editor remains a trusted owner command surface, not an automated
  content authority

Phase 5C.1 should use a conservative delete-only MVP:

- implement context link delete
- implement occurrence delete
- defer source delete
- defer context delete
- defer context text edit
- defer graph inline editing
- defer broad edit operations until an audit/event strategy exists

Prefer extending active L3 routes with PATCH/DELETE over adding
`/api/l3/manual/*` duplicates. The product surface may be called Manual Editor,
but the HTTP contract remains the active L3 owner/manual route family.

## Object-Level Policy

| Object | Create | Safe edit | Risky edit | Delete | MVP recommendation | Deferred reason | Stale surfaces | Audit/provenance requirement | Required validation | Forbidden side effects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `l3_sources` | Done in Phase 5B | `title`, `author`, `url`, `language`, selected `metadata` | `source_type`, `wordbook_id` | Deferred | No Phase 5C.1 source edit/delete | Source changes affect every child context, occurrence, link, source space, and graph path | Source Space, Word Space, Graph, child Context Detail | Edit needs manual actor and before/after audit; delete needs dedicated policy | Owner source, immutable `wordbook_id`, metadata schema if edited | No L1/L2/FSRS writes, no proposal/import/recommendation writes, no `words` JSONB/hash updates |
| `l3_contexts` | Done in Phase 5B | `normalized_text`, `language`, `position`, selected `metadata` | `text`, `source_id`, `context_type` | Deferred | No Phase 5C.1 context edit/delete | Text edit can invalidate all occurrence offsets and evidence; delete needs cascade/soft-delete policy | Context Detail, Source Space, Word Space, Graph | Text edit requires before/after audit and occurrence revalidation or explicit invalidation | Owner context, source ownership, offset/evidence policy for any text change | No silent occurrence retention after text drift; no proposal/import/recommendation/L1/L2/FSRS writes |
| `l3_occurrences` | Done in Phase 5B | `confidence`, selected `evidence` only after audit contract | `word_id`, `slug`, `surface`, `start_offset`, `end_offset`, `lemma` | Candidate | Phase 5C.1 delete by explicit id | Edit can rewrite word evidence and graph edges; delete is simpler and reversible only with new create | Context Detail, Word Space, Source Space, Graph | Delete can initially rely on service validation and active read stale; edit needs before/after audit | Owner occurrence, owner context, wordbook scope, exact offset/surface if edited | No `user_word_progress`, `user_word_l2_progress`, `word_l2_content`, `words` JSONB/hash, proposal/import/recommendation writes |
| `l3_context_links` | Done in Phase 5B | `confidence`, selected `provenance` only after audit contract | `link_type`, `target_type`, `target_id`, `target_ref`, anchor changes | Candidate | Phase 5C.1 delete by explicit id | Target edit changes graph semantics; model as delete old + create new | Context Detail, Word Space, Source Space, Graph | Delete can initially rely on service validation and active read stale; edit needs before/after audit | Owner link, owner context/anchor, active target validation, wordbook target scope | No proposal/import/recommendation writes, no L1/L2/FSRS writes, no graph read writes |

## MVP Recommendation

Phase 5C.1 should implement delete-only active owner commands:

- `DELETE /api/l3/context-links/:id`
- `DELETE /api/l3/occurrences/:id`

The operation must require an explicit id. The frontend must not infer ids from
labels, surface text, graph labels, row order, or display text. A second delete
of the same id should return either `404` or `409`; Phase 5C.1 must choose one
and freeze it in the HTTP contract. The conservative recommendation is `404`
because the owner-scoped active row no longer exists.

The response should be small and command-oriented:

```json
{
  "deleted": {
    "entityType": "context_link",
    "id": "..."
  },
  "activeReadInvalidation": true
}
```

```json
{
  "deleted": {
    "entityType": "occurrence",
    "id": "..."
  },
  "activeReadInvalidation": true
}
```

## Deferred Operations

Source edit/delete is deferred. Safe metadata edit may be useful later, but
`wordbook_id` must remain immutable after create because it defines the owner
wordbook scope for child evidence. Source delete needs a soft-delete/archive or
cascade policy before implementation.

Context edit/delete is deferred. Editing `text` is especially risky: every
occurrence offset and surface proof must be revalidated, invalidated, or
explicitly remapped. Silent retention of stale offsets is forbidden.

Occurrence edit is deferred except for a possible future evidence/confidence
safe-edit contract. Changing word, surface, or offsets is semantically closer to
delete old + create new and needs its own audit policy.

Context link edit is deferred except for a possible future confidence/provenance
safe-edit contract. Changing target or link type should be treated as delete old
+ create new to avoid semantic drift.

Graph inline editing, graph canvas delete, bulk edit/delete, agent/MCP/LLM
edit/delete, import parser edit/delete, and recommendation auto-delete are all
out of scope.

## API Direction

Prefer route family A:

- `PATCH /api/l3/sources/:id`
- `DELETE /api/l3/sources/:id`
- `PATCH /api/l3/contexts/:id`
- `DELETE /api/l3/contexts/:id`
- `PATCH /api/l3/occurrences/:id`
- `DELETE /api/l3/occurrences/:id`
- `PATCH /api/l3/context-links/:id`
- `DELETE /api/l3/context-links/:id`

Do not add route family B (`/api/l3/manual/*`) unless a future ADR splits the
active L3 route semantics. Keeping active owner/manual operations on active L3
routes avoids duplicate contracts and preserves the Phase 5B pattern.

## Frontend Direction

Manual Editor may add an explicit edit/delete panel in a later phase. Phase
5C.1 should start with delete-by-id controls for:

- context link id
- occurrence id

It should not add source/context delete UI, source/context text edit UI, graph
canvas delete, or inline editors on Graph, Context Detail, Word Space, or Source
Space pages.

Successful delete marks active read surfaces stale:

- Graph
- Context Detail
- Word Space
- Source Space

It must not mark proposal, import, or recommendation state as authoritative.
Failed requests preserve input. Delete requires explicit id and confirmation.

## Audit and Provenance

Phase 5C does not add an audit table because it is design-only. Phase 5C.1
delete-only can rely on service validation, owner scoping, and active read stale
without adding schema.

Any future edit implementation, especially source/context text edit or semantic
target edit, should design a dedicated audit/event table first. JSON provenance
is useful for evidence metadata, but it is not a complete before/after mutation
history.

## Isolation Guarantees

Manual edit/delete must stay inside the L3 active table family. It must not
write:

- `words` JSONB/cache/hash columns
- `word_l2_content`
- `user_word_progress`
- `user_word_l2_progress`
- FSRS state
- `l3_import_jobs`
- `l3_proposals`
- `l3_proposal_items`
- `l3_recommendation_runs`
- `l3_recommendation_items`

Phase 5C.1 delete-only SQL isolation should allow only:

- `DELETE FROM l3_context_links`
- `DELETE FROM l3_occurrences`

and continue to forbid L1/L2/FSRS/proposal/import/recommendation writes.

## Consequences

- The next implementation phase has a narrow, testable delete-only slice.
- Risky edit operations are not accidentally bundled with simple cleanup
  commands.
- Proposal/import/recommendation semantics remain unchanged.
- Active read stale semantics stay consistent with Phase 5B Manual Editor.
- Audit requirements are made explicit before introducing mutable evidence.
- No production code, endpoint, schema, migration, dependency, or UI behavior
  changes in Phase 5C.
