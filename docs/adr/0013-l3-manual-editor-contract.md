# ADR-0013: L3 Manual Editor Contract

- **Status**: Accepted
- **Date**: 2026-07-08
- **Phase**: Phase 5A
- **Builds on**: ADR-0005, ADR-0007, ADR-0008, ADR-0009, ADR-0010, ADR-0011, ADR-0012

## Context

Phase 3A created confirmed owner/manual active L3 writes for sources, contexts,
occurrences, and context links. Phase 3B added proposal review and confirm for
unreviewed candidates. Phase 3C import and Phase 3E recommendation are sealed
proposal producers. Phase 4I sealed the frontend read/review/recommend/graph
baseline and kept every read surface non-editing.

The next product surface is a manual editor. It touches active L3 write paths,
provenance, stale/read invalidation, and UI command safety. Phase 5A therefore
defines the contract first and intentionally does not implement the editor UI,
new backend endpoints, schema changes, migrations, dependencies, graph editing,
or edit/delete behavior.

## Decision

Manual editor writes are allowed to write active L3 directly only when the
authenticated owner performs an explicit, single-record, strongly validated
command. These writes are a continuation of the Phase 3A confirmed
owner/manual foundation, not a relaxation of the proposal rule.

Automated, bulk, inferred, imported, agent, MCP, parser, recommendation, or
external-tool content must still enter the proposal pipeline before it can
become active L3.

| Operation source | Direct active write? | Proposal required? | Reason |
| --- | ---: | ---: | --- |
| User manually creates one source | Yes | No | Explicit owner command. |
| User manually creates one context under a source | Yes | No | Explicit owner command with source ownership. |
| User manually creates one occurrence under a context | Yes | No | Explicit owner command with wordbook and offset/surface validation. |
| User manually creates one context link | Yes | No | Explicit owner command with anchor and target validation. |
| User bulk-pastes contexts or auto-extracts evidence | No | Yes | Needs review before authority. |
| Agent, MCP, external tool, or LLM output | No | Yes | Not direct owner confirmation. |
| Import parser output | No | Yes | Phase 3C contract already sealed. |
| Recommendation `link_gap` accept | No | Yes | Phase 3E bridge contract already sealed. |

## Phase 5B MVP

Phase 5B should be additive-create only:

- create source
- create context under an existing or newly created source
- create occurrence under a context
- create context link from a context or word anchor

Phase 5B should defer edit and delete. Edit/delete require decisions on graph
consistency, dependent links, proposal references, audit trail, soft delete
versus hard delete, and stale read behavior. Those risks should be handled in a
separate Phase 5C contract.

## Active Create Contract

The current active create endpoints already exist and should be reused:

- `POST /api/l3/sources`
- `POST /api/l3/contexts`
- `POST /api/l3/occurrences`
- `POST /api/l3/context-links`

Phase 5B should not add duplicate `/api/l3/manual/*` endpoints unless the
existing active endpoints are removed or materially repurposed. The product name
for the frontend can be "Manual Editor", but the API remains the confirmed
owner/manual active create path.

## Validation Rules

Source creation:

- `sourceType` must be one of the existing L3 source types.
- `title` is required and non-empty.
- `wordbookId` is optional; when supplied, it must belong to the authenticated
  owner.
- `metadata` may be accepted as JSON, but the UI should prefer structured
  fields and reserve raw metadata for advanced use.
- Success creates active `l3_sources` only and must not create proposals,
  imports, recommendations, L1/L2 rows, FSRS progress, or word cache updates.

Context creation:

- `sourceId` is required and must resolve to an owner-scoped source.
- `text` is required and non-empty.
- `contextType` must be one of the existing L3 context types.
- Context owner is inherited from the source owner.
- The source `wordbook_id` controls later occurrence and link word-scope
  validation.
- Success creates active `l3_contexts` only.

Occurrence creation:

- `contextId`, `surface`, and either `wordId` or `slug` are required.
- If the context source has `wordbook_id`, the word must exist in that
  wordbook.
- If the context source has no `wordbook_id`, word lookup remains global while
  the occurrence row remains owner-scoped.
- If offsets are supplied, `startOffset` and `endOffset` must both be supplied,
  valid, in range, and `context.text.slice(startOffset, endOffset) === surface`
  using case-sensitive exact comparison.
- Phase 5B frontend may provide a surface-match helper, but the backend should
  still receive and validate the final exact payload.

Context link creation:

- At least one anchor, `contextId` or `wordId`, is required.
- If `contextId` exists and its source has `wordbook_id`, an anchor `wordId`
  must belong to that same wordbook.
- `targetType=word` requires an active word target; under a wordbook-scoped
  context, the target word must belong to the same wordbook.
- `targetType=context` and `targetType=source` require active owner-scoped
  targets.
- `targetType=l2_item` remains a soft reference and must require
  `targetRef.field` plus one of `contentId`, `hash`, or `sourceRef`.
- `targetType=topic` and `targetType=external` may use soft `targetRef`.
- The frontend must never infer target ids or slugs from labels, surface text,
  graph labels, row order, or display copy.

## Provenance and Audit

Phase 5B should use existing JSON fields rather than adding an audit table:

- source/context metadata may include `{ "provenance": { "source": "manual" } }`
  or a project-standard equivalent
- occurrence evidence should include `{ "method": "manual" }`
- context link provenance should include `{ "source": "manual" }`

Recommended provenance vocabulary:

- `manual`
- `manual_edited` (reserved for future edit behavior)
- `proposal_confirmed`
- `import_confirmed`
- `recommendation_confirmed`

If future edit/delete requires stronger audit guarantees, Phase 5C should add a
dedicated audit design before implementation.

## Frontend Direction

Phase 5B should add one centralized Manual Editor page rather than inline edit
controls across read surfaces. A wizard-style flow is preferred:

1. choose or create source
2. add context
3. add occurrence
4. add context link

Successful commands should offer local handoff actions such as Open Source
Space, Open Context, Open Word Space, and Open Graph. Read surfaces can expose
"Open in Manual Editor" handoffs later, but Phase 5B should avoid turning
Context, Word, Source, or Graph pages into inline editors.

## Cache and Stale Semantics

Manual active create success creates active L3 and should mark active read
surfaces stale in the frontend:

- Graph
- Context Detail
- Word Space
- Source Space

Manual create success should not mark proposal, import, or recommendation state
as authoritative. It may provide a successful command result and local
navigation handoff to the created entity.

## Non-goals

Phase 5A does not implement:

- production code
- frontend manual editor UI
- backend endpoint changes
- schema changes
- DB migrations
- new dependencies
- edit/delete active L3 behavior
- graph editing or persisted layout
- import/recommendation/proposal confirm semantic changes
- L1/L2/FSRS/LLM/dictionary/MCP behavior changes

## Consequences

- Phase 5B has a narrow additive-create implementation path.
- Existing Phase 3A active create endpoints remain the authoritative manual
  active write API.
- Proposal confirm remains the only unreviewed-candidate upgrade path.
- Read surfaces stay read-only until a dedicated editor page is implemented.
- Edit/delete risk is intentionally deferred to a later contract.
