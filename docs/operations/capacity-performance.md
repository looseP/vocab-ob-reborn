# Capacity and Performance Gate

## Purpose

PR M adds reproducible capacity evidence for the current single-node Node.js/PostgreSQL topology. The gate intentionally uses structural SQL-plan assertions and conservative throughput floors rather than fragile microsecond targets.

## Run

```bash
TEST_DATABASE_URL="postgresql://.../vocab_test" \
CAPACITY_TEST_CONFIRM="vocab_test" \
npm run test:capacity
```

`npm run verify:db` now includes this gate after migrations, release verification, and integration tests. The script refuses implicit `DATABASE_URL` fallback and requires an exact `CAPACITY_TEST_CONFIRM=<database-name>` acknowledgement before inserting test rows.

## Gate dimensions

### 1. HTTP capacity

- 2,000 in-process `GET /healthz` requests
- Concurrency: 50
- Required: zero failures and at least 200 requests/second
- Every response must include `X-Request-ID`

This isolates Hono middleware/request-ID/telemetry overhead from network variability. It is a regression tripwire, not a production load prediction.

### 2. SQL execution plans

The gate runs `EXPLAIN (FORMAT JSON, COSTS OFF)` with sequential scans disabled locally to verify the intended index remains usable. It asserts these contracts:

| Query | Required index |
|---|---|
| Due review selection | `idx_user_word_progress_due` |
| Outbox ordered claim | `idx_outbox_events_claim` |
| Expired LLM reservation claim | `idx_llm_usage_pending_expiry` |
| Public word list ordered by lemma | `idx_words_public_lemma_sort` |

The gate parses JSON plans recursively; it does not string-match human-readable EXPLAIN output.

### 3. Outbox concurrency and throughput

- Seeds 1,000 isolated capacity-test events
- Runs four concurrent claimers using `FOR UPDATE SKIP LOCKED`
- Requires all 1,000 events claimed exactly once
- Requires zero duplicate claims
- Conservative floor: 50 events/second
- Test rows are deleted in `finally`

The benchmark measures claim/update persistence throughput, not downstream L2/cascade business effects.

## Interpreting failures

1. **Index contract failure:** inspect migrations and `src/db/schema.ts`; confirm query predicates still match the partial index.
2. **HTTP throughput failure:** inspect newly added middleware and synchronous work in request paths.
3. **Outbox duplicate or incomplete claims:** block release immediately; this indicates broken lease/locking semantics.
4. **Outbox throughput below floor:** check PostgreSQL health, CI host contention, missing claim index, or transaction changes.

## Scaling trigger

Revisit the topology when any sustained production signal reaches 70% of the tested envelope, database waiting requests remain non-zero, or outbox oldest-pending age approaches the five-minute SLO. Scale workers horizontally before increasing batch size beyond the tested bounds.
