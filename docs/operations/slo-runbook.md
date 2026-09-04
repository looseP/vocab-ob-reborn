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

## Staging Alert Delivery Drill

This drill is synthetic and reversible: it posts a scoped `VocabStagingSyntheticDrill` alert to a staging Alertmanager and then resolves it. It must not stop databases, remove containers, or alter application data.

Offline contract check (does **not** prove notification delivery):

```bash
npm run alerting:drill -- --environment=staging --confirm-staging --confirm-reversible --dry-run
npm run alerting:drill:contract
```

For a live staging drill, set `DRILL_ALERTMANAGER_URL` and `DRILL_RECEIPT_URL` to HTTPS endpoints and list both exact hostnames in comma-separated `DRILL_ALLOWED_HOSTS`. Set `DRILL_LOCK_FILE` to a dedicated absolute persistent path outside temporary directories; the process creates it atomically and holds it across firing, receipt confirmation, and resolution. A leftover lock must only be removed after an operator confirms no drill is running. URLs and allowlist entries containing `production`/`prod`, localhost/loopback targets, embedded credentials, or non-HTTPS schemes are rejected. DNS is re-resolved before every request and private, loopback, link-local, CGNAT, IPv6 ULA/link-local, and IPv4-mapped private addresses are rejected; redirects are disabled. Node fetch does not pin the resolved IP, so a runner-level egress allowlist remains a mandatory outer control against DNS rebinding. Do not put tokens in URLs or command arguments; endpoint authentication must be supplied by platform-side identity/proxy configuration.

```bash
npm run alerting:drill -- --environment=staging --confirm-staging --confirm-reversible --timeout-ms=120000
```

The receipt endpoint is queried with `requestId` and must return JSON flags `firingNotified: true` and later `resolvedNotified: true`. Success requires the complete `firing → notification_confirmed → resolved` sequence before timeout. The emitted JSON evidence contains only request ID, timestamps, phases, mode, and delivery result; it never contains endpoint URLs or tokens.

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
- Alerts aggregate HTTP latency across routes and never copy user IDs, slugs, request IDs, or raw paths into alert labels.

## Core alert procedures

### VocabTargetDown (critical)
1. Confirm the Prometheus target configuration, bearer token, network path, and `/healthz` response.
2. Check the web process and recent deployment logs before restarting it.

### VocabMetricsMissing (critical)
1. Check whether `up{job="vocab-observatory"}` is healthy; a healthy target with a missing counter usually means a scrape-path or application regression.
2. Fetch authenticated `/metrics` and confirm `vocab_observatory_runtime{metric="process_uptime_seconds"}` is present; this fixed series avoids false alerts when a new instance has not served any HTTP request.

### VocabReadinessDraining (warning)
1. Check whether a deployment or controlled shutdown is in progress.
2. If not, inspect lifecycle signal handling and instance logs before replacing the instance.

### VocabHttpErrorBudgetBurnFast (critical)
Follow the `VocabHighErrorRate` triage above. Pause rollout activity while both burn windows remain above threshold.

### VocabHttpErrorBudgetBurnSlow (warning)
Review recent releases and recurring 5xx codes. Schedule corrective work before the 30-day budget is exhausted.

### VocabOutboxBacklogHigh (warning)
Check worker health and throughput, then follow the `VocabOutboxStuck` procedure if event age also breaches five minutes.

### VocabLlmReservationAgeHigh / VocabLlmExpiredReservationsHigh (warning)
Check the `llm-reservation-reaper` process and logs, then run `npm run llm-reservation:metrics` before any manual reap. Separate alerts distinguish old pending work from an accumulation of already-expired reservations.

## Optional platform rule boundary

`optional-platform-alerting-rules.yaml` is not part of the default application rule set. Load it only after installing collectors that implement these bounded metric contracts:

| Metric | Source contract |
|--------|-----------------|
| `vocab_platform_backup_last_success_timestamp_seconds{service="vocab_observatory"}` | External collector updates only after a signed backup completes and verifies successfully |
| `vocab_platform_backup_last_attempt_timestamp_seconds{service="vocab_observatory"}` / `vocab_platform_backup_last_attempt_success{service="vocab_observatory"}` | Collector updates after every completed attempt; success is exactly 0 or 1 |
| `vocab_platform_restore_drill_last_success_timestamp_seconds{service="vocab_observatory"}` | External drill automation updates only after schema-evidence validation succeeds |
| `vocab_platform_restore_drill_last_attempt_timestamp_seconds{service="vocab_observatory"}` / `vocab_platform_restore_drill_last_attempt_success{service="vocab_observatory"}` | Drill automation updates after every completed attempt; success is exactly 0 or 1 |
| `probe_ssl_earliest_cert_expiry{job="blackbox-vocab-observatory"}` | Prometheus blackbox exporter HTTPS probe |
| `vocab_platform_runner_canary_last_success_timestamp_seconds{service="vocab_observatory"}` | CI exporter timestamp after a successful scheduled canary; it is not a runner-online signal |

Do not synthesize these metrics from application telemetry. Relabel optional exporter targets with the bounded `environment="production"` label before loading the rules; the selectors exclude staging and drill targets. Each platform metric contract permits exactly one series per `service`/`environment` pair (and one TLS series per fixed `job`/`environment` target); duplicate series make vector matching ambiguous and must fail collector validation. Keep exporter labels bounded to `service`, `environment`, fixed `job`, and infrastructure identity.

### VocabBackupStale (critical, optional)
Check scheduler logs and the newest signed manifest, run `npm run db:backup:verify`, and investigate storage capacity or database connectivity before forcing another cycle.

### VocabBackupFailed (critical, optional)
Inspect the latest completed attempt and scheduler logs. Preserve its failed manifest/evidence before retrying, then verify the next signed backup.

### VocabBackupCollectorMissing (warning, optional)
Verify the collector process, textfile/remote-write destination, and collector permissions. This alert indicates monitoring loss, not proof that backups failed.

### VocabRestoreDrillCollectorMissing (warning, optional)
Verify the drill collector, its scrape target, and the required production labels. A missing metric is monitoring loss and must not silently resolve freshness alerts.

### VocabRestoreDrillFailed (critical, optional)
Preserve drill output and compare schema evidence. Fix the failure before retrying against an isolated drill database; never target production.

### VocabRestoreDrillOverdue / VocabRestoreDrillCriticallyOverdue (warning / critical, optional)
Schedule `npm run db:restore:drill -- <manifest>` against an isolated database whose name has an allowed drill suffix; never target production. The 35-day warning allows monthly scheduling jitter; the 40-day critical threshold pages after additional remediation grace. Both share `alert_family: restore-drill-freshness`, so the critical alert inhibits the warning. `VocabRestoreDrillFailed` deliberately uses the independent `restore-drill-attempt` family and remains visible because it diagnoses a completed failed attempt rather than missing freshness.

### VocabTlsProbeMetricMissing (warning, optional)
Verify the production blackbox target, TLS module, scrape health, and required labels. Treat absence as lost certificate monitoring rather than a healthy certificate.

### VocabTlsCertificateExpiring / VocabTlsCertificateExpiringSoon (warning / critical, optional)
Confirm the blackbox target and certificate chain, then renew through the platform's certificate owner and re-run the HTTPS probe. Alertmanager should inhibit the 14-day warning while the 7-day critical alert is active.

### VocabRunnerCanaryCollectorMissing (warning, optional)
Verify the CI canary exporter, scrape path, and production labels. This distinguishes exporter loss from a stale but present canary timestamp.

### VocabRunnerCanaryStale (warning, optional)
Check whether the canary workflow was scheduled and whether its job completed. This signal can also be stale because of workflow, provider, or code failures; use a GitHub API exporter with a bounded online gauge if direct runner-online monitoring is required.
