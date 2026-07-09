# L3 Frontend Smoke Checklist

> Scope: Phase 4I release smoke and read UX QA for the existing L3 frontend.

Phase 4I is a release-smoke sealing pass. It does not add L3 runtime features,
backend endpoints, migrations, dependencies, routing, global state, graph
editing, manual L3 editing, recommendation semantics, import parser behavior,
or L1/L2/FSRS behavior.

## Automated Gates

Run these before release:

```bash
npm run frontend:build
npm run typecheck
npm run arch:check
npm run test
npm run db:generate
git diff --check
git diff --cached --check
```

## Browser Smoke

1. Start a local Vite host with `npm run frontend:dev -- --port <free-port>`.
2. Open the local URL in a browser.
3. Confirm the shell renders without a blank screen.
4. Confirm navigation shows every tab:
   - L3 Home
   - Import
   - Proposals
   - Recommendations
   - Graph
   - Context
   - Word Space
   - Source Space
5. Open each tab and confirm the shell remains visible.
6. Confirm no obvious runtime console errors appear during tab switching.
7. Stop the Vite server.
8. Confirm the smoke port no longer has a listener.

## Phase 4I Smoke Result

Verified on 2026-07-08:

- `npm run frontend:build` completed successfully.
- Vite dev server started on `http://127.0.0.1:4189/`.
- HTTP smoke returned `200` and the Vite root container was present.
- Playwright CLI loaded the local page, waited for `L3 Context Space`, and
  captured the shell without a blank screen.
- The dev server was stopped and port `4189` was confirmed released.

## UX Regression Matrix

- Import success must hand off to Proposal Review as a pending proposal only.
- Recommendation `link_gap` accept must hand off to Proposal Review as a
  proposal bridge only.
- Proposal confirm remains the only frontend action that marks Graph, Context,
  Word Space, and Source Space stale.
- Proposal reject and proposal validation feedback must not mark read surfaces
  stale.
- Graph selection is local UI state and must not issue API requests.
- Unsupported graph/link targets stay disabled with explanatory copy.
- Context, Word Space, and Source Space handoffs use explicit ids/slugs only.
- Successful read refresh clears active-read stale state.
- `404` renders not-found feedback, not an empty state.
- `400`, `409`, `422`, `500`, network, and aborted failures must avoid
  `[object Object]` and preserve user input.
- Busy states must prevent duplicate submit, validate, confirm, reject,
  accept, generate, and refresh commands.
- Empty states must describe absent read data without implying active writes.
- Long ids, slugs, hashes, source refs, metadata, and error details must wrap
  inside the existing lightweight shell.

## Static Boundary

The frontend static boundary covers:

- `src/frontend/pages/*.tsx`
- `src/frontend/components/*.tsx`
- `src/frontend/viewModels/*.ts`
- `src/frontend/state/*.ts`
- `src/frontend/App.tsx`
- `src/frontend/api/l3Client.ts`

The boundary forbids server-only imports, raw networking in pages/components/
view-models/state, direct `/api/l3/` route construction outside
`src/frontend/api/l3Client.ts`, and frontend inference of ids or slugs from
labels or surface text.

## Deferred

- manual L3 editor
- graph editing
- node drag persistence
- MCP agent UI
- backend graph expansion
- router or URL deep-link sync
- production auth/session UX
