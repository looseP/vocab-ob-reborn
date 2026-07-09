# L3 Manual Editor Edit/Delete Contract

> Scope: Phase 5C design contract plus later delete-only implementation notes.
> The current backend exposes guarded source/context parent delete routes, while
> source/context delete UI and all PATCH operations remain deferred.

## Scope

Manual active edit/delete is a trusted owner command family for correcting
already-confirmed L3 evidence. It is separate from unreviewed proposal
producers. Manual edit/delete may operate directly on active L3 only when the
caller supplies an explicit row id and passes owner/business validation.

Phase 5C originally defined the contract. The implemented delete subset now
includes backend HTTP routes for occurrence, context link, source parent, and
context parent delete. It still adds no source/context delete UI, PATCH endpoint,
schema, migration, dependency, or graph editing behavior.

## Non-goals

- no `/api/l3/manual/*` route family
- no production PATCH implementation
- no source/context edit UI
- no source/context delete UI
- no context text edit
- no graph inline editing or canvas mutation
- no bulk edit/delete
- no agent/MCP/LLM/import/recommendation direct edit/delete
- no L1/L2/FSRS/dictionary changes
- no `words` JSONB/hash or `word_l2_content` writes
- no audit table in Phase 5C

## Object Policy Matrix

| Object | Safe edit | Risky edit | Delete policy | Phase 5C.1 recommendation | Stale surfaces | Audit requirement | Validation | Forbidden side effects |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Source | Future metadata/title fields only | `wordbook_id`, source ownership, broad type semantics | Backend HTTP-only guarded parent delete | Implement route only; keep UI deferred | Source Space, Word Space, Graph, child Context Detail | Dedicated audit before edit; delete uses blocker details and active-read invalidation | Owner source; immutable wordbook scope; blockers are child contexts, inbound context links, import jobs | No L1/L2/FSRS/proposal/import/recommendation writes |
| Context | Future metadata/position/language only | `text`, `source_id`, context type | Backend HTTP-only guarded parent delete | Implement route only; keep UI deferred | Context Detail, Source Space, Word Space, Graph | Dedicated audit plus offset policy before text edit; delete uses blocker details and active-read invalidation | Owner context; blockers are occurrences, anchored context links, inbound context links | No silent stale occurrence evidence |
| Occurrence | Future confidence/evidence only | word/surface/offset/lemma changes | Explicit id hard delete candidate | Implement delete by id | Context Detail, Word Space, Source Space, Graph | Delete can defer audit table; edit cannot | Owner occurrence; owner context; wordbook scope; exact offset if edited | No word progress, L2 content, words hash/cache, proposal/import/recommendation writes |
| Context Link | Future confidence/provenance only | link type, target type/id/ref, anchor changes | Explicit id hard delete candidate | Implement delete by id | Context Detail, Word Space, Source Space, Graph | Delete can defer audit table; edit cannot | Owner link; owner context/anchor; target validation if edited | No proposal/import/recommendation/L1/L2/FSRS writes |

## Delete-only MVP: Phase 5C.1

Phase 5C.1/Task 4C implements:

```http
DELETE /api/l3/context-links/:id
```

```json
{
  "deleted": {
    "entityType": "context_link",
    "id": "..."
  },
  "activeReadInvalidation": true
}
```

```http
DELETE /api/l3/occurrences/:id
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

```http
DELETE /api/l3/sources/:id
```

```json
{
  "deleted": {
    "entityType": "source",
    "id": "..."
  },
  "activeReadInvalidation": true
}
```

```http
DELETE /api/l3/contexts/:id
```

```json
{
  "deleted": {
    "entityType": "context",
    "id": "..."
  },
  "activeReadInvalidation": true
}
```

Rules:

- request id must be explicit
- id must be owner-scoped
- invalid id shape returns `400`
- missing or out-of-scope id returns `404`
- repeated delete returns `404`
- source/context parent delete with active blockers returns `409` with
  `details.entityType`, `details.id`, and `details.blockers`
- success marks active read surfaces stale
- success does not create or update proposals, imports, recommendations, L1/L2,
  FSRS, or `words`

## Deferred Edit Operations

Candidate future source PATCH:

```http
PATCH /api/l3/sources/:id
```

Allowed future fields may include `title`, `author`, `url`, `language`, and
selected `metadata`. `wordbookId` must stay immutable. Source parent delete is
implemented only as backend HTTP-only guarded hard delete when there are no
child contexts, inbound context links, or import jobs. Source delete UI,
soft-delete/archive behavior, and cascade policy for blocked sources remain
deferred.

Candidate future context PATCH:

```http
PATCH /api/l3/contexts/:id
```

Safe fields may include `normalizedText`, `language`, `position`, and selected
`metadata`. `text` edit is deferred because it requires occurrence offset and
surface evidence invalidation or revalidation. Context parent delete is
implemented only as backend HTTP-only guarded hard delete when there are no
occurrences, anchored context links, or inbound context links. Context delete UI
remains deferred.

Candidate future occurrence PATCH:

```http
PATCH /api/l3/occurrences/:id
```

Safe fields may include `confidence` and selected `evidence` after an audit
contract exists. Changing word, surface, or offsets should be treated as delete
old + create new unless a later ADR defines semantic edit behavior.

Candidate future context link PATCH:

```http
PATCH /api/l3/context-links/:id
```

Safe fields may include `confidence` and selected `provenance` after an audit
contract exists. Changing target or link type should be treated as delete old +
create new.

## API Contract Candidates

Prefer active route extension:

| Method | Path | Phase 5C status |
| --- | --- | --- |
| `PATCH` | `/api/l3/sources/:id` | Candidate, deferred |
| `DELETE` | `/api/l3/sources/:id` | Implemented backend HTTP-only guarded parent delete |
| `PATCH` | `/api/l3/contexts/:id` | Candidate, deferred |
| `DELETE` | `/api/l3/contexts/:id` | Implemented backend HTTP-only guarded parent delete |
| `PATCH` | `/api/l3/occurrences/:id` | Candidate, deferred |
| `DELETE` | `/api/l3/occurrences/:id` | Recommended for Phase 5C.1 |
| `PATCH` | `/api/l3/context-links/:id` | Candidate, deferred |
| `DELETE` | `/api/l3/context-links/:id` | Recommended for Phase 5C.1 |

Do not add `/api/l3/manual/*` duplicates. The Manual Editor is a product
surface; the HTTP contract is still active L3 owner/manual operations.

## Request/Response Shapes

Delete requests carry the id in the route. Phase 5C.1 should not require a JSON
body unless a later audit note requirement is added.

Success shape:

```json
{
  "deleted": {
    "entityType": "occurrence",
    "id": "occurrence-id"
  },
  "activeReadInvalidation": true
}
```

For source/context parent delete, use the same shape with `entityType` set to
`source` or `context`.

Future safe-edit success shape should use a parallel command result:

```json
{
  "updated": {
    "entityType": "context_link",
    "id": "link-id"
  },
  "activeReadInvalidation": true
}
```

## Error Semantics

| HTTP | Meaning |
| ---: | --- |
| 400 | invalid id shape or request body shape |
| 404 | row not found, outside owner scope, or repeated delete |
| 409 | source/context parent delete blocked by active dependencies |
| 422 | business validation failure, such as unsafe edit field or invalid target policy |
| 500 | unexpected failure |

Repeated delete returns `404`. Source/context parent delete returns `409` only
when the parent row exists but active blockers prevent deletion. The response
must preserve the service conflict details:

```json
{
  "code": "CONFLICT",
  "details": {
    "entityType": "source",
    "id": "...",
    "blockers": {
      "contextCount": 1,
      "inboundContextLinkCount": 0,
      "importJobCount": 0
    }
  }
}
```

Context blocker details use:

```json
{
  "occurrenceCount": 1,
  "contextLinkCount": 0,
  "inboundContextLinkCount": 0
}
```

## Stale Semantics

Manual edit/delete success marks active read stale:

- Graph
- Context Detail
- Word Space
- Source Space

It must not mark these authoritative:

- proposal state
- import state
- recommendation state

Graph, Context, Word, and Source successful reads may clear active read stale
using the existing frontend read-stale model.

## Isolation Requirements

Phase 5C.1 delete-only allowed SQL writes:

- `DELETE FROM l3_context_links`
- `DELETE FROM l3_occurrences`
- guarded `DELETE FROM l3_sources`
- guarded `DELETE FROM l3_contexts`

The source/context parent deletes are only allowed through the guarded
repository/service path. They must not be described as relying on database
cascade; active children and soft inbound references are blockers.

Forbidden SQL writes:

- `INSERT/UPDATE/DELETE` L1/L2/FSRS tables
- `UPDATE words`
- `INSERT/UPDATE l3_proposals`
- `INSERT/UPDATE l3_proposal_items`
- `INSERT/UPDATE l3_import_jobs`
- `INSERT/UPDATE l3_recommendation_runs`
- `INSERT/UPDATE l3_recommendation_items`
- `INSERT/UPDATE word_l2_content`
- `INSERT/UPDATE user_word_progress`
- `INSERT/UPDATE user_word_l2_progress`

## Frontend Requirements

Phase 5C.1 frontend can add a centralized Manual Editor delete-by-id panel for:

- occurrence id
- context link id

Requirements:

- explicit id only
- confirmation before delete
- no inference from label, surface, row order, graph label, or display text
- request failure preserves input
- submitting disables duplicate delete
- success marks active read stale
- no inline editing on Graph/Context/Word/Source read pages
- no source/context delete UI until a separate UX contract accepts blocker
  display and confirmation semantics
- no raw `fetch`
- no direct `/api/l3/` outside the shared frontend client

## Test Plan

Backend service/repository:

- delete context link rejects cross-user id
- delete occurrence rejects cross-user id
- delete context link succeeds owner-scoped
- delete occurrence succeeds owner-scoped
- guarded source parent delete succeeds only without blockers
- guarded context parent delete succeeds only without blockers
- source/context active blockers return `409` with blocker details
- repeated delete returns `404`
- delete invalid id shape returns route-level `400`
- deleting context link does not write proposal/import/recommendation/L1/L2/FSRS/words
- deleting occurrence does not update word progress or `word_l2_content`

HTTP:

- `DELETE /api/l3/context-links/:id` success shape
- `DELETE /api/l3/occurrences/:id` success shape
- `DELETE /api/l3/sources/:id` success shape
- `DELETE /api/l3/contexts/:id` success shape
- invalid id shape -> `400`
- out-of-scope id -> `404`
- repeated delete -> `404`
- active source/context blockers -> `409` with `details.entityType`,
  `details.id`, and `details.blockers`
- unexpected failure -> `500`

Frontend:

- delete form requires explicit id
- confirmation is required before command
- submitting disables duplicate delete
- success marks active read stale
- error preserves input
- no raw `fetch`
- no direct `/api/l3/` outside client contract
- read pages remain read-only

Cross-contract regression:

- import -> proposal -> confirm path unchanged
- recommendation accept -> proposal -> confirm path unchanged
- proposal confirm remains only unreviewed candidate upgrade path
- read graph remains read-only
- manual delete does not write import/recommendation/proposal rows

Isolation SQL:

- allow `DELETE FROM l3_context_links`
- allow `DELETE FROM l3_occurrences`
- allow guarded `DELETE FROM l3_sources`
- allow guarded `DELETE FROM l3_contexts`
- forbid proposal/import/recommendation/L1/L2/FSRS/words writes

## Future Phases

- Phase 5C.1: backend + frontend delete-only MVP for occurrence and context
  link
- Task 4C: backend HTTP-only guarded parent delete for source and context
- Task 4D: reconcile this contract documentation with Task 4C
- Phase 5D: evaluate dedicated audit/event table before safe edit
- Later: safe metadata/provenance/confidence edit if audit strategy is accepted
- Later: source/context delete UI only after blocker UX is accepted
- Later: soft-delete/archive/cascade policy if product requirements need deleting
  blocked parents
