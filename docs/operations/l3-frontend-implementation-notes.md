# L3 Frontend Implementation Notes

> Scope: Phase 4A.0 scaffold plus Phase 4A.1 contract hardening for the L3
> minimal frontend closed loop.

## Frontend Host Decision

Phase 4A confirmed the repository was backend-only:

- no `src/client`, `src/frontend`, `src/app`, `app`, `pages`, `components`,
  `web`, `frontend`, or `client` host directory
- no Vite, React, Next, Vue, Svelte, or browser build configuration
- no frontend build script in `package.json`
- the HTTP server exposes API routes only and does not mount static assets

Phase 4B decides to create a minimal same-repository frontend shell:

- host directory: `src/frontend`
- runtime: React + TypeScript
- build tool: Vite
- build output: `dist/frontend`
- scripts: `npm run frontend:dev`, `npm run frontend:build`

The backend server remains API-only in Phase 4B; no static serving contract is
introduced.

## Implemented Scaffold

`src/l3/frontend/contract.ts` provides:

- typed L3 API client functions for imports, proposals, recommendations,
  context detail, word/source space, and graph
- camelCase request payload construction
- normalized `400`, `404`, `409`, `422`, `500`, network, and abort error
  semantics
- user-facing copy for import success, recommendation accept bridge,
  conflict refresh, proposal validation, not-found, and unexpected errors
- target word input parsing for raw import forms
- graph, space, raw import, structured import, proposal-create, and
  recommendation-generation guards before route calls
- command result helpers for import success, proposal validate/confirm/reject,
  recommendation generate/accept/reject, proposal status actions, recommendation
  accept action classification, graph stale/read state
- cache invalidation signals with `keys`, active-read/proposal/recommendation
  flags, `reason`, and optional `nextSuggestedAction`, matching
  `docs/operations/l3-frontend-integration-contract.md`
- a static contract-purity guard in tests to prevent DB/repository/service/HTTP
  layer imports

`tests/l3-frontend-contract.test.ts` verifies:

- every Phase 3H client endpoint maps to the frozen HTTP method/path/query/body
- raw and structured imports use camelCase payloads and transition to
  `proposalCreated`
- import success invalidates proposals but does not refresh graph/read spaces
- route, schema, proposal, non-JSON, network, and abort errors normalize to UI
  consumable shapes while preserving field/item details
- `validateProposal valid=false` is review feedback, not fatal failure
- proposal confirm is the only helper that marks active L3 creation and graph
  refresh
- recommendation generate/accept/reject helpers keep recommendation/proposal
  invalidation distinct from active graph invalidation
- graph reads are read-only cache events
- invalid graph, space, raw import, structured import, and recommendation inputs
  are blocked before route request

## Minimal UI Host

Phase 4B adds:

- `src/frontend/main.tsx`
- `src/frontend/App.tsx`
- `src/frontend/api/l3Client.ts`
- `src/frontend/state/l3CacheSignals.ts`
- `src/frontend/components/L3Shell.tsx`
- placeholder pages for L3 Home, Import, Proposals, Recommendations, and Graph
- `index.html`, `vite.config.ts`, and `tsconfig.frontend.json`

The shell is intentionally not a complete L3 UI. It anchors navigation,
placeholder copy, and a browser adapter over `src/l3/frontend/contract.ts`.

## Phase 4C Import and Proposal Loop

Phase 4C wires the first real UI loop without changing backend runtime
behavior:

- `src/frontend/pages/L3ImportPage.tsx` submits raw text imports through
  `client.createRawTextImport`.
- Import success renders import job/proposal identifiers, parse stats, warnings,
  and a proposal item preview. It explicitly states that active L3 was not
  written.
- `src/frontend/pages/L3ProposalPage.tsx` provides a local-state proposal
  queue/detail view using `listProposals`, `getProposal`, `validateProposal`,
  `confirmProposal`, and `rejectProposal`.
- `validateProposal` responses with `valid=false` render item-level review
  feedback as successful validation output.
- `confirmProposal` is the only UI action that marks graph/read surfaces stale
  through the shared cache-signal helper.
- `rejectProposal` updates proposal review state only and does not mark graph
  stale.
- `src/frontend/components/L3ErrorMessage.tsx` renders normalized
  `400/404/409/422/500/network/abort` feedback from the shared contract shape.

Phase 4C remains intentionally small:

- no structured import editor
- no recommendation queue
- no graph visualization or graph fetch
- no backend endpoint, service, repository, migration, L1/L2/FSRS, dictionary,
  LLM, MCP, or import parser changes

## Phase 4C.1 Hardening

Phase 4C.1 tightens the first real UI loop without expanding scope:

- raw import form performs explicit local required-field validation before
  calling the shared client
- import preview shows import job status plus proposal id/status/title and
  compact item summaries
- proposal detail renders items sorted by ordinal and keeps unknown payloads on
  safe compact previews
- proposal refresh, selection, validate, confirm, and reject actions are
  disabled while a command is in flight
- confirm clears stale validation feedback before showing active entities;
  reject clears stale active-success output and does not mark graph stale
- normalized error rendering includes safe details output without leaking
  `[object Object]`
- static tests continue to prove frontend pages do not call raw `fetch` or
  hard-code `/api/l3/` routes

## Phase 4D.1 Recommendation Queue UI

Phase 4D.1 wires the recommendation review surface without changing backend
runtime behavior:

- `src/frontend/pages/L3RecommendationPage.tsx` lists recommendation items by
  status/type filters through `client.listRecommendations`.
- Recommendation generation uses `client.generateRecommendations` with local
  numeric validation for `limit` and `horizonDays`.
- Recommendation detail loads and refreshes through `client.getRecommendation`
  and renders score, confidence, reason codes, evidence, payload, and accepted
  proposal id.
- Accept/reject commands use `client.acceptRecommendation` and
  `client.rejectRecommendation` only.
- `link_gap` acceptance renders the proposal bridge and an "Open proposal
  review" action; it never labels acceptance as an active link.
- Future-action accept results and rejected recommendations do not mark
  graph/read surfaces stale.
- Recommendation page components continue to avoid raw `fetch` calls and direct
  `/api/l3/` endpoint construction.

Phase 4D.1 remains intentionally small:

- no graph visualization or graph fetch UI
- no context, word, or source space pages
- no backend endpoint, service, repository, migration, L1/L2/FSRS, dictionary,
  LLM, MCP, or recommendation algorithm changes

## Phase 4B Host Decision Result

Decided:

- host location is `src/frontend`
- framework/build is Vite + React + TypeScript
- API wiring goes through `src/frontend/api/l3Client.ts`
- cache semantics continue to use framework-agnostic `L3CacheSignal`
- Phase 4B uses TypeScript/build smoke plus unit smoke tests, not browser E2E

Deferred:

- auth/session integration
- full data fetching and mutation flows
- graph visualization/read surface
- component-level DOM test framework beyond current Vitest node smoke

## Future UI Wiring Checklist

When a frontend host exists, wire the scaffold into these surfaces:

1. Import Composer / Import Preview
2. Proposal Review Queue
3. Proposal Detail / Review Panel
4. Recommendation Queue
5. Graph View or Graph Modal
6. Context Detail / Word Space / Source Space as time allows

Required closed-loop behavior:

- import success opens a pending proposal preview and does not refresh graph
- proposal confirm refreshes graph/read surfaces
- recommendation accept with a proposal bridge opens proposal review and does
  not refresh graph
- accepted proposal confirm refreshes graph/read surfaces
- `400`, `404`, `409`, and `422` map to clear UI feedback

## Validation Scope

Phase 4A.0/4A.1 must keep the backend contract untouched:

- no backend production route changes
- no schema or migration changes
- no L1/L2/FSRS behavior changes
- no recommendation algorithm changes
- no graph API expansion

## Phase 4D.2 Graph Read Surface UI

Phase 4D.2 implements a bounded read-only graph surface without introducing a
graph visualization library:

- `src/frontend/pages/L3GraphPage.tsx` calls `client.getGraph` through the
  existing shared frontend client.
- `src/frontend/viewModels/l3GraphViewModel.ts` performs local query
  normalization and numeric validation for `depth` and `limit`.
- The Graph page renders stats, nodes, edges, cursor metadata, empty states,
  and normalized errors through `L3ErrorMessage`.
- The Graph page consumes the proposal-confirm stale signal from
  `src/frontend/state/l3CacheSignals.ts` and clears it only after a successful
  graph read.
- Graph read success uses the existing read-only cache helper and does not
  invalidate proposal, recommendation, import, or active graph/read caches.

Phase 4D.2 remains intentionally small:

- no graph visualization, drag/edit/layout algorithm, or graph library
- no context, word, or source space pages
- no backend endpoint, service, repository, schema, migration, L1/L2/FSRS,
  dictionary, LLM, MCP, or recommendation algorithm changes

## Phase 4D.3 Closed-Loop Smoke Hardening

Phase 4D.3 reviews and hardens the existing Import, Proposal, Recommendation,
and Graph surfaces without adding new runtime features:

- Import success handoff to Proposal Review is locked as pending proposal
  navigation.
- Recommendation `link_gap` accept handoff to Proposal Review is locked as a
  proposal bridge, not an active link.
- Proposal confirm remains the only UI action that sets graph/read stale state.
- Graph read success clears the stale signal and keeps graph/read invalidation
  read-only.
- Graph edge rows are proven to come from `getGraph` read responses after a
  confirmed proposal, not from frontend-local accept/confirm payloads.
- Shared 409/422 normalized error shapes and API boundary checks now cover the
  current closed loop.

Phase 4D.3 remains intentionally narrow:

- no graph visualization, graph editor, context/word/source full pages, backend
  endpoint, repository/service/schema, migration, global state library, UI
  framework, recommendation algorithm, L1/L2/FSRS, LLM, MCP, dictionary, or
  import parser changes

## Remaining Frontend Surface

Context, word, and source space browsing remain deferred read-only surfaces.

## Phase 4E Space Read UI

Phase 4E implements the remaining active L3 read surfaces without adding
backend endpoints, migrations, graph visualization libraries, UI frameworks, or
state/router libraries:

- `src/frontend/pages/L3ContextPage.tsx` calls `client.getContextDetail` after
  local `contextId` trim/required validation. It displays context id/type,
  source metadata, context text, occurrences, links, timestamps, metadata, and
  clear empty states when occurrences or links are empty.
- `src/frontend/pages/L3WordSpacePage.tsx` calls `client.getWordSpace` after
  local `slug` required validation plus optional `wordbookId`, `limit`, and
  `cursor` trimming. Empty slug never reaches the client, and `404` remains a
  normalized not-found error rather than a fabricated empty state.
- `src/frontend/pages/L3SourceSpacePage.tsx` calls `client.getSourceSpace`
  after local `sourceId` required validation plus optional `limit` and
  `cursor` trimming. Empty source id never reaches the client.
- `src/frontend/viewModels/l3SpaceViewModel.ts` contains pure presentation
  helpers for lookup payloads, previews, occurrence/link summaries, empty
  states, stats rows, and read-stale banner text. It does not call the client
  and does not infer graph edges, context links, or active L3 data.
- `src/frontend/state/l3CacheSignals.ts` now names the proposal-confirm signal
  as an active-read stale signal shared by Graph, Context, Word, and Source
  read pages.

Phase 4E read semantics:

- The three new pages are read-only. They do not create proposals, accept
  recommendations, run imports, write active L3 rows, write graph edges, or
  expose source/context/occurrence/link editing controls.
- Proposal confirm remains the only UI action that marks active read surfaces
  stale after active L3 creation.
- Successful Context, Word, Source, or Graph refresh clears the read stale
  signal only after the relevant shared-client read succeeds.
- Read success does not clear proposal, recommendation, or import invalidation
  flags and does not refresh graph edges unless the user explicitly reads the
  Graph endpoint.

Phase 4E still defers:

- graph visualization libraries, graph editors, and layout engines
- L3 editor, MCP agent UI, and context/link manual creation UI
- backend route/service/repository/schema changes and DB migrations
- recommendation algorithm, import parser, L1/L2/FSRS, LLM, dictionary, and MCP
  behavior changes

## Phase 4F Runtime Smoke and UX Contract Hardening

Phase 4F seals the runtime UX contract around the existing L3 frontend surfaces.
It does not add new L3 runtime features.

Runtime smoke scope:

- `npm run frontend:build` is the automated runtime smoke gate for the Vite
  bundle.
- The repository still has no DOM/browser test framework dependency, so Phase
  4F keeps browser smoke as a documented manual checklist instead of adding
  Playwright, jsdom, or a component test library.
- Manual smoke should start the existing Vite host, open the shell, and verify
  that Import, Proposals, Recommendations, Graph, Context, Word Space, and
  Source Space tabs load without console runtime errors.

UX contract hardening:

- Import success remains a pending-proposal handoff only.
- Recommendation `link_gap` accept remains a proposal bridge only.
- Proposal confirm remains the only UI command that marks Graph, Context, Word,
  and Source read surfaces stale.
- Graph, Context, Word, and Source refreshes clear active-read stale only after
  a successful read.
- `400`, `404`, `409`, `422`, `500`, network, and aborted errors are treated as
  errors, not empty states, and preserve user input for retry.
- Static boundary tests now cover pages, shared components, state helpers, and
  view-model helpers for server-only imports, raw network calls, and hard-coded
  L3 routes.

Phase 4F still defers graph visualization, context/word/source editors, MCP
agent UI, manual L3 active editors, backend changes, migrations, new UI
frameworks, global state libraries, and recommendation/import semantic changes.

## Phase 4G Graph Visualization MVP

Phase 4G adds the first visual graph surface while keeping the existing L3 read
contract sealed:

- `src/frontend/components/L3GraphCanvas.tsx` renders a read-only SVG graph
  from the current `L3GraphReadModel`.
- `src/frontend/viewModels/l3GraphViewModel.ts` owns deterministic canvas
  layout, display labels, legend rows, safe unknown-type fallbacks, selected
  item summaries, and empty-canvas state.
- `src/frontend/pages/L3GraphPage.tsx` keeps the existing query controls,
  stats, node list, edge list, stale banner, and normalized error behavior,
  then adds the visual canvas between stats/empty messaging and list fallback.
- Selection is UI-only and local: clicking a node or edge highlights it and
  displays detail from the latest graph response. A successful refresh clears a
  stale selection if the selected id no longer exists.

Phase 4G graph semantics:

- Canvas data comes only from `client.getGraph(...)`.
- The frontend does not create, infer, supplement, persist, or edit active
  graph nodes, graph edges, occurrences, context links, or L3 rows.
- Graph refresh remains a read-only action and still clears active-read stale
  only after successful graph read.
- Proposal confirm remains the only active L3 upgrade path.
- Recommendation `link_gap` accept remains only a proposal bridge.
- Import success remains only pending-proposal creation.

Phase 4G still defers graph editing, node drag persistence, manual link
creation, advanced force-directed layout, graph API expansion, backend changes,
migrations, new dependencies, MCP agent UI, manual L3 editor, recommendation
algorithm changes, import parser changes, and L1/L2/FSRS/LLM/dictionary
behavior changes.
