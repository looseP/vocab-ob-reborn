# ADR-0011: L3 Recommendation Proposal Builder

## Status

Accepted for Phase 3E.

## Context

Phase 3A established confirmed active L3 sources, contexts, occurrences, and context links. Phase 3B added the proposal review pipeline. Phase 3C/3C.1 made import routes proposal producers only. Phase 3D/3D.1 sealed read and graph projections with stable identity, deterministic ordering, bounded reads, and owner/wordbook scope.

The next layer needs to recommend review packs, next words, graph link gaps, context gaps, and L2 gaps without turning recommendations into automatic writes. Recommendation output must be auditable and explainable so users, agents, MCP, or future UI can decide what to accept.

## Decision

Phase 3E adds two owner-scoped tables:

- `l3_recommendation_runs` stores one deterministic generation run.
- `l3_recommendation_items` stores auditable recommendation candidates with type, status, score, reason codes, evidence, payload, and optional accepted proposal id.

Recommendation generation may read owner-scoped L1/L2/L3/FSRS state, including `user_word_progress`, `user_word_l2_progress`, `word_l2_content`, active L3 occurrences, and graph links. It may write only recommendation run/item rows. It does not call LLM, dictionary, MCP, or frontend code.

`acceptRecommendation` is deliberately conservative:

- `link_gap` creates a Phase 3B `l3_proposals` envelope with one `context_link` proposal item. The active link still requires normal proposal validation and confirmation.
- `context_gap`, `l2_gap`, `review_pack`, `learn_next`, `weak_word`, and `related_word` are marked accepted and return a future action payload for another consumer. They do not mutate FSRS, active L3, `word_l2_content`, or `words`.
- `rejectRecommendation` only updates the recommendation item status.

## Recommendation Types

- `review_pack`: groups due or weak words for quick review.
- `learn_next`: suggests graph or wordbook neighbors with insufficient review coverage.
- `link_gap`: proposes a missing context link from co-occurrence evidence.
- `context_gap`: suggests importing or searching for missing L3 context evidence.
- `l2_gap`: suggests future composer work for missing L2 fields.
- `weak_word`: surfaces L1/L2 weak words for focused review.
- `related_word`: reserved for richer graph-neighbor suggestions.

## Consequences

- Recommendations are durable, listable, rejectable, and auditable.
- Active L3 and learning progress remain protected: recommendation generation never writes active evidence or scheduler state.
- `link_gap` acceptance bridges into the already-reviewed proposal pipeline instead of bypassing it.
- Future MCP/frontend consumers can use the item payload and evidence contract without changing Phase 3A-3D semantics.
