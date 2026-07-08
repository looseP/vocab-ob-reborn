# L3 Frontend Integration Contract

> Scope: Phase 3H UX/API consumption contract for the future Phase 4A L3
> frontend. This is a frontend-facing specification only. It does not add
> backend endpoints, graph behavior, recommendation algorithms, DB schema,
> MCP/LLM/dictionary flows, or L1/L2/FSRS behavior.

## Non-Negotiable Semantics

- Import success creates an import job plus a pending proposal. It does not
  create active L3 sources, contexts, occurrences, or context links.
- `POST /api/l3/proposals/:id/confirm` is the only proposal-to-active-L3
  upgrade path.
- Recommendation generation creates recommendation runs/items only.
- `link_gap` recommendation accept creates an accepted recommendation plus a
  proposal bridge. It does not create an active context link.
- Graph and read APIs are read-only. They never create proposals,
  recommendations, active L3 rows, L1/L2 progress, FSRS progress, or
  `word_l2_content`.
- UI copy must distinguish generated proposal, pending review, confirmed
  active L3, accepted recommendation, and rejected/dismissed item.

## UI Surfaces

| UI surface | Purpose | Primary APIs | Must show | Must not imply |
| --- | --- | --- | --- | --- |
| Import Composer / Import Preview | Paste raw text or submit structured candidate contexts. | `POST /api/l3/imports/raw-text`, `POST /api/l3/imports/structured` | `parseStats`, proposal id, proposal items preview, warnings. | Active L3 was written. |
| Proposal Review Queue | Browse proposals by status and start review. | `GET /api/l3/proposals` | status, `source_type`, title, summary, item count, validation signal. | Proposal items are active evidence. |
| Proposal Detail / Review Panel | Review, validate, confirm, or reject one proposal. | `GET /api/l3/proposals/:id`, `POST /validate`, `POST /confirm`, `POST /reject` | ordered items, item validation errors, active entities after confirm. | `valid=false` is an HTTP failure. |
| Context Space Detail | Inspect one active context. | `GET /api/l3/contexts/:id` | source, occurrences, links. | Editing proposal candidates here changes active L3. |
| Word Space / Source Space | Inspect active contexts by word or source. | `GET /api/l3/words/:slug/space`, `GET /api/l3/sources/:id/space` | paginated active contexts, occurrences, links, stats. | Cursor pagination is a full export. |
| Graph Modal / Graph View | Render bounded active L3 graph projection. | `GET /api/l3/graph` | nodes, edges, stats, cursor, empty/loading/error states. | `depth=2` recursively loads all related systems. |
| Recommendation Queue | Generate, inspect, accept, or reject recommendations. | `/api/l3/recommendations*` | type, status, score, evidence, proposal bridge for `link_gap`. | Accepting `link_gap` created an active link. |

## API Consumption Matrix

| UI surface | User action | Method + endpoint | Request source | Required params | Optional params | Success | Response fields used | Errors | UI state transition | Notes / pitfalls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Import Composer | Submit raw text import | `POST /api/l3/imports/raw-text` | local form | `source.sourceType`, `source.title`, `text` | `wordbookId`, source metadata, `targetWords`, `options`, `provenance` | `201` | `importJob`, `proposal`, `items`, `parseStats` | `400`, `404`, `422`, `500` | `submitting -> proposalCreated` | Do not refresh active graph. Invalidate proposal list only. |
| Import Composer | Submit structured import | `POST /api/l3/imports/structured` | local form or external candidate payload | `source`, `contexts[]` | `wordbookId`, context metadata, occurrences, links, provenance | `201` | `importJob`, `proposal`, `items`, `parseStats` | `400`, `404`, `422`, `500` | `submitting -> proposalCreated` | `targetType=context/source` requires active `targetId`; intra-proposal target refs are unsupported. |
| Proposal Queue | Create manual draft proposal | `POST /api/l3/proposals` | local candidate builder | `sourceType`, non-empty `items[]` | `wordbookId`, title, summary, inputHash, proposedBy, provenance | `201` | `proposal`, `items` | `400`, `404`, `422`, `500` | `editing -> pendingReview` | Does not write active L3. |
| Proposal Queue | List proposals | `GET /api/l3/proposals` | filters | none | `status`, `limit`, `cursor` | `200` | `items`, `limit`, `cursor`, `nextCursor` | `400`, `422` | `loading -> loaded/empty` | Bad cursor is `422`, not silent first page. |
| Proposal Detail | Load proposal | `GET /api/l3/proposals/:id` | route param | `id` | none | `200` | `proposal`, `items` | `404`, `500` | `loading -> loaded` | Missing and cross-owner ids both display not found/out-of-scope. |
| Proposal Detail | Validate proposal | `POST /api/l3/proposals/:id/validate` | route param | `id` | none | `200` | `valid`, `errors`, `items[].validation_errors` | `404`, `409`, `422`, `500` | `validating -> valid/invalid` | `valid=false` is a successful response, not a request error. |
| Proposal Detail | Confirm proposal | `POST /api/l3/proposals/:id/confirm` | route param | `id` | none | `200` | `proposal.status`, `items`, `activeEntities` | `404`, `409`, `422`, `500` | `confirming -> confirmed` | This is the only active L3 upgrade action. Refresh graph/read views after success. |
| Proposal Detail | Reject proposal | `POST /api/l3/proposals/:id/reject` | route param + review note form | `id` | `reviewNote` | `200` | `proposal.status`, `items` | `400`, `404`, `409`, `500` | `rejecting -> rejected` | Do not refresh graph after reject. |
| Recommendation Queue | Generate recommendations | `POST /api/l3/recommendations/generate` | generation controls | `mode` | `wordbookId`, `seedSlug`, `limit`, `horizonDays`, `dryRun` | `201` | `run`, `items`, `stats` | `400`, `404`, `422`, `500` | `generating -> loaded/empty` | `dryRun=true` must not persist recommendations. |
| Recommendation Queue | List recommendations | `GET /api/l3/recommendations` | filters | none | `status`, `recommendationType`, `limit`, `cursor` | `200` | `items`, `limit`, `cursor`, `nextCursor` | `400`, `422` | `loading -> loaded/empty` | Use `recommendationType`, not internal DB column names, in query. |
| Recommendation Detail | Load recommendation | `GET /api/l3/recommendations/:id` | route param | `id` | none | `200` | recommendation item row | `404`, `500` | `loading -> loaded` | Missing and cross-owner ids both display not found/out-of-scope. |
| Recommendation Detail | Accept recommendation | `POST /api/l3/recommendations/:id/accept` | route param | `id` | none | `200` | `item`, optional `proposal`, optional `actionPayload` | `404`, `409`, `422`, `500` | `accepting -> accepted` | For `link_gap`, show "Proposal created, review required." Do not show "link created." |
| Recommendation Detail | Reject recommendation | `POST /api/l3/recommendations/:id/reject` | route param + review note form | `id` | `reviewNote` | `200` | updated recommendation item | `400`, `404`, `409`, `500` | `rejecting -> rejected` | Accepted/rejected items cannot be acted on again. |
| Context Detail | Load context detail | `GET /api/l3/contexts/:id` | route param | `id` | none | `200` | `context`, `source`, `occurrences`, `links` | `404`, `500` | `loading -> loaded` | Active context projection only. |
| Word Space | Load word space | `GET /api/l3/words/:slug/space` | route param + filters | `slug` | `wordbookId`, `limit`, `cursor` | `200` | `word`, `contexts`, `sources`, `occurrences`, `links`, `stats`, pagination | `400`, `404`, `422`, `500` | `loading -> loaded/empty` | Wordbook-scoped slug mismatch returns `404`. |
| Source Space | Load source space | `GET /api/l3/sources/:id/space` | route param + filters | `id` | `limit`, `cursor` | `200` | `source`, `contexts`, `occurrences`, `links`, `stats`, pagination | `400`, `404`, `422`, `500` | `loading -> loaded/empty` | Context-level aggregation; do not render duplicate context rows for multiple occurrences. |
| Graph View | Load graph | `GET /api/l3/graph` | graph filters | none | `wordbookId`, `slug`, `sourceId`, `depth`, `limit`, `cursor` | `200` | `nodes`, `edges`, `stats`, `limit`, `cursor`, `nextCursor` | `400`, `404`, `422`, `500` | `loading -> loaded/empty/failed` | Read-only. Invalid `depth` or `limit` is `400`. |

## UI State Machines

### Import Flow

States:

- `idle`
- `editing`
- `submitting`
- `proposalCreated`
- `submitFailed`
- `reviewingProposal`
- `confirmed`
- `rejected`

Rules:

- Import success transitions to `proposalCreated`, never directly to
  `confirmed`.
- `proposalCreated` means a pending proposal exists and active L3 does not.
- Move to `reviewingProposal` when the user opens the generated proposal.
- Move to `confirmed` only after `POST /api/l3/proposals/:id/confirm`
  succeeds.
- Move to `rejected` only after the generated proposal is rejected.

### Proposal Flow

Backend states:

- `pending`
- `confirmed`
- `rejected`
- `canceled`

Frontend derived states:

- `needsValidation`
- `valid`
- `invalid`
- `validating`
- `confirming`
- `confirmed`
- `rejecting`
- `rejected`
- `conflict`

Rules:

- `validate` returning `valid=false` is HTTP `200`; render item-level
  validation errors.
- `confirm` returning `422` means business validation failed; keep the proposal
  in review and show field/item errors.
- `confirm` or `reject` returning `409` means state changed elsewhere; refresh
  proposal detail and disable stale actions.
- Confirmed proposals cannot be rejected. Rejected proposals cannot be
  confirmed.

### Recommendation Flow

Backend states:

- `pending`
- `accepted`
- `rejected`
- `dismissed`
- `expired`

Frontend semantics:

- `generate` creates recommendation items.
- `accept link_gap` creates an accepted recommendation plus a proposal bridge.
- `accept non-link_gap` returns accepted item plus `actionPayload` for a future
  consumer.
- `accept` never means active L3 has been written.
- Rejected items cannot be accepted. Accepted items cannot be rejected.
- `409` displays: "This recommendation changed. Refresh before continuing."

### Graph Read Flow

States:

- `idle`
- `loading`
- `loaded`
- `empty`
- `failed`
- `staleAfterConfirm`

Rules:

- After proposal confirm succeeds, graph and space views become
  `staleAfterConfirm` until refreshed.
- Graph read failure does not affect active L3 state.
- Invalid `depth` or `limit` returns `400`.
- Missing word/source/wordbook filters return `404`.
- Cursor/business validation failures return `422`.

## Error UX Contract

| HTTP | Backend meaning | UI treatment | Retry behavior |
| ---: | --- | --- | --- |
| `400` | Frontend constructed an invalid body/query or local form schema is invalid. | Field-level form error when possible; otherwise development-style toast with request validation summary. | User edits input, then retry. Do not auto-retry unchanged request. |
| `404` | Resource missing or outside owner scope. | Show "not found or no longer available"; offer back-to-list or refresh. | Refresh list or navigate up. |
| `409` | Illegal state transition on stale proposal/recommendation. | Show state-changed message; refresh detail; disable stale action buttons. | Retry only after fresh state is loaded. |
| `422` | Service business validation failed. | Show business errors, ideally item/field-localized. Proposal validation failed should show item-level errors. | User fixes proposal/import payload or confirms required active target first. |
| `500` | Unexpected service failure. | General failure message; preserve current local state. | Manual retry allowed. Do not mark local mutation successful. |

Special cases:

- Structured import target policy violations should say:
  "Confirm the target context/source first, then link using its active id."
- `valid=false` proposal validation is not an error toast; it is review feedback.
- `link_gap` accept success should say:
  "Proposal created, review required."

## Phase 4A.1 Scaffold Hardening

`src/l3/frontend/contract.ts` is the framework-agnostic consumption layer for
future UI hosts. It must remain portable to any later React/Vite/Next/Vue/Svelte
decision and must not import DB, repository, service, HTTP route, Node runtime,
or browser-global state. All command request payloads stay camelCase.

The client covers the frozen Phase 3H endpoint surface:

- imports: raw text and structured import
- proposals: create/list/detail/validate/confirm/reject
- recommendations: generate/list/detail/accept/reject
- active reads: context detail, word space, source space, graph

Frontend errors normalize into:

- `status`, `code`, `message`, `kind`, `retryHint`
- optional `fieldErrors`, `itemErrors`, `details`, and `raw`
- kinds: `bad_request`, `not_found`, `conflict`, `validation`,
  `unexpected`, `network`, `aborted`

Cache signals are framework-neutral objects:

- `keys`
- `activeReadInvalidation`
- `proposalInvalidation`
- `recommendationInvalidation`
- `reason`
- optional `nextSuggestedAction`

Invalidation rules are sealed for Phase 4A.1:

- import success invalidates proposal list/detail only, never graph/read spaces
- proposal validation invalidates proposal detail only
- proposal confirm invalidates proposal list/detail plus graph/read spaces
- proposal reject invalidates proposal list/detail only
- recommendation generation invalidates recommendation list only unless dry-run
- recommendation accept invalidates recommendation list/detail and proposal
  list/detail when a bridge proposal exists, never graph/read spaces
- recommendation reject invalidates recommendation list/detail only
- graph reads have no invalidation side effects

## Frontend View Models

These are frontend view-model contracts, not backend TypeScript interfaces.
Fields listed as backend response fields may remain snake_case when they come
from persisted rows; request payloads and editable command payloads remain
camelCase.

### L3ImportPreviewViewModel

- Source endpoint: `POST /api/l3/imports/raw-text` or
  `POST /api/l3/imports/structured`
- Required fields: `importJob.id`, `importJob.status`, `proposal.id`,
  `proposal.status`, `items[]`, `parseStats`
- Optional fields: warnings, source title, wordbook id, target word preview
- Derived fields: `hasWarnings`, `proposalUrl`, `activeWriteStatus="none"`
- Display notes: show "Pending proposal created"; show parse counts and skipped
  context count.
- Non-editable: import job id/status, proposal id/status, generated item ids.
- Editable before submit: source metadata, text/contexts, target words,
  options, provenance.

### L3ProposalListItemViewModel

- Source endpoint: `GET /api/l3/proposals`
- Required fields: proposal id, status, source type, created/updated time
- Optional fields: title, summary, wordbook id, review note
- Derived fields: item count, status label, canOpen, canConfirm, canReject
- Display notes: status text must distinguish pending review from confirmed
  active L3.
- Non-editable: id, status, timestamps, source type.
- Editable before command: review note on reject only.

### L3ProposalDetailViewModel

- Source endpoint: `GET /api/l3/proposals/:id`
- Required fields: `proposal`, ordered `items[]`
- Optional fields: validation errors, active entity ids, review note
- Derived fields: `isPending`, `isConfirmed`, `isRejected`, `hasErrors`,
  `activeEntityLinks`
- Display notes: show items in ordinal order; show active entities only after
  confirm.
- Non-editable: item ids, ordinals, active entity ids, persisted statuses.
- Editable before confirm: no direct edit in Phase 4A minimum loop; edits
  require a new proposal or future draft editor.

### L3ProposalItemViewModel

- Source endpoint: proposal detail/list responses
- Required fields: item id, item type, ordinal, payload, status
- Optional fields: client ref, validation errors, active entity type/id
- Derived fields: item label, preview text, error badges, created active link
- Display notes: show `context_link` target type clearly; soft targets should be
  labeled as soft references.
- Non-editable: ordinal, status, active entity id.
- Editable before submit: original proposal item payload only in local draft
  tooling, not after persisted proposal creation.

### L3RecommendationListItemViewModel

- Source endpoint: `GET /api/l3/recommendations`,
  `GET /api/l3/recommendations/:id`
- Required fields: id, recommendation type, status, title, priority score,
  confidence, reason codes
- Optional fields: evidence, payload, accepted proposal id, expires at
- Derived fields: reason label, canAccept, canReject, proposalBridgeUrl
- Display notes: for accepted `link_gap`, show proposal review next step.
- Non-editable: id, type, score, evidence, status.
- Editable before command: reject review note.

### L3GraphViewModel

- Source endpoint: `GET /api/l3/graph`
- Required fields: nodes, edges, stats, limit, cursor, nextCursor
- Optional fields: selected filters, selected node, selected edge
- Derived fields: empty flag, page label, node/edge display labels
- Display notes: render soft `l2_item`, `topic`, and `external` nodes
  differently from active L3 nodes.
- Non-editable: graph nodes/edges.
- Editable before request: filters only.

### L3ContextDetailViewModel

- Source endpoint: `GET /api/l3/contexts/:id`
- Required fields: context, source, occurrences, links
- Optional fields: metadata, language, position
- Derived fields: highlighted occurrence spans, source label, outbound link
  chips
- Display notes: occurrence highlighting should trust backend offsets when
  present but degrade gracefully when absent.
- Non-editable: active context/source/occurrence/link rows.
- Editable before command: none in Phase 4A minimum loop.

### L3WordSpaceViewModel

- Source endpoint: `GET /api/l3/words/:slug/space`
- Required fields: word, contexts, sources, occurrences, links, stats,
  pagination
- Optional fields: wordbook filter
- Derived fields: grouped contexts by source, occurrence count labels,
  next-page availability
- Display notes: wordbook-scoped reads must show the active wordbook filter.
- Non-editable: active rows.
- Editable before request: slug, wordbook id, limit, cursor.

### L3SourceSpaceViewModel

- Source endpoint: `GET /api/l3/sources/:id/space`
- Required fields: source, contexts, occurrences, links, stats, pagination
- Optional fields: source metadata, context grouping
- Derived fields: context count, occurrence chips, link chips
- Display notes: source context listings are context-level; multiple
  occurrences should render inside one context card/row.
- Non-editable: active rows.
- Editable before request: limit and cursor.

## Frontend Command Rules

| Command | Endpoint | Optimistic update | Invalidate on success | Failure behavior | Can create active L3? |
| --- | --- | --- | --- | --- | --- |
| `submitRawTextImport` | `POST /api/l3/imports/raw-text` | No | proposal lists | Keep local draft; show field/business errors. | No |
| `submitStructuredImport` | `POST /api/l3/imports/structured` | No | proposal lists | Keep local draft; show target policy guidance on `422`. | No |
| `openCreatedProposal` | client navigation | Yes, local route only | none | If proposal load returns `404`, return to queue. | No |
| `discardLocalImportDraft` | local state only | Yes | none | No backend rollback exists before submit. | No |
| `validateProposal` | `POST /api/l3/proposals/:id/validate` | No | proposal detail | Render `valid=false` as review feedback. | No |
| `confirmProposal` | `POST /api/l3/proposals/:id/confirm` | No | proposal detail/list, graph, context detail, word space, source space | On `409`, refresh proposal detail; on `422`, show item errors. | Yes |
| `rejectProposal` | `POST /api/l3/proposals/:id/reject` | No | proposal detail/list | On `409`, refresh proposal detail. | No |
| `refreshProposal` | `GET /api/l3/proposals/:id` | N/A | proposal detail cache | Show not found/out-of-scope on `404`. | No |
| `openActiveEntitiesAfterConfirm` | client navigation | Yes, after confirm response | active entity target views | If active detail load fails, show refresh/back action. | No |
| `generateRecommendations` | `POST /api/l3/recommendations/generate` | No | recommendation lists | Preserve filters; show `400/422` guidance. | No active L3 |
| `acceptRecommendation` | `POST /api/l3/recommendations/:id/accept` | No | recommendation list/detail; proposal list if response has proposal | On `409`, refresh recommendation detail. | No active L3 |
| `rejectRecommendation` | `POST /api/l3/recommendations/:id/reject` | No | recommendation list/detail | On `409`, refresh recommendation detail. | No |
| `openAcceptedProposal` | client navigation | Yes if response includes proposal id | proposal detail | If proposal load fails, refresh recommendation detail. | No |
| `refreshRecommendationList` | `GET /api/l3/recommendations` | N/A | recommendation list cache | Show empty state if no items. | No |
| `loadGraph` | `GET /api/l3/graph` | N/A | graph cache only | Keep prior graph visible or show skeleton per product choice. | No |
| `reloadGraphAfterConfirm` | `GET /api/l3/graph` | N/A | graph cache | If reload fails, active L3 is still confirmed. | No |
| `loadContextDetail` | `GET /api/l3/contexts/:id` | N/A | context detail cache | Show not found/out-of-scope on `404`. | No |
| `loadWordSpace` | `GET /api/l3/words/:slug/space` | N/A | word space cache | Bad cursor `422` resets user to first page only after explicit user action. | No |
| `loadSourceSpace` | `GET /api/l3/sources/:id/space` | N/A | source space cache | Bad cursor `422` resets user to first page only after explicit user action. | No |

## Cache and Invalidation Contract

Suggested query keys:

- `l3.proposals.list(status,cursor,limit)`
- `l3.proposals.detail(id)`
- `l3.recommendations.list(status,recommendationType,cursor,limit)`
- `l3.recommendations.detail(id)`
- `l3.graph(wordbookId,slug,sourceId,depth,limit,cursor)`
- `l3.context.detail(id)`
- `l3.word.space(wordbookId,slug,cursor,limit)`
- `l3.source.space(sourceId,cursor,limit)`

Invalidation rules:

- Import success: invalidate proposal lists; do not invalidate graph.
- Proposal validate: invalidate proposal detail only.
- Proposal confirm: invalidate proposal detail/list, graph, and any
  context/word/source space related to returned active entities.
- Proposal reject: invalidate proposal detail/list; do not invalidate graph.
- Recommendation generate: invalidate recommendation lists.
- Recommendation accept: invalidate recommendation list/detail; if response
  contains proposal, invalidate proposal lists; do not invalidate graph until
  the accepted proposal is confirmed.
- Recommendation reject: invalidate recommendation list/detail.
- Graph/read load: no invalidation side effects.

## Empty, Loading, and Disabled States

### Import

- Empty text disables submit or shows a field-level error before request.
- `submitting` disables duplicate submit.
- Success shows proposal link and parse stats.
- Warnings are visible but do not imply failure.

### Proposal

- No pending proposals shows an empty queue state.
- `validating`, `confirming`, and `rejecting` disable duplicate actions.
- Confirmed/rejected/canceled proposals hide or disable confirm/reject buttons.
- Validation errors display at item level where possible.

### Recommendation

- No recommendations shows an empty state with generate action.
- `generating` disables duplicate generate.
- Accepted/rejected/dismissed/expired items disable accept/reject.
- Accepted `link_gap` displays "Proposal created, review required."

### Graph

- No nodes displays an empty graph state.
- Loading may keep the previous graph visible with a stale/loading indicator or
  show a skeleton; do not clear active state before the new response arrives.
- Depth and limit controls should prevent invalid values before request.
- `404` displays not found/out-of-scope.

## Phase 4C Implemented Loop

Phase 4C implements the minimum real UI loop for raw import and proposal
review:

- User can submit raw text import from the frontend host.
- Import success displays the pending proposal and parse stats, and does not
  display active L3 creation.
- User can list proposals, open a proposal detail, validate it, confirm it, or
  reject it.
- `validateProposal valid=false` renders item-level feedback as review output.
- Confirm success marks graph/read state as stale after active L3 creation.
- Reject success keeps graph/read state unchanged.
- `400`, `404`, `409`, and `422` are displayed through normalized feedback with
  retry guidance.

Still deferred to later phases:

- structured import authoring UI
- recommendation queue/review UI
- graph read fetching and visualization
- context/word/source space browsing UI

## Phase 4C.1 Hardening Notes

- Import pages must perform explicit local required-field checks before calling
  the shared L3 client, even though the browser also has `required` controls.
- Import preview should show job/proposal status and item summaries, not raw
  active-L3 success wording.
- Proposal detail should render items in ordinal order and keep confirm/reject
  disabled for non-pending proposals or while another action is running.
- Error UI should surface normalized retry hints, field errors, item errors, and
  safe details fallback for `409`/`422` cases.
- Frontend pages must continue to avoid raw `fetch` and direct `/api/l3/`
  endpoint construction; `src/frontend/api/l3Client.ts` remains the route
  adapter.

## Phase 4D.1 Implemented Recommendation Loop

Phase 4D.1 implements the minimum recommendation queue surface:

- User can generate recommendation candidates through the shared frontend
  client.
- User can list and filter recommendation items by status and recommendation
  type.
- User can open one recommendation detail and inspect reason codes, evidence,
  payload, accepted proposal id, score, and confidence.
- User can accept a recommendation. For `link_gap`, the UI shows a proposal
  bridge and opens proposal review; it does not imply an active link exists.
- User can reject a recommendation with an optional review note.
- Generate, accept, and reject cache helpers preserve the contract that
  recommendation actions do not refresh active graph/read surfaces.

Still deferred to later phases:

- graph read fetching and visualization
- context/word/source space browsing UI
- structured import authoring UI
- any backend route/service/repository/schema changes

## Phase 4D.2 Implemented Graph Read Loop

Phase 4D.2 implements the minimum readable graph surface:

- User can load graph data through `client.getGraph`.
- Query controls support optional `wordbookId`, `slug`, `sourceId`, `cursor`,
  and locally validated `depth`/`limit`.
- Success displays graph stats, node rows, edge rows, cursor metadata, and
  explicit empty states.
- Proposal confirm stale state is visible on the Graph page and is cleared only
  after a successful graph refresh.
- Graph reads preserve the read-only contract: no proposal, recommendation,
  import, active L3, L1/L2, FSRS, `word_l2_content`, or `words` writes are
  implied or triggered by the UI.

Still deferred to later phases:

- graph visualization or editing
- backend route/service/repository/schema changes

## Phase 4E Implemented Space Read Loop

Phase 4E adds the three missing active read surfaces:

- Context Detail: user enters `contextId`; the UI calls
  `client.getContextDetail(contextId)` and renders source metadata, context
  text, occurrences, links, created/updated metadata, normalized errors, and
  empty occurrence/link states.
- Word Space: user enters required `slug` plus optional `wordbookId`, `limit`,
  and `cursor`; the UI calls `client.getWordSpace(slug, params)` and renders
  word identifiers, related contexts, occurrences, links, source summaries,
  stats, pagination metadata, normalized errors, and empty states.
- Source Space: user enters required `sourceId` plus optional `limit` and
  `cursor`; the UI calls `client.getSourceSpace(sourceId, params)` and renders
  source metadata, contexts, occurrences grouped by context id, links, stats,
  pagination metadata, normalized errors, and empty context states.

Phase 4E rules:

- Empty required fields are rejected locally before `L3FrontendClient` is
  called.
- `wordbookId` trims to optional omission when blank.
- A backend `404` for slug/wordbook mismatch remains normalized not-found
  feedback and is not rewritten to an empty state.
- The pages never infer or fabricate graph edges, occurrences, context links,
  or active rows on the frontend.
- Proposal confirm read stale state is visible on Graph, Context, Word, and
  Source read pages. Successful read refresh clears read stale only; proposal,
  recommendation, and import invalidation semantics remain untouched.
- The pages do not create proposals, accept recommendations, run imports, write
  active L3, refresh graph edges except through explicit `client.getGraph`, add
  backend endpoints, or add migrations.

## Phase 4D.3 Closed-Loop Smoke Notes

Phase 4D.3 validates the current frontend loop across surfaces:

- Import success can open the created pending proposal in Proposal Review.
- Proposal confirm creates active entities, marks graph/read stale, and keeps
  reject/validate flows from marking graph stale.
- Graph refresh consumes the stale signal only after `client.getGraph` succeeds.
- Recommendation `link_gap` accept can open the created proposal bridge in
  Proposal Review without implying an active link.
- Active graph edges are rendered only from graph read responses after proposal
  confirmation.
- 409 conflicts and 422 validation/business errors continue to use normalized
  shared error shapes across Import, Proposal, Recommendation, and Graph.
- All implemented L3 pages and shared components continue to avoid raw
  networking and direct route construction.

## Phase 4F Runtime UX Contract Notes

Phase 4F hardens the existing runtime and UX contract without expanding feature
scope:

- Automated runtime smoke is `npm run frontend:build`; browser smoke remains a
  manual Vite-host check because the project does not carry a DOM/browser test
  dependency.
- Import, Proposal, Recommendation, Graph, Context, Word Space, and Source
  Space remain the only implemented L3 frontend surfaces.
- Import success invalidates proposal review only and never marks active read
  surfaces stale.
- Recommendation generation, accept, and reject invalidate recommendation or
  proposal review state as appropriate, but never mark active read surfaces
  stale.
- Proposal confirm is the only command that marks active read surfaces stale.
- Graph, Context, Word Space, and Source Space refreshes are read-only and clear
  active-read stale only after successful `L3FrontendClient` reads.
- `400`, `404`, `409`, `422`, `500`, network, and aborted errors must render
  through the shared normalized error path. They are not empty states, do not
  clear user inputs, and must not display `[object Object]`.
- Static API boundary coverage applies to `src/frontend/pages`,
  `src/frontend/components`, `src/frontend/viewModels`, and
  `src/frontend/state`.

## Phase 4G Graph Visualization Contract Notes

Phase 4G adds a visualization to the existing Graph Read Surface without
changing graph API semantics:

- The visual graph is an SVG read view over the `GET /api/l3/graph` response.
- Canvas node count equals response `nodes.length`; canvas edge count equals
  response `edges.length`.
- The frontend does not synthesize active graph edges, infer context links,
  create occurrences, or join extra data from other endpoints.
- Layout is deterministic and local to the frontend. It is a display concern,
  not persisted graph state.
- Node and edge selection is also local display state; selected detail uses only
  the latest response object.
- Existing stats, node list, and edge list remain the accessible fallback and
  contract audit surface.
- Unknown node or edge types use safe fallback display labels and colors rather
  than failing the graph read surface.
- Empty graph responses render empty-state copy instead of an empty or
  misleading SVG.
- Graph refresh success still clears active-read stale; graph read still has no
  proposal, recommendation, import, or active L3 mutation side effects.

## Phase 4A Acceptance Criteria

Minimum frontend loop:

1. User can submit raw text import.
2. User can see generated proposal preview.
3. User can validate proposal.
4. User can confirm proposal.
5. After confirm, user can see active context detail or graph update.
6. User can generate recommendations.
7. User can accept `link_gap` recommendation.
8. After accept, user can jump to proposal review.
9. After confirming the accepted proposal, graph shows the active link.
10. All `400`, `404`, `409`, and `422` responses have clear UI feedback.

Explicit non-goals:

- No full graph editor.
- No MCP agent adapter.
- No LLM automatic L3 generation.
- No recommendation algorithm expansion.
- No L1/L2 review UI refactor.
- No full frontend redesign.

## Phase 4A Implementation Checklist

- Use camelCase in all request bodies and query parameters.
- Treat row-like response fields as read models; do not send snake_case back in
  mutation requests unless a documented response id is required.
- Never label import success as active L3 creation.
- Never label recommendation accept as active L3 creation.
- Only proposal confirm changes active graph/read state.
- Keep stale mutation buttons disabled while a command is in flight.
- Refresh proposal/recommendation detail after `409`.
- Show item-level validation feedback for proposal validation and confirm
  failures.

## Phase 4A.0 Scaffold Notes

The current repository has no frontend host directory or browser build script.
Phase 4A.0 therefore provides a backend-safe frontend consumption scaffold
instead of introducing a UI framework. See
`docs/operations/l3-frontend-implementation-notes.md` for the host decision,
implemented client/error/state helpers, and future UI wiring checklist.
