# L3 Recommendation API Contract

> Scope: Phase 3E deterministic recommendation proposal builder.

Recommendation is a suggestion layer, not an execution layer. It reads owner-scoped L1/L2/L3/FSRS signals and writes auditable recommendation runs/items. It does not directly write active L3 rows, learning progress, `words` JSONB, `word_l2_content`, LLM output, dictionary output, MCP state, or frontend state.

Phase 3G seals this at the HTTP layer: recommendation request bodies and query
parameters use camelCase contract names, route schema failures return `400`
before the recommendation service is called, business validation returns `422`,
missing or out-of-scope rows return `404`, and non-pending accept/reject state
transitions return `409`.

## Tables

| Table | Purpose |
| --- | --- |
| `l3_recommendation_runs` | One deterministic generation run with owner, optional wordbook scope, mode, input hash, and stats. |
| `l3_recommendation_items` | Durable recommendation item with status, score, reason codes, evidence, payload, and optional accepted proposal id. |

Both tables are owner-scoped by `user_id`, protected by RLS, and use composite owner constraints for run, wordbook, and accepted proposal references.

## Recommendation Types

- `review_pack`
- `learn_next`
- `link_gap`
- `context_gap`
- `l2_gap`
- `weak_word`
- `related_word`

## Statuses

- `pending`
- `accepted`
- `rejected`
- `dismissed`
- `expired`

## Evidence Types

- `graph_edge`
- `occurrence_count`
- `fsrs_due`
- `fsrs_weak`
- `l2_missing_field`
- `l3_context_missing`
- `wordbook_neighbor`
- `recent_import`
- `manual_seed`

Evidence items are JSON records with `type`, `ref`, optional `weight`, and optional `note`.

## Endpoints

### POST `/api/l3/recommendations/generate`

Request:

```json
{
  "wordbookId": "optional-wordbook-uuid",
  "mode": "review_pack",
  "seedSlug": "vivid",
  "limit": 20,
  "horizonDays": 7,
  "dryRun": false
}
```

Modes:

- `review_pack`
- `learn_next`
- `gap_scan`
- `link_suggestions`

Response `201`:

```json
{
  "run": {
    "id": "uuid",
    "user_id": "uuid",
    "wordbook_id": "uuid",
    "mode": "review_pack",
    "status": "completed",
    "input_hash": "sha256",
    "stats": { "itemCount": 1 }
  },
  "items": [
    {
      "id": "uuid",
      "recommendation_type": "review_pack",
      "status": "pending",
      "title": "Review pack: vivid",
      "summary": "Due or weak words grouped for quick review with L3 evidence.",
      "priority_score": "80.0000",
      "confidence": "0.8000",
      "reason_codes": ["fsrs_due", "fsrs_weak"],
      "evidence": [{ "type": "fsrs_due", "ref": { "wordId": "uuid" } }],
      "payload": { "suggestedMode": "quick_review" }
    }
  ],
  "stats": { "signalCount": 1, "itemCount": 1, "dryRun": false }
}
```

When `dryRun=true`, no recommendation rows are written; the response uses a deterministic dry-run run id and item ids.

### GET `/api/l3/recommendations`

Query:

- `status` optional, default `pending`
- `recommendationType` optional
- `limit` optional, default `50`, max `100`
- `cursor` optional

Returns a paginated list of owner-scoped recommendation items.

### GET `/api/l3/recommendations/:id`

Returns one owner-scoped recommendation item. Missing or cross-owner ids return `404`.

### POST `/api/l3/recommendations/:id/accept`

Accepts only `pending` recommendations. Non-pending items return `409`.

For `link_gap`, accept creates a Phase 3B proposal bridge:

```json
{
  "item": { "id": "uuid", "status": "accepted", "accepted_proposal_id": "uuid" },
  "proposal": {
    "proposal": { "id": "uuid", "source_type": "agent", "status": "pending" },
    "items": [{ "item_type": "context_link", "status": "pending" }]
  }
}
```

The bridge never creates active `l3_context_links`; confirmation still goes through proposal validation and `confirmProposal`.

For all other types, accept marks the recommendation accepted and returns:

```json
{
  "item": { "id": "uuid", "status": "accepted" },
  "actionPayload": {
    "recommendationId": "uuid",
    "recommendationType": "context_gap",
    "action": "future_consumer",
    "payload": {}
  }
}
```

Future MCP/frontend consumers may use `actionPayload` to start import/search/composer flows, but Phase 3E does not execute those flows.

### POST `/api/l3/recommendations/:id/reject`

Request:

```json
{ "reviewNote": "not relevant" }
```

Rejects only `pending` recommendations and returns the updated item. The review note is accepted at the route contract level for future audit expansion; Phase 3E status persistence only stores the status transition timestamps.

## Error Semantics

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `VALIDATION_ERROR` | Body or query failed route-level schema validation. |
| 404 | `NOT_FOUND` | Wordbook, seed word, or recommendation does not exist or is outside owner scope. |
| 409 | `CONFLICT` | Accept/reject was requested for a non-pending recommendation. |
| 422 | `VALIDATION_ERROR` | Business validation failed, such as invalid limit, horizon, mode, status, or cursor. |

## Isolation Guarantee

Generation may write:

- `l3_recommendation_runs`
- `l3_recommendation_items`

`link_gap` accept may additionally write:

- `l3_proposals`
- `l3_proposal_items`
- `UPDATE l3_recommendation_items`

It must not write:

- active L3 tables: `l3_sources`, `l3_contexts`, `l3_occurrences`, `l3_context_links`
- learning progress: `user_word_progress`, `user_word_l2_progress`
- L2 content: `word_l2_content`
- `words` JSONB or `UPDATE words`
- LLM, dictionary, MCP, or frontend state
