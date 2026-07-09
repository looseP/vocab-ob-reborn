# L3 Frontend

Phase 4I seals the minimal frontend host around the real L3 raw import,
proposal review, recommendation queue, graph read, context detail, word space,
source space read contracts, read-only graph visualization, and local
cross-navigation handoffs with release-smoke QA, without expanding backend or
mutation scope.

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
- The repository still avoids a broad DOM/browser test stack, but the Manual
  Editor delete regression uses a narrow jsdom-based component test; manual
  browser smoke remains the checklist for the rest of the shell.
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

## Phase 4I Release Smoke Seal

- `docs/operations/l3-frontend-smoke-checklist.md` is the release-smoke
  checklist for the existing L3 frontend surfaces.
- Shell navigation is now a tested contract through `L3_SHELL_SECTIONS`: L3
  Home, Import, Proposals, Recommendations, Graph, Context, Word Space, and
  Source Space must remain registered.
- Static API-boundary tests discover `pages`, `components`, `viewModels`, and
  `state` files by directory, so new frontend files cannot silently bypass the
  no-server-import and no-raw-networking rules.
- The smoke seal keeps Phase 4H semantics intact: Import and Recommendation
  acceptance hand off to Proposal Review, Proposal confirm is the only active
  L3 upgrade signal, Graph selection is local, and read pages remain read-only.
- No backend endpoint, service, repository, schema, migration, dependency,
  router, global state library, graph editor, manual L3 editor, MCP, LLM,
  dictionary, recommendation algorithm, import parser, or L1/L2/FSRS behavior
  changed for Phase 4I.

## Phase 5B Manual Editor MVP

- `Manual Editor` is now a shell section backed by
  `src/frontend/pages/L3ManualEditorPage.tsx`.
- The page supports additive active creates only: source, context, occurrence,
  and context link.
- The page calls the shared `L3FrontendClient` active-create methods and keeps
  raw HTTP paths out of page code.
- Manual create success marks active read surfaces stale and offers local
  handoff actions to Source Space, Context Detail, Word Space when an explicit
  slug is available, and Graph.
- It does not implement edit/delete, bulk paste direct-to-active, auto
  extraction, import/recommendation expansion, proposal confirm changes, graph
  editing, MCP, LLM, dictionary, or L1/L2/FSRS behavior.

## Phase 5C Edit/Delete Contract

- Phase 5C is design-only and adds no frontend implementation.
- The recommended next slice is a Manual Editor delete-by-id panel for
  occurrence and context link rows only.
- Source/context edit/delete, context text edit, graph inline editing, bulk
  edit/delete, and automated edit/delete remain deferred.

## Continue After Phase 4I

- Phase 5B adds the centralized additive-create Manual Editor page after the
  Phase 5A contract.
- Graph editing, node drag persistence, MCP agent UI, backend graph expansion,
  edit/delete active L3, and router/deep-link URL sync remain intentionally
  deferred.
