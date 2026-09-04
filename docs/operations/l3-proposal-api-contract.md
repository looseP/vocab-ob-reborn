# L3 Proposal API Contract

> Scope: Phase 3B backend proposal/review/confirm pipeline for unreviewed L3
> candidates.

All `/api/l3/proposals*` routes require owner auth. HTTP routes only call
`L3ProposalService`; they do not import repositories, DB, dictionary, LLM, MCP,
or parser code.

Phase 3G seals this at the HTTP layer: proposal request bodies and query
parameters use camelCase contract names, route schema failures return `400`
before the proposal service is called, validation results with `valid=false`
still return `200`, illegal state transitions return `409`, and business
validation failures return `422`.

## Relationship to Active L3

Phase 3A active L3 routes are confirmed owner/manual writes. Phase 3B proposal
routes are for agent/import/external/tool-generated candidates that are not yet
trusted. Proposal create, validate, and reject never write active L3 tables.

Phase 3C import routes are proposal producers. `/api/l3/imports/raw-text` and
`/api/l3/imports/structured` create `l3_import_jobs` plus pending proposal
items; they do not create active source/context/occurrence/link rows.

Only `POST /api/l3/proposals/:id/confirm` upgrades proposal items into:

- `l3_sources`
- `l3_contexts`
- `l3_occurrences`
- `l3_context_links`

Confirm reuses the Phase 3A validations before and during the transaction.

## Tables

| Table | Purpose |
| --- | --- |
| `l3_proposals` | Owner-scoped envelope for a group of unreviewed candidate items. |
| `l3_proposal_items` | Ordered source/context/occurrence/context_link candidate payloads. |

Owner isolation is enforced by service lookups and DB constraints:

- `l3_proposals(id, user_id)` unique owner key
- `l3_proposals(wordbook_id, user_id)` composite FK to `wordbooks(id, user_id)`
- `l3_proposal_items(proposal_id, user_id)` composite FK to `l3_proposals(id, user_id)`

## Payload Shape

Proposal item payloads use camelCase service input names. This is the
agent-readable contract; DB snake_case is only used after confirm.

```json
{
  "sourceType": "agent",
  "title": "Contexts from article import",
  "summary": "3 contexts for vivid/storm",
  "wordbookId": "uuid",
  "provenance": {
    "source": "external_agent",
    "agentName": "context-builder"
  },
  "items": [
    {
      "itemType": "source",
      "clientRef": "src-a",
      "payload": {
        "sourceType": "article",
        "title": "Essay on attention",
        "url": "https://example.com/essay",
        "language": "en"
      }
    },
    {
      "itemType": "context",
      "clientRef": "ctx-a",
      "payload": {
        "sourceRef": "src-a",
        "contextType": "sentence",
        "text": "She gave a vivid account of the storm.",
        "language": "en"
      }
    },
    {
      "itemType": "occurrence",
      "payload": {
        "contextRef": "ctx-a",
        "slug": "vivid",
        "surface": "vivid",
        "startOffset": 11,
        "endOffset": 16,
        "confidence": 1,
        "evidence": { "method": "agent_offset" }
      }
    },
    {
      "itemType": "context_link",
      "payload": {
        "contextRef": "ctx-a",
        "linkType": "illustrates",
        "targetType": "external",
        "targetRef": { "url": "https://example.com/essay#vivid" },
        "provenance": { "source": "agent" }
      }
    }
  ]
}
```

Supported item references:

- `context.sourceId` for an existing source or `context.sourceRef` for a source
  item in the same proposal
- `occurrence.contextId` for an existing context or `occurrence.contextRef` for
  a context item in the same proposal
- `context_link.contextId`/`contextRef` plus optional anchor `wordId`

`context_link.targetType=context` and `context_link.targetType=source` require
an active `targetId`. Intra-proposal link targets such as
`targetRef.contextRef` or `targetRef.sourceRef` are not part of the Phase 3C.1
contract; confirm first, then create a link to the active target id.

## Endpoints

### POST `/api/l3/proposals`

Creates a pending proposal and ordered pending items. This route writes only
`l3_proposals` and `l3_proposal_items`.

Response `201`:

```json
{
  "proposal": {
    "id": "uuid",
    "user_id": "uuid",
    "wordbook_id": "uuid",
    "source_type": "agent",
    "status": "pending",
    "title": "Contexts from article import",
    "summary": "3 contexts for vivid/storm",
    "input_hash": null,
    "proposed_by": null,
    "provenance": {},
    "review_note": null,
    "confirmed_at": null,
    "rejected_at": null,
    "created_at": "2026-07-08T00:00:00.000Z",
    "updated_at": "2026-07-08T00:00:00.000Z"
  },
  "items": [
    {
      "id": "uuid",
      "proposal_id": "uuid",
      "user_id": "uuid",
      "item_type": "source",
      "ordinal": 1,
      "payload": { "clientRef": "src-a", "sourceType": "article", "title": "Essay" },
      "status": "pending",
      "validation_errors": [],
      "active_entity_type": null,
      "active_entity_id": null,
      "created_at": "2026-07-08T00:00:00.000Z",
      "updated_at": "2026-07-08T00:00:00.000Z"
    }
  ]
}
```

### GET `/api/l3/proposals`

Query:

- `status` optional, default `pending`
- `limit` optional, default `50`, max `100`
- `cursor` optional opaque cursor

Malformed cursors return `422 VALIDATION_ERROR`; they never silently return the
first page.

### GET `/api/l3/proposals/:id`

Returns the owner-scoped proposal envelope and ordered items.

### POST `/api/l3/proposals/:id/validate`

Runs the same business validation used by confirm, updates item
`validation_errors`, and does not write active L3 tables.

Validation checks include:

- source and context owner scope
- proposal/source `wordbookId` owner scope
- occurrence word lookup inside source wordbook when scoped
- occurrence `text.slice(startOffset,endOffset) === surface`
- context link target existence and owner scope
- `l2_item` soft references require `field` plus `contentId`, `hash`, or
  `sourceRef`

Response `200` includes `valid: boolean` and flat `errors[]`.

### POST `/api/l3/proposals/:id/confirm`

Confirms a pending proposal. Confirm is transactional and processes items in
`ordinal` order. It writes active L3 rows, marks items confirmed, records
`active_entity_type`/`active_entity_id`, and marks the proposal confirmed.

If any later item fails, the transaction rolls back and the proposal is not
confirmed. Confirming a confirmed/rejected/canceled proposal returns `409
CONFLICT`.

### POST `/api/l3/proposals/:id/reject`

Request:

```json
{ "reviewNote": "Not enough evidence." }
```

Rejects a pending proposal, marks pending items rejected, and does not write
active L3 tables. Rejecting a confirmed/rejected/canceled proposal returns `409
CONFLICT`.

## Error Semantics

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `VALIDATION_ERROR` | HTTP body/query failed route-level validation. |
| 404 | `NOT_FOUND` | Proposal or referenced row does not exist or is outside owner scope. |
| 409 | `CONFLICT` | Proposal status does not allow the requested action. |
| 422 | `VALIDATION_ERROR` / `BUSINESS_RULE` | Business validation failed, including bad cursor, offset mismatch, wordbook mismatch, or invalid target reference. |
| 500 | `INTERNAL` | Unexpected failure. |

## Isolation Guarantee

Proposal create, list, get, validate, and reject write only proposal tables.
Proposal confirm writes active L3 tables but still does not modify:

- `words` JSONB content columns
- `word_l2_content`
- `user_word_progress`
- `user_word_l2_progress`
- L1/L2 content hashes or stale/recheck flags
- dictionary, LLM, MCP, recommendation, parser, or frontend modules
