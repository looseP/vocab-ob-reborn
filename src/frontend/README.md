# L3 Frontend

Phase 4C wires the minimal frontend host into the real L3 raw import and
proposal review contracts.

## Decision

- Host: `src/frontend`
- Build: Vite + React + TypeScript
- Scope: shell, navigation, raw import, proposal queue/detail, validation,
  confirm, and reject
- Contract: reuse `src/l3/frontend/contract.ts`

## Non-goals

- No recommendation queue or graph visualization workflow
- No backend route/service/repository/db changes
- No UI component framework
- No graph visualization library
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

## Continue In Phase 4D

- Wire recommendation queue and graph read surfaces.
- Keep accepted recommendation states distinct from active L3 until proposal
  confirmation.
