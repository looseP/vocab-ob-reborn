# L3 Frontend Implementation Notes

> Scope: Phase 4A.0 scaffold plus Phase 4A.1 contract hardening for the L3
> minimal frontend closed loop.

## Frontend Host Decision

The current repository is backend-only:

- no `src/client`, `src/frontend`, `src/app`, `app`, `pages`, `components`,
  `web`, `frontend`, or `client` host directory
- no Vite, React, Next, Vue, Svelte, or browser build configuration
- no frontend build script in `package.json`
- the HTTP server exposes API routes only and does not mount static assets

Because there is no frontend host to extend, Phase 4A does not introduce a UI
framework or backend endpoint. The implementation is a frontend consumption
scaffold that future UI work can import or port directly.

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

## Non-Implemented UI Host

Phase 4A.0/4A.1 intentionally does not add:

- a frontend app shell
- frontend routing
- React/Vue/Svelte/Next/Vite dependencies
- browser E2E tests
- static asset serving
- backend endpoints or migrations

A future Phase 4B implementation can add a real UI host and wire the scaffold
into the actual app structure once the repository location and frontend
framework are decided.

## Phase 4B Host Decision Checklist

Before adding a real frontend host, decide:

- host location (`web`, `client`, `app`, or another explicit directory)
- framework and build tool
- API base URL and auth/session wiring
- cache library or local query store that can consume `L3CacheSignal`
- routing for proposal/recommendation detail and graph/read surfaces
- test strategy for browser flows without changing backend contract semantics

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
