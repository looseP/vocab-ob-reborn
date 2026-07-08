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

## Remaining Frontend Surface

Context, word, and source space browsing remain deferred read-only surfaces.
