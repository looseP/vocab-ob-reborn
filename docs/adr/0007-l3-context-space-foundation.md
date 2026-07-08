# ADR-0007: L3 Context Space Foundation

- **Status**: Accepted
- **Date**: 2026-07-08
- **Phase**: Phase 3A
- **Builds on**: ADR-0005, ADR-0006

## Context

Phase 3A introduces the first runnable backend foundation for L3: the authentic
context, evidence, and source layer. L3 connects vocabulary words to real
language usage, but it is not part of L1/L2 FSRS scheduling and does not own L2
composer content.

Phase 2 intentionally kept L3 out of `user_word_l2_progress`; ADR-0005 made the
boundary explicit. ADR-0006 froze the L2 Composer contract and deferred any L3
corpus integration to Phase 3.

## Decision

L3 is implemented in the same PostgreSQL database as the rest of V2, but only
through an independent `l3_` table family:

- `l3_sources`
- `l3_contexts`
- `l3_occurrences`
- `l3_context_links`
- `l3_import_jobs`

Using the same database for the MVP keeps transactions, permissions, local
development, deployment, and backups simple. Isolation is provided by the
`l3_` schema boundary, a dedicated repository/service/API surface, and a hard
rule that L3 writes do not modify L1/L2 state.

L3 relates to L1/L2 by linking to `words.id` through occurrences and context
links. It connects evidence to vocabulary, but does not write:

- `words` JSONB cache columns
- `word_l2_content`
- `user_word_progress`
- `user_word_l2_progress`
- L1/L2 content hashes or stale/recheck flags

Phase 3A owner/manual API writes are **confirmed foundation writes**. They are
accepted only through the authenticated owner API and create already-confirmed
source/context/occurrence/link rows. This does not relax the future
agent-generated proposal rule: unreviewed agent output still needs a
proposal/review/confirm flow before it can become authoritative L3 evidence.

Phase 3A intentionally does not create `l3_proposals`. The current API is the
minimum durable storage contract for trusted owner/manual writes. Phase 3B/3C
should add proposal tables when an agent, parser, LLM, or external import worker
can generate unreviewed L3 candidates.

Phase 3B adds that proposal/review/confirm boundary in ADR-0008. From that
phase forward, agent/import/external candidates must enter `l3_proposals` and
`l3_proposal_items`; confirmed owner/manual writes remain the trusted Phase 3A
surface.

Phase 3A.1 hardens owner isolation at both service and database layers:

- `l3_sources(id, user_id)` and `l3_contexts(id, user_id)` are unique owner keys.
- `l3_contexts(source_id, user_id)` references `l3_sources(id, user_id)`.
- `l3_occurrences(context_id, user_id)` references `l3_contexts(id, user_id)`.
- `l3_context_links(context_id, user_id)` references `l3_contexts(id, user_id)`.

This means a child row cannot point at another user's parent row even if a caller
bypasses service-level checks.

## Future Database Split Conditions

L3 can be split to its own database if one or more of these pressures appear:

- strict multi-tenant data isolation
- very large corpora that need separate storage lifecycle controls
- vector search or full-text indexing that requires independent scaling
- high-concurrency external agent access that should not share the core review
  database pool

Until those pressures are real, same-Postgres plus independent table family is
the simpler and more reliable foundation.

## Non-goals

Phase 3A does not implement:

- MCP server
- recommendation algorithms
- frontend UI
- complex import/parser/NLP pipeline
- LLM automatic parsing or budget consumption
- dictionary-provider integration

## Consequences

- L3 gets a concrete backend storage/API contract without contaminating L1/L2.
- External agents receive stable, agent-readable response shapes.
- Future L3 corpus providers can read this table family without changing the
  frozen L2 Composer contract.
- Phase 3B can add richer import, review, ranking, search, or corpus workflows
  on top of this foundation.
- Future agent-generated writes must use a proposal/review/confirm design before
  they become confirmed L3 rows.
