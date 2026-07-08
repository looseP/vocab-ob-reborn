# L3 Frontend Shell

## Host Decision

Phase 4B creates the first frontend host in this repository:

- directory: `src/frontend`
- build tool: Vite
- UI runtime: React + TypeScript
- output: `dist/frontend`

The repository had no existing frontend host, so Phase 4B adds a minimal
same-repository shell instead of creating a parallel app elsewhere.

## Directory Structure

- `src/frontend/main.tsx`: Vite entry point
- `src/frontend/App.tsx`: local tab state for L3 surfaces
- `src/frontend/api/l3Client.ts`: thin browser adapter over
  `src/l3/frontend/contract.ts`
- `src/frontend/state/l3CacheSignals.ts`: proposal-confirm active-read stale
  signal shared by Graph, Context, Word, and Source read pages
- `src/frontend/components/L3Shell.tsx`: navigation shell
- `src/frontend/pages/*`: L3 Home, Import, Proposal, Recommendation, Graph,
  Context, Word Space, and Source Space surfaces
- `src/frontend/styles.css`: shell-only styles

## Placeholder Surfaces

- L3 Home: records host and contract wiring
- Import: skeleton form and "proposal, not active L3" semantic reminder
- Proposals: confirms proposal-confirm as the only active L3 upgrade path
- Recommendations: confirms `link_gap` accept creates a proposal bridge
- Graph: read-only graph stats, nodes, and edges surface that refreshes after
  proposal confirm
- Context: read-only context detail lookup by context id
- Word Space: read-only word space lookup by slug and optional wordbook id
- Source Space: read-only source space lookup by source id

## Contract Wiring

`src/frontend/api/l3Client.ts` calls `createL3FrontendClient` from
`src/l3/frontend/contract.ts` and injects browser `fetch`. Future UI work must
reuse this path instead of writing a second L3 client.

## Phase 4C/4D/4E Continuation

- Phase 4C should implement Import and Proposal closed-loop UI.
- Phase 4D implements Recommendation and Graph read UI.
- Phase 4E implements Context Detail, Word Space, and Source Space read UI.
- Component tests should be added when the UI moves beyond placeholders.

## Phase 4E Boundary

The Context, Word Space, and Source Space tabs are read-only consumers of
`L3FrontendClient`. They show normalized errors through `L3ErrorMessage`, honor
proposal-confirm read stale state, and clear that stale state only after a
successful read. They do not write active L3 data, create proposals, trigger
recommendations, trigger imports, refresh graph edges, add backend endpoints,
add migrations, or introduce routing/state/UI libraries.

## Phase 4F Runtime Smoke Checklist

Phase 4F keeps the lightweight shell and hardens runtime UX contracts without
adding a router, global state library, graph visualization library, UI
framework, backend endpoint, or migration.

Automated smoke:

- `npm run frontend:build` type-checks the frontend host and builds the Vite
  bundle.
- Vitest covers page/view-model navigation handoffs, stale/cache semantics,
  error UX, empty-state rules, busy-state command guards, and static API
  boundaries.

Manual browser smoke, when needed:

1. Run `npm run frontend:dev`.
2. Open the Vite URL.
3. Navigate to Import, Proposals, Recommendations, Graph, Context, Word Space,
   and Source Space.
4. Confirm each tab renders without console runtime errors.
5. Confirm long ids, JSON previews, errors, and empty states wrap within the
   lightweight shell.
6. Stop the dev server after the check.
