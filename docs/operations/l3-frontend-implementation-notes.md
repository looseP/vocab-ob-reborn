# L3 Frontend Implementation Notes

> Scope: Phase 4A.0 scaffold decision for the L3 minimal frontend closed loop.

## Frontend Host Decision

The current repository is backend-only:

- no `src/client`, `src/frontend`, `src/app`, `app`, `pages`, `components`,
  `web`, `frontend`, or `client` host directory
- no Vite, React, Next, Vue, Svelte, or browser build configuration
- no frontend build script in `package.json`
- the HTTP server exposes API routes only and does not mount static assets

Because there is no frontend host to extend, Phase 4A does not introduce a UI
framework or backend endpoint. The implementation is a Phase 4A.0 frontend
consumption scaffold that future UI work can import or port directly.

## Implemented Scaffold

`src/l3/frontend/contract.ts` provides:

- typed L3 API client functions for imports, proposals, recommendations,
  context detail, word/source space, and graph
- camelCase request payload construction
- normalized `400`, `404`, `409`, `422`, and `500` error semantics
- user-facing copy for import success, recommendation accept bridge,
  conflict refresh, proposal validation, not-found, and unexpected errors
- target word input parsing for raw import forms
- graph parameter validation for `depth` and `limit` before route calls
- command result helpers for import success, proposal validate/confirm/reject,
  recommendation accept/reject, and graph read state
- cache invalidation signals matching
  `docs/operations/l3-frontend-integration-contract.md`

`tests/l3-frontend-contract.test.ts` verifies:

- raw import uses camelCase payload and transitions to `proposalCreated`
- import success invalidates proposals but does not refresh graph
- `validateProposal valid=false` is review feedback, not fatal failure
- proposal confirm is the only helper that marks active L3 creation and graph
  refresh
- `link_gap` recommendation accept exposes proposal bridge semantics without
  active graph refresh
- `409` and `422` normalize to actionable UI errors
- invalid graph `depth` and `limit` are blocked before route request

## Non-Implemented UI Host

Phase 4A.0 intentionally does not add:

- a frontend app shell
- frontend routing
- React/Vue/Svelte/Next/Vite dependencies
- browser E2E tests
- static asset serving
- backend endpoints or migrations

A future Phase 4A implementation can add a real UI host and wire the scaffold
into the actual app structure once the repository location and frontend
framework are decided.

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

Phase 4A.0 must keep the backend contract untouched:

- no backend production route changes
- no schema or migration changes
- no L1/L2/FSRS behavior changes
- no recommendation algorithm changes
- no graph API expansion
