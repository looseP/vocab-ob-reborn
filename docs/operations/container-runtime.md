# Container runtime and release topology

## Process model

One immutable image runs four targets:

1. `migrate`: one-shot Drizzle release migration job.
2. `web`: Hono API and the built frontend.
3. `review-outbox-worker`: transactional outbox consumer.
4. `llm-reservation-reaper`: stale budget-reservation reaper.

The web process never runs migrations. Long-running processes start only after the migration job succeeds.

## Local production-like startup

Copy `.env.example` to an untracked `.env`, replace every credential, and set `APP_ORIGIN` to the exact HTTPS public origin. Then run:

```bash
docker compose build
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d web review-outbox-worker llm-reservation-reaper
docker compose ps
```

For local HTTP-only smoke testing, set `APP_NODE_ENV=development` and an explicit local `APP_ORIGIN=http://localhost:3001` in the untracked `.env`. Never use that override in a public deployment.

## Release order

1. Create and verify a database backup.
2. Build the image once and identify it by immutable digest.
3. Run the migration job using the new image. A failed migration blocks rollout.
4. Roll out web instances and wait for `/readyz` success.
5. Roll out the outbox worker and reservation reaper.
6. Verify `/healthz`, `/readyz`, operational metrics, worker logs, and queue age.

Do not let every web replica run migrations. A deployment platform must model migration as a single job or release command.

## Shutdown contract

- Web flips readiness to `503`, stops accepting traffic, drains HTTP requests, then closes the PostgreSQL pool.
- The outbox worker finishes its currently claimed event but checks the stop flag before every new claim.
- Worker grace must exceed the outbox lease plus scheduling overhead. The worker validates `OUTBOX_SHUTDOWN_GRACE_SECONDS > OUTBOX_LEASE_SECONDS`; Compose additionally uses `OUTBOX_STOP_GRACE_PERIOD` (75 seconds by default). Keep both grace values aligned when changing the lease.
- The reservation reaper finishes its current bounded batch and has interruptible polling sleep.

## Connection budget

Every process owns a PostgreSQL pool. With defaults, three processes can open up to 15 connections (`DB_POOL_MAX=5` each). For multiple replicas, calculate:

```text
(web replicas + outbox replicas + reaper replicas) × DB_POOL_MAX + migration headroom
```

Keep the result below the managed PostgreSQL connection limit with at least 20% operational headroom. Use PgBouncer when replica counts make direct pools impractical.

## Security requirements

- Run the image as the built-in non-root `node` user.
- Inject secrets through the deployment secret store; do not bake `.env` into the image.
- Terminate TLS at a trusted ingress/load balancer and set the exact HTTPS `APP_ORIGIN`.
- Do not expose PostgreSQL publicly.
- Use separate database roles for migration, web/worker runtime, and backup when the target platform is configured.
- Pin deployed images by digest rather than mutable tags.

## Failure drills

Before production cutover, verify:

1. Stop the outbox worker while creating review events; backlog grows without losing the authoritative review write.
2. Restart it; backlog returns to zero and effect receipts prevent duplicates.
3. Stop the reaper; expired reservations become visible, then clear after restart.
4. Send SIGTERM to web; `/readyz` becomes unavailable before the process exits.
5. Force a migration failure; web and workers must not roll out.
6. Restart PostgreSQL; services recover without manual container recreation.

## Platform mapping

The Compose topology is the executable reference, not a claim of high availability. On Kubernetes or another orchestrator map it to:

- one Deployment/Service for web;
- one Deployment for the outbox worker;
- one Deployment or singleton workload for the reaper;
- one migration Job per release;
- managed PostgreSQL instead of the Compose database;
- external secret management, metrics scraping, alerting, and backup scheduling.
