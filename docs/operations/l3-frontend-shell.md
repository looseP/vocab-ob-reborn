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
- `src/frontend/App.tsx`: local route state for placeholder sections
- `src/frontend/api/l3Client.ts`: thin browser adapter over
  `src/l3/frontend/contract.ts`
- `src/frontend/state/l3CacheSignals.ts`: shell cache signal placeholder
- `src/frontend/components/L3Shell.tsx`: navigation shell
- `src/frontend/pages/*`: L3 Home, Import, Proposal, Recommendation, Graph
  placeholder surfaces
- `src/frontend/styles.css`: shell-only styles

## Placeholder Surfaces

- L3 Home: records host and contract wiring
- Import: skeleton form and "proposal, not active L3" semantic reminder
- Proposals: confirms proposal-confirm as the only active L3 upgrade path
- Recommendations: confirms `link_gap` accept creates a proposal bridge
- Graph: read-only graph placeholder that refreshes after confirm

## Contract Wiring

`src/frontend/api/l3Client.ts` calls `createL3FrontendClient` from
`src/l3/frontend/contract.ts` and injects browser `fetch`. Future UI work must
reuse this path instead of writing a second L3 client.

## Phase 4C/4D Continuation

- Phase 4C should implement Import and Proposal closed-loop UI.
- Phase 4D should implement Recommendation and Graph read UI.
- Component tests should be added when the UI moves beyond placeholders.
