# L3 Frontend

Phase 4E wires the minimal frontend host into the real L3 raw import,
proposal review, recommendation queue, graph read, context detail, word space,
and source space read contracts.

## Decision

- Host: `src/frontend`
- Build: Vite + React + TypeScript
- Scope: shell, navigation, raw import, proposal queue/detail, validation,
  confirm/reject, recommendation generate/list/detail, recommendation
  accept/reject, graph read stats/nodes/edges, context detail, word space, and
  source space browsing
- Contract: reuse `src/l3/frontend/contract.ts`

## Non-goals

- No graph visualization library or graph editing workflow
- No context, word, source, occurrence, or link editing workflow
- No backend route/service/repository/db changes
- No UI component framework
- No graph visualization library
- No React Router, Redux, Zustand, or TanStack Query
- No auth implementation

## Supported Phase 4C Surfaces

- Raw import form calls `client.createRawTextImport`.
- Import success shows parse stats, warnings, item preview, and the generated
  pending proposal id.
- Proposal queue lists proposals by status through `client.listProposals`.
- Proposal detail loads items through `client.getProposal` and supports
  validate, confirm, and reject.
- `validateProposal valid=false` is displayed as review feedback, not a fatal
  request failure.
- Confirm success marks graph/read surfaces stale; reject success does not.

## Supported Phase 4D.1 Surfaces

- Recommendation queue calls `client.generateRecommendations`,
  `client.listRecommendations`, `client.getRecommendation`,
  `client.acceptRecommendation`, and `client.rejectRecommendation`.
- Generate controls perform local numeric validation before calling the shared
  client and display run stats without implying active L3 writes.
- List filters support status, recommendation type, limit, cursor refresh, and
  next-page loading.
- Detail view shows status, score, confidence, reasons, evidence, payload, and
  accepted proposal id.
- `link_gap` accept shows a proposal bridge plus "Open proposal review"; it
  does not label acceptance as an active link.
- Reject success updates recommendation review state only and does not mark
  graph/read surfaces stale.

## Supported Phase 4D.2 Surfaces

- Graph page calls `client.getGraph` through the shared frontend client.
- Query controls support optional `wordbookId`, `slug`, `sourceId`, `cursor`,
  plus validated `depth` and `limit`.
- Graph success displays stats, nodes, edges, cursor metadata, and explicit
  empty states.
- Proposal confirm stale state is shown on the Graph page and cleared after a
  successful graph load.
- Graph reads are displayed as read-only operations with no mutation or cache
  invalidation side effects.

## Phase 4D.3 Closed-Loop Hardening

- Import success handoff to Proposal Review is covered as a pending-proposal
  transition, not an active L3 write.
- Recommendation `link_gap` accept handoff to Proposal Review is covered as a
  proposal bridge, not an active link write.
- Proposal confirm remains the only UI path that marks graph/read state stale.
- Graph refresh consumes the stale signal only after a successful read.
- Graph edge rows are displayed from `client.getGraph` response data, not from
  local accept/confirm payloads.
- Import, Proposal, Recommendation, Graph, and shared UI components remain free
  of raw `fetch`, direct `/api/l3/`, and server-only imports.

## Supported Phase 4E Surfaces

- Context Detail calls `client.getContextDetail` with a locally trimmed
  `contextId` and displays source metadata, context text, occurrences, links,
  timestamps, empty related collections, and normalized errors.
- Word Space calls `client.getWordSpace` with a trimmed `slug` and optional
  trimmed `wordbookId`, `limit`, and `cursor`. Empty slug is rejected locally;
  `404` remains normalized not-found feedback instead of an empty state.
- Source Space calls `client.getSourceSpace` with a trimmed `sourceId` plus
  optional `limit` and `cursor`. Empty source id is rejected locally.
- Context, Word, and Source pages are read-only: they do not create proposals,
  recommendations, imports, active L3 rows, graph edges, context links, or
  occurrences.
- Proposal confirm marks all active read surfaces stale. Context, Word, Source,
  and Graph refreshes clear the read stale signal only after their read call
  succeeds, and they do not clear proposal/recommendation/import invalidation.
- All Phase 4E pages use `L3FrontendClient`, `L3ErrorMessage`, and pure
  frontend view-model helpers; page code still has no raw `fetch`, direct
  `/api/l3/`, or server-only imports.

## Phase 4C.1 Hardening

- Required import fields are checked locally before the shared client is called.
- Import preview shows import job status, proposal id/status, parse stats, and
  compact proposal item summaries.
- Proposal detail sorts items by ordinal, disables actions while busy, and keeps
  confirmed/rejected proposals non-actionable.
- Error feedback renders normalized retry hints, field errors, item errors, and
  safe details text.
- Page components still do not contain raw `fetch` calls or direct `/api/l3/`
  paths.

## Continue After Phase 4E

- Keep graph visualization/editing out of scope until a separate product phase.
- L3 editor, MCP agent UI, context/link manual creation UI, and full graph
  visualization remain intentionally deferred.
