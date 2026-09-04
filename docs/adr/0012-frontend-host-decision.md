# ADR-0012: Frontend Host Decision

## Context

Phase 3H defined the L3 frontend integration contract. Phase 4A.0 and 4A.1
added and hardened `src/l3/frontend/contract.ts`, but the repository still had
no frontend host: no `src/frontend`, `web`, `client`, `app`, `pages`,
`components`, `public`, `vite.config.*`, `next.config.*`, or `index.html`.

The next phases need a clear host location before implementing L3 import,
proposal, recommendation, and graph UI surfaces.

## Decision

Create a minimal same-repository frontend shell under `src/frontend` using Vite,
React, and TypeScript.

The shell imports the existing L3 frontend contract through a thin browser
adapter in `src/frontend/api/l3Client.ts`. It does not create a second L3 API
client and does not import backend routes, services, repositories, or DB code.

## Consequences

- `npm run frontend:dev` starts the frontend shell.
- `npm run frontend:build` typechecks the frontend shell and builds it into
  `dist/frontend`.
- Future Phase 4C/4D work has a stable host for L3 UI surfaces.
- The backend server remains API-only in this phase; no static serving contract
  is introduced.

## Non-goals

- No complete import/proposal/recommendation/graph UI loop.
- No graph editor or graph visualization dependency.
- No UI component framework, state library, CSS framework, auth library, or MCP
  adapter.
- No backend endpoint, service, repository, DB schema, migration, L1/L2/FSRS, or
  recommendation algorithm changes.

## Phase 4B Constraints

- Import success still means pending proposal, not active L3.
- `link_gap` recommendation accept still means proposal bridge, not active link.
- Proposal confirm remains the only active L3 upgrade path.
- Graph remains read-only and refreshes after confirm.
