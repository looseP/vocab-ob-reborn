# L3 Frontend

Phase 4H wires the minimal frontend host into the real L3 raw import,
proposal review, recommendation queue, graph read, context detail, word space,
source space read contracts, read-only graph visualization, and local
cross-navigation handoffs without expanding backend or mutation scope.

## Decision

- Host: `src/frontend`
- Build: Vite + React + TypeScript
- Scope: shell, navigation, raw import, proposal queue/detail, validation,
  confirm/reject, recommendation generate/list/detail, recommendation
  accept/reject, graph read stats/nodes/edges, context detail, word space, and
  source space browsing with local cross-navigation handoffs
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

## Phase 4F Runtime UX Hardening

- `npm run frontend:build` is the automated runtime smoke gate for the Vite
  shell. A real Vite HTTP smoke can load the root page and verify that Home,
  Import, Proposals, Recommendations, Graph, Context, Word Space, and Source
  Space are registered in shell navigation.
- The repository still has no DOM/browser test dependency, so manual browser
  smoke remains a checklist instead of adding Playwright, jsdom, or a component
  test framework.
- Error UX now has a shared contract for `400`, `404`, `409`, `422`, `500`,
  network, and aborted failures: they preserve user input, are not empty
  states, and avoid `[object Object]` display.
- Runtime smoke coverage locks the surface matrix: only Proposal confirm marks
  active read surfaces stale, while Graph, Context, Word, and Source reads
  clear stale state only after successful reads.
- Static API-boundary tests cover pages, components, state helpers, and
  view-model helpers. The only route adapter remains `src/frontend/api/l3Client.ts`
  backed by `src/l3/frontend/contract.ts`.

## Phase 4G Graph Visualization MVP

- Graph page now includes a read-only SVG canvas rendered from the current
  `client.getGraph` response.
- Canvas nodes and edges preserve response cardinality: no frontend-created
  active nodes, edges, occurrences, or context links are added.
- The deterministic layout is implemented in pure view-model helpers, so equal
  graph response data produces stable positions and edge ordering.
- Node and edge selection shows detail from the latest graph response only; if a
  refreshed graph no longer contains the selection, the selection is cleared.
- Unknown node/edge types, long labels, empty graphs, and missing edge endpoints
  render with safe fallbacks.
- The nodes and edges tables remain as the accessible fallback and source of
  inspectable response data.

## Phase 4H Cross-Navigation Polish

- `src/frontend/viewModels/l3NavigationViewModel.ts` defines typed local
  navigation intents for Graph, Context, Word Space, Source Space, Proposal
  Review, and Recommendation surfaces.
- `src/frontend/App.tsx` remains the single local navigation owner. It switches
  the current shell section and pre-fills target page inputs; it does not add
  React Router, URL deep-link sync, global state, or backend writes.
- Graph selected node/edge actions use only explicit `ref` or `metadata`
  fields from the latest graph response. The frontend does not infer slug/id
  from labels or surface text.
- Context Detail, Word Space, and Source Space rows expose supported read
  handoffs to Context, Word, Source, and Graph surfaces while unsupported
  `l2_item`, topic, external, unknown, or missing-target cases stay disabled
  with explanatory copy.
- Recommendation `link_gap` accept still opens Proposal Review as a proposal
  bridge only. Proposal confirm still marks active read surfaces stale and
  offers read-surface follow-up actions after active entities are created.

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

## Continue After Phase 4H

- Keep frontend read UX QA/manual smoke as the next likely phase.
- L3 manual editor, graph editing, node drag persistence, MCP agent UI,
  backend graph expansion, and router/deep-link URL sync remain intentionally
  deferred.
