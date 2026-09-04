# L3 Manual Editor Frontend Contract

> Scope: Phase 5A design contract for a future Phase 5B frontend Manual Editor.
> This document does not implement UI or add dependencies.

## Phase 5C Edit/Delete Note

Phase 5C defines future edit/delete behavior without implementing UI. The
recommended Phase 5C.1 frontend slice is a centralized Manual Editor
delete-by-id panel for occurrence and context link rows only.

The frontend must keep Graph, Context Detail, Word Space, and Source Space
read-only. Delete must require an explicit id and confirmation, preserve input
on failure, disable duplicate submit while pending, and mark active read
surfaces stale only after success. Source/context delete, source/context edit,
context text edit, graph canvas editing, bulk edit/delete, and automated
agent/import/recommendation edit/delete are deferred.

The Manual Editor is the first planned active L3 create surface in the
frontend. It must be visually and behaviorally distinct from the read-only
Context, Word Space, Source Space, and Graph pages sealed in Phase 4I.

## Phase 5B Implementation Status

Phase 5B implements the centralized `L3ManualEditorPage` as the frontend MVP
for additive active L3 creates. The page exposes four explicit single-record
commands only:

- create source through `L3FrontendClient.createSource`
- create context through `L3FrontendClient.createContext`
- create occurrence through `L3FrontendClient.createOccurrence`
- create context link through `L3FrontendClient.createContextLink`

The page is not an inline editor for Graph, Context Detail, Word Space, or
Source Space. It keeps the Phase 5A boundary intact: no edit, delete, bulk
paste direct-to-active, auto extraction, agent/MCP/LLM, import parser,
recommendation builder, or proposal-confirm semantic expansion.

Successful manual creates mark active read surfaces stale and offer local
handoff actions to Source Space, Context Detail, Word Space when an explicit
slug is available, and Graph. The manual create stale signal does not mark
proposal, import, or recommendation state as authoritative.

## Product Scope

Phase 5B MVP should provide one centralized page:

- `L3ManualEditorPage`

Preferred flow:

1. choose or create source
2. add context under source
3. add occurrence under context
4. add context link from context or word anchor

The MVP should avoid inline editing on read pages. Read pages may offer future
"Open in Manual Editor" handoffs, but they should not become editors in Phase
5B.

## Non-goals

Phase 5B frontend should not implement:

- edit active source/context/occurrence/link
- delete active source/context/occurrence/link
- graph editing or manual link drawing on the graph canvas
- node drag persistence
- bulk paste direct-to-active creation
- MCP agent UI
- router or URL deep-link sync
- new frontend dependencies
- frontend inference of ids or slugs from labels, surfaces, graph labels, or
  row order

## Command Model

Manual editor commands call the existing `L3FrontendClient` active-create
methods:

| UI command | Endpoint | Active write? | Proposal write? | Stale effect |
| --- | --- | ---: | ---: | --- |
| Create source | `POST /api/l3/sources` | Yes | No | Source/Graph reads may be stale. |
| Create context | `POST /api/l3/contexts` | Yes | No | Context/Source/Word/Graph reads may be stale. |
| Create occurrence | `POST /api/l3/occurrences` | Yes | No | Context/Word/Source/Graph reads may be stale. |
| Create context link | `POST /api/l3/context-links` | Yes | No | Context/Word/Source/Graph reads may be stale. |
| Bulk paste contexts | import/proposal path | No | Yes | Proposal list only until confirm. |

Manual create success should mark active read surfaces stale, not proposal or
recommendation state. Import success and recommendation accept semantics remain
unchanged.

## UI State Machine

Each create step should use explicit states:

- `editing`
- `submitting`
- `created`
- `failed`

Rules:

- `submitting` disables duplicate submit.
- Failed requests preserve user input.
- Success preserves created ids and shows follow-up navigation actions.
- Switching away from the page must not imply rollback; the active row already
  exists after success.
- Empty states must not imply proposal confirmation or import success.

## Source Step

Fields:

- source type
- title
- optional wordbook id
- optional author
- optional URL
- optional language
- optional metadata JSON or structured metadata fields

Validation:

- title required locally before request
- source type chosen from the known enum
- metadata JSON, if exposed as raw text, must parse before request

Success actions:

- Open Source Space
- Add Context
- Open Graph for this source

## Context Step

Fields:

- source id, selected from prior create or typed explicitly
- context type
- text
- optional normalized text
- optional language
- optional position JSON
- optional metadata JSON

Validation:

- source id required
- context type chosen from known enum
- text required locally before request
- JSON fields must parse before request

Success actions:

- Open Context
- Add Occurrence
- Add Link
- Open Source Space

## Occurrence Step

Fields:

- context id, selected from prior create or typed explicitly
- word id or slug
- surface
- optional start/end offsets
- optional lemma
- optional confidence
- optional evidence JSON

Surface helper:

- If the user provides surface but no offsets, the UI may scan the loaded or
  manually supplied context text.
- One exact case-sensitive match may prefill offsets.
- Multiple matches must require user selection.
- No match must leave offsets blank and explain that backend exact validation
  will fail if offsets are submitted incorrectly.
- The backend remains authoritative and must validate
  `context.text.slice(startOffset, endOffset) === surface`.

Success actions:

- Open Context
- Open Word Space when explicit slug is known
- Open Graph for the word or source when explicit ids/slugs are known

## Context Link Step

Fields:

- context id and/or anchor word id
- link type
- target type
- target id for active word/context/source targets
- target ref JSON for soft `l2_item`, `topic`, or `external` targets
- optional confidence
- provenance JSON, defaulting to `{ "source": "manual" }`

Validation:

- at least one anchor required
- link type and target type selected from known enums
- active target ids must be explicit ids, never inferred labels
- `l2_item` target ref requires `field` plus `contentId`, `hash`, or
  `sourceRef`
- JSON fields must parse locally before request

Success actions:

- Open Context
- Open Graph
- Open target read surface only when the response or submitted payload has an
  explicit supported id/slug

## Error UX

Manual Editor uses the same normalized L3 error UI contract as Phase 4:

- `400`: local/request shape needs correction
- `404`: source/context/word/wordbook/target missing or out of owner scope
- `409`: reserved conflict state
- `422`: business validation failed
- `500`: unexpected service error
- network/aborted: transport feedback

Errors must not render `[object Object]`, must preserve form input, and must not
be treated as empty states.

## Static Boundary

Manual Editor files remain under `src/frontend`. They must:

- use `L3FrontendClient`
- avoid raw `fetch`
- avoid direct `/api/l3/` construction outside `src/frontend/api/l3Client.ts`
- avoid imports from DB, repositories, services, HTTP routes, server code, LLM,
  dictionary, MCP, or FSRS modules
- avoid frontend inference of ids/slugs from labels or display text

## Phase 5B Frontend Test Plan

- shell navigation includes Manual Editor
- static API boundary includes the new page and view model
- create source success marks active read stale and offers Source/Graph handoff
- create context success marks active read stale and offers Context handoff
- occurrence surface helper handles zero, one, and multiple exact
  case-sensitive matches
- offset/surface mismatch displays `422` and preserves input
- invalid link target displays `404` or `422` and preserves input
- busy state prevents duplicate source/context/occurrence/link creates
- import/proposal/recommendation semantics remain unchanged
