# SLO & Alerting Runbook

## Service-Level Objectives

| SLO | Target | Window | Measurement |
|-----|--------|--------|-------------|
| Availability | 99.9% | 30d rolling | `1 - (5xx_count / total_request_count)` on `/api/*` routes |
| API Latency (p95) | < 500ms | 30d rolling | `histogram_quantile(0.95, …)` on `/api/*` routes |
| Outbox Freshness | > 99% events processed within 5 min | 30d rolling | `outbox_oldest_pending_age_seconds < 300` |

## Error Budget

- 30d error budget for 99.9% = **43.2 minutes** of downtime or **0.1%** of total requests as 5xx.
- When budget is exhausted, freeze feature deploys and prioritize reliability fixes.

## Alert Triage

### VocabHighErrorRate (critical)
1. Check `/api/operations/metrics` for database health and outbox state.
2. Review structured logs (`scope: "http"`, `level: "error"`) for recurring error codes.
3. If database is down, follow the PostgreSQL recovery runbook.
4. If a specific route is failing, check the corresponding service layer.

### VocabDatabaseUnhealthy (critical)
1. Verify PostgreSQL container is running: `docker compose ps postgres`.
2. Check pool health in metrics: `database_connections_total`, `database_waiting_requests`.
3. If pool is exhausted, increase `DB_POOL_MAX` or reduce concurrent load.
4. If PostgreSQL is down, follow `docs/operations/container-runtime.md` → Recovery.

### VocabOutboxDeadLetter (critical)
1. Inspect dead-letter events: `npm run outbox:metrics`.
2. Review the event payload and error in structured logs (`scope: "review-outbox"`).
3. Fix the root cause, then replay: `npm run outbox:replay <event-uuid>`.

### VocabOutboxStuck (critical)
1. Check if the worker process is running: `docker compose ps review-outbox-worker`.
2. Review worker logs for batch failures (`scope: "review-outbox"`, `level: "error"`).
3. If the worker crashed, restart it: `docker compose restart review-outbox-worker`.
4. If leases are stuck, wait for `OUTBOX_LEASE_SECONDS` to expire then verify the worker picks them up.

### VocabHighLatencyP95 (warning)
1. Identify the affected route from the `route` label.
2. Check if database queries are slow — review `scope: "db"` logs for `slow query` entries.
3. Check if LLM calls are blocking — review LLM semaphore and reservation metrics.
4. Consider adding indexes or caching if a specific query pattern is hot.

## Metrics Endpoint

- **URL**: `GET /metrics`
- **Auth**: `Authorization: Bearer <METRICS_BEARER_TOKEN>` (distinct from `OWNER_API_TOKEN`)
- **Content-Type**: `text/plain; version=0.0.4; charset=utf-8`
- **Scrape interval**: 30s recommended

## Metric Reference

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `vocab_observatory_http_requests_total` | Counter | method, route, status_class | Completed HTTP requests |
| `vocab_observatory_http_request_duration_seconds` | Histogram | method, route, status_class | HTTP latency distribution |
| `vocab_observatory_runtime` | Gauge | metric (bounded enum) | Operational gauges (see below) |
| `vocab_observatory_process_*` | (default) | — | Node.js process metrics from prom-client |

### Runtime Gauge `metric` Label Values

| metric | Description |
|--------|-------------|
| `process_uptime_seconds` | Process uptime in seconds |
| `process_draining` | 1 if shutting down, 0 otherwise |
| `database_healthy` | 1 if pool probe succeeded, 0 otherwise |
| `database_connections_total` | Total pool connections |
| `database_connections_idle` | Idle pool connections |
| `database_waiting_requests` | Requests waiting for a connection |
| `outbox_pending` | Pending outbox events |
| `outbox_processing` | Events currently being processed |
| `outbox_dead_letter` | Dead-letter events |
| `outbox_oldest_pending_age_seconds` | Age of the oldest pending event |
| `llm_reservations_pending` | Pending LLM reservations |
| `llm_reservations_expired_pending` | Expired but not yet reaped reservations |
| `llm_reservations_oldest_pending_age_seconds` | Age of the oldest pending reservation |

## Cardinality Guarantees

- HTTP metrics use a **bounded** set of route labels (`/api/words/*`, `/api/review/*`, etc.) — never raw paths.
- The `metric` label on the runtime gauge is a fixed enum — no dynamic values.
- No user IDs, slugs, or request IDs appear as labels.
