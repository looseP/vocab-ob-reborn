# L3 Frontend

Phase 4D.2 wires the minimal frontend host into the real L3 raw import,
proposal review, recommendation queue, and graph read contracts.

## Decision

- Host: `src/frontend`
- Build: Vite + React + TypeScript
- Scope: shell, navigation, raw import, proposal queue/detail, validation,
  confirm/reject, recommendation generate/list/detail, recommendation
  accept/reject, and graph read stats/nodes/edges
- Contract: reuse `src/l3/frontend/contract.ts`

## Non-goals

- No graph visualization library or graph editing workflow
- No context, word, or source space detail pages
- No backend route/service/repository/db changes
- No UI component framework
- No graph visualization library
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

## Continue After Phase 4D

- Context, word, and source space browsing can be added later as read-only
  surfaces.
- Keep graph visualization/editing out of scope until a separate product phase.
