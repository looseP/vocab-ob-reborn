# ADR-0008: L3 Proposal Review Pipeline

- **Status**: Accepted
- **Date**: 2026-07-08
- **Phase**: Phase 3B
- **Builds on**: ADR-0005, ADR-0007

## Context

Phase 3A established confirmed owner/manual writes for active L3 evidence:
`l3_sources`, `l3_contexts`, `l3_occurrences`, and `l3_context_links`.
That API is intentionally trusted: the authenticated owner is directly creating
reviewed evidence.

Future agent, import worker, external tool, MCP, or parser output has a
different trust level. Those writes are unreviewed candidates and must not write
active L3 tables directly.

## Decision

Phase 3B adds an L3 proposal/review/confirm boundary:

- `l3_proposals` stores the proposal envelope.
- `l3_proposal_items` stores ordered source/context/occurrence/link candidates.
- Proposal create, list, get, validate, and reject operate only on proposal
  tables.
- Proposal confirm is the only upgrade path from unreviewed proposal rows into
  active L3 evidence.
- Confirm reuses the Phase 3A service validations for owner scope, wordbook
  scope, offset/surface exact match, link target validation, and active row
  creation.

This preserves the Phase 3A distinction:

- owner/manual API writes are confirmed foundation writes
- agent/import/external writes are unreviewed and must enter proposals first

## Payload Contract

Proposal item payloads use the existing service-facing camelCase shape so agents
can build candidates without knowing DB column names. Items are ordered by
`ordinal` and may reference earlier items with local `clientRef` values:

- source item: `clientRef`
- context item: `sourceId` or `sourceRef`
- occurrence item: `contextId` or `contextRef`
- context_link item: `contextId`/`contextRef` plus optional `wordId`

Confirm resolves these references in order and records each confirmed item's
`active_entity_type` and `active_entity_id`.

## Non-goals

Phase 3B does not implement:

- MCP server or MCP resources/actions
- LLM generation or parsing
- dictionary-provider integration
- recommendation ranking
- frontend review UI
- bulk file import or async worker orchestration
- vector search or full-text search

Those systems may produce proposal payloads in later phases, but they do not
exist in this phase.

## Consequences

- Unreviewed L3 candidates have a durable, owner-scoped holding area.
- Rejecting a proposal leaves active L3 evidence untouched.
- Confirm is atomic: active L3 rows and proposal item status updates happen in
  one transaction.
- Proposal lifecycle writes do not modify `words`, `word_l2_content`,
  `user_word_progress`, `user_word_l2_progress`, FSRS state, hashes, or stale
  flags.
- Phase 3C/3D can attach import workers, MCP, recommendation, or LLM pipelines
  by writing proposals rather than active L3 tables directly.
- Phase 3C implements the first such producer: the deterministic L3 import
  proposal builder. It writes import jobs and proposal items only, then relies
  on this Phase 3B confirm path for any active evidence creation.
