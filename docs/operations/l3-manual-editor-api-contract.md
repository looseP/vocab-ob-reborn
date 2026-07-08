# L3 Manual Editor API Contract

> Scope: Phase 5A design contract for future Phase 5B manual active create
> commands. This document does not introduce new endpoints or migrations.

Manual editor commands are confirmed owner/manual active writes. They reuse the
existing Phase 3A active create routes:

- `POST /api/l3/sources`
- `POST /api/l3/contexts`
- `POST /api/l3/occurrences`
- `POST /api/l3/context-links`

Do not add `/api/l3/manual/*` duplicates for Phase 5B unless the existing
routes are removed or changed. The frontend product surface may be named Manual
Editor, but the HTTP contract remains the active L3 create contract.

## Phase 5B Client Contract

Phase 5B exposes the existing active create routes through the shared frontend
client contract instead of adding new HTTP endpoints:

- `L3FrontendClient.createSource(input)` -> `POST /api/l3/sources`
- `L3FrontendClient.createContext(input)` -> `POST /api/l3/contexts`
- `L3FrontendClient.createOccurrence(input)` -> `POST /api/l3/occurrences`
- `L3FrontendClient.createContextLink(input)` -> `POST /api/l3/context-links`

These methods preserve camelCase request payloads and normalized L3 error
handling. They are intended for trusted, user-triggered, single-record manual
commands only. Import, recommendation, agent, MCP, LLM, external-tool, and bulk
flows continue to use proposal review and do not call these methods as an
unreviewed bypass.

## Write Path Policy

| Source | Direct active create | Proposal path | Notes |
| --- | ---: | ---: | --- |
| Manual single source create | Yes | No | Explicit owner action. |
| Manual single context create | Yes | No | Must attach to owner source. |
| Manual single occurrence create | Yes | No | Must pass word scope and surface/offset validation. |
| Manual single context link create | Yes | No | Must pass anchor and target validation. |
| Manual bulk paste or auto extraction | No | Yes | Use import/proposal review. |
| Agent, MCP, external tool, LLM, parser | No | Yes | Unreviewed candidate. |
| Import route | No | Yes | Existing Phase 3C producer. |
| Recommendation `link_gap` accept | No | Yes | Existing Phase 3E proposal bridge. |

## Source Create

Endpoint: `POST /api/l3/sources`

Required:

- `sourceType`
- `title`

Optional:

- `wordbookId`
- `author`
- `url`
- `language`
- `metadata`

Rules:

- `sourceType` uses the existing enum:
  `article | book | video | audio | chat | manual | web | other`.
- `title` must be non-empty after trimming.
- `wordbookId`, when supplied, must belong to the authenticated owner.
- `metadata` is JSON. Phase 5B UI should expose common fields first and reserve
  raw metadata for advanced use.
- Source text is not stored as a separate source body in the current schema;
  concrete language evidence belongs in `l3_contexts.text`.

Success:

- writes one active `l3_sources` row
- does not write proposal/import/recommendation rows
- does not touch L1/L2, FSRS, `word_l2_content`, or `words`

## Context Create

Endpoint: `POST /api/l3/contexts`

Required:

- `sourceId`
- `contextType`
- `text`

Optional:

- `normalizedText`
- `language`
- `position`
- `metadata`

Rules:

- `sourceId` must resolve to an owner-scoped source.
- `contextType` uses the existing enum:
  `sentence | paragraph | excerpt | dialogue | note`.
- `text` must be non-empty.
- Context owner is inherited by validated source ownership.
- `language` defaults to source language when omitted by the service.
- `position` and `metadata` are JSON.
- Context create does not auto-create occurrences or links. The frontend may
  offer the next wizard step after success.

Success:

- writes one active `l3_contexts` row
- marks active read surfaces stale in the future frontend command model
- does not create a proposal

## Occurrence Create

Endpoint: `POST /api/l3/occurrences`

Required:

- `contextId`
- `surface`
- one of `wordId` or `slug`

Optional:

- `lemma`
- `startOffset`
- `endOffset`
- `confidence`
- `evidence`

Rules:

- `contextId` must resolve to an owner-scoped context with its source.
- `surface` must be non-empty.
- If the context source has `wordbook_id`, `wordId` or `slug` must resolve
  inside that wordbook.
- If the context source has no `wordbook_id`, word lookup remains global, but
  the occurrence remains owner-scoped through the context.
- `confidence`, when supplied, must be between `0` and `1`.
- Partial offsets are invalid: `startOffset` and `endOffset` must be supplied
  together.
- Explicit offsets must be integer, in range, and satisfy:
  `context.text.slice(startOffset, endOffset) === surface`.
- Matching is case-sensitive exact comparison. Any future normalized matching
  strategy must be separately named and documented.

Frontend helper policy:

- Phase 5B may include a surface-match helper.
- If the surface occurs once, the UI may prefill offsets.
- If the surface occurs multiple times, the UI must ask the user to choose.
- The backend still accepts only the final exact payload and remains the
  authority.

Success:

- writes one active `l3_occurrences` row
- does not write proposals, imports, recommendations, FSRS progress, or L2
  content

## Context Link Create

Endpoint: `POST /api/l3/context-links`

Required:

- `linkType`
- `targetType`
- at least one of `contextId` or `wordId`

Optional:

- `targetId`
- `targetRef`
- `confidence`
- `provenance`

Rules:

- `linkType` uses the existing enum:
  `supports | illustrates | contrasts | collocates_with | synonym_of |
  antonym_of | derived_from | topic_related | manual_link`.
- `targetType` uses the existing enum:
  `word | l2_item | context | source | topic | external`.
- `contextId`, when supplied, must resolve to an owner-scoped context.
- `wordId`, when supplied, must refer to an existing word.
- If `contextId` is supplied and that context source has `wordbook_id`, anchor
  `wordId` must belong to that same wordbook.
- `targetType=word` requires UUID `targetId` and the target word must exist. If
  the anchor context is wordbook-scoped, the target word must belong to the
  same wordbook.
- `targetType=context` requires UUID `targetId` owned by the authenticated user.
- `targetType=source` requires UUID `targetId` owned by the authenticated user.
- `targetType=l2_item` is a soft reference and requires `targetRef.field` plus
  one of `targetRef.contentId`, `targetRef.hash`, or `targetRef.sourceRef`.
- `targetType=topic` and `targetType=external` may use soft `targetRef`.
- The frontend must not infer active target ids from labels, surfaces, graph
  labels, or row order.
- Manual link provenance should include `{ "source": "manual" }`.

Success:

- writes one active `l3_context_links` row
- marks graph/read state stale in the future frontend command model
- does not create a proposal

## Error Semantics

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 400 | `VALIDATION_ERROR` | Route-level body validation failed. |
| 404 | `NOT_FOUND` | Owner-scoped source/context/word/wordbook/target was not found. |
| 409 | `CONFLICT` | Reserved for future duplicate or edit/delete conflicts. |
| 422 | `VALIDATION_ERROR` | Business validation failed, including offset mismatch, wordbook mismatch, invalid target reference, or invalid soft ref shape. |
| 500 | `INTERNAL` | Unexpected failure. |

## Isolation Requirements

Manual create routes may write only their active L3 table:

- source create -> `l3_sources`
- context create -> `l3_contexts`
- occurrence create -> `l3_occurrences`
- context link create -> `l3_context_links`

They must not write:

- `l3_import_jobs`
- `l3_proposals`
- `l3_proposal_items`
- `l3_recommendation_runs`
- `l3_recommendation_items`
- `word_l2_content`
- `user_word_progress`
- `user_word_l2_progress`
- `words` JSONB content or hash columns

## Phase 5B Test Plan

Backend:

- source create rejects cross-user `wordbookId`
- context create rejects cross-user `sourceId`
- occurrence create rejects cross-user `contextId`
- occurrence create rejects cross-wordbook `wordId` or `slug`
- occurrence create rejects offset/surface mismatch
- context link create rejects invalid active target ids
- context link create rejects wordbook-mismatched anchor and target words
- `l2_item` accepts only valid soft ref shape
- active create routes do not write proposal/import/recommendation/L1/L2/FSRS
  tables

HTTP:

- route schema errors return `400`
- out-of-scope ids return `404`
- business validation returns `422`
- response bodies preserve current active row shapes

Architecture:

- manual editor service path stays within L3 context service/repository
- no dependency on L1/L2 service, FSRS, LLM, dictionary, MCP, import parser, or
  recommendation builder
