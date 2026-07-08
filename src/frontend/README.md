# L3 Frontend Shell

Phase 4B creates the minimal frontend host for later L3 UI work.

## Decision

- Host: `src/frontend`
- Build: Vite + React + TypeScript
- Scope: shell, navigation, placeholder pages, and contract import smoke
- Contract: reuse `src/l3/frontend/contract.ts`

## Non-goals

- No full import/proposal/recommendation/graph workflows
- No backend route/service/repository/db changes
- No UI component framework
- No graph visualization library
- No auth implementation

## Continue In Phase 4C/4D

- Phase 4C: wire Import and Proposal surfaces to the existing L3 contract.
- Phase 4D: wire Recommendation and Graph read surfaces.
- Keep pending proposal and accepted recommendation states distinct from active L3.
