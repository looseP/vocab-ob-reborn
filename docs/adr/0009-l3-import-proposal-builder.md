# ADR-0009: L3 Import Proposal Builder

- **Status**: Accepted
- **Date**: 2026-07-08
- **Phase**: Phase 3C
- **Builds on**: ADR-0007, ADR-0008

## Context

Phase 3A created the confirmed owner/manual active L3 write surface. Phase 3B
added `l3_proposals` and `l3_proposal_items` so unreviewed candidates can be
validated, rejected, or confirmed before they become active L3 evidence.

The missing piece is a deterministic import entry point: users and external
agents need to turn raw text or already-structured contexts into pending
proposals without bypassing the review gate.

## Decision

Phase 3C adds an L3 import proposal builder. It creates:

- `l3_import_jobs`
- `l3_proposals`
- `l3_proposal_items`

It never writes active L3 tables directly:

- `l3_sources`
- `l3_contexts`
- `l3_occurrences`
- `l3_context_links`

Active evidence still enters only through Phase 3B `confirmProposal`, which
reuses the Phase 3A owner, wordbook, offset, surface, and link validation rules.

## Parser Boundary

Raw text import uses a small deterministic parser rather than LLM or broad NLP.
It splits source text into sentence or paragraph contexts, preserves original
context text, and creates occurrences only for explicit target words supplied by
the caller.

This phase intentionally does not implement:

- lemmatization
- synonym expansion
- dictionary lookup
- LLM parsing
- recommendation ranking
- vector search or full-text search

The deterministic parser is easy to test, explain, and audit. It produces
candidate evidence with exact offsets and original surface text while leaving
semantic judgment to review and confirm.

## Import Types

Raw text import accepts source metadata, raw text, optional `wordbookId`, target
words, parser options, and provenance. It generates one source item, one context
item per parsed context, and occurrence items only for matched explicit target
words.

Structured import accepts source metadata and caller-supplied contexts with
optional occurrences and links. It performs basic structure conversion and enum
checks, then leaves full business validation to proposal validation/confirm.

## Import Job Lifecycle

Import jobs are created as `processing` while proposal items are being written.
Successful proposal generation then marks the import job `completed` with
deterministic `inputHash`, `inputSummary`, and parser stats. If proposal
creation fails after the job exists, the job is marked `failed` with the same
stats and an error message. Input validation failures that happen before job
creation return validation errors without creating a job.

## Future Extensions

Later phases can attach async workers, MCP actions, external agents, LLM
parsers, dictionary enrichment, or recommendation pipelines as proposal
producers. They must still target the same proposal boundary unless a future ADR
explicitly changes the trust model.

## Consequences

- Imports now have a durable, owner-scoped audit record.
- Raw and structured imports produce reviewable proposal items instead of
  directly polluting active evidence.
- The L3 write path is a closed safety loop: import job -> proposal items ->
  validate/reject/confirm -> active L3 evidence.
- L1/L2 FSRS state, content hashes, stale flags, and `words` JSONB caches remain
  untouched by import proposal creation.

## Phase 3C.1 Contract Sealing

Phase 3C.1 tightens the import contract without adding new feature surface:

- raw `targetWords` are resolved, then deduplicated by resolved `wordId`; if a
  future resolver cannot provide an id, slug is the fallback key
- raw import `inputHash` uses the deduplicated target-word set
- parser truncation reports `Context limit reached; remaining contexts skipped.`
  and `skippedContextCount` includes both too-short contexts and max-context
  truncation
- import jobs are created as `processing`, then updated to `completed` only
  after proposal creation succeeds, or `failed` if proposal creation fails
- structured import links do not support intra-proposal `targetRef.contextRef`
  or `targetRef.sourceRef` for `targetType=context/source`; callers must confirm
  first and then create links to active `targetId` values
