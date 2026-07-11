# Data lifecycle operations

## Scope and retention policy

The lifecycle job is a one-shot, externally scheduled maintenance task. It is not part of the long-running application stack and must use a dedicated, least-privilege database role through `DATA_LIFECYCLE_DATABASE_URL`. The job must never fall back to the application's `DATABASE_URL`.

Apply the retention periods encoded by the lifecycle contract to eligible operational data only. Legal holds, incident evidence, audit records, and backup objects remain outside this deletion path. Before changing any retention window, obtain the data owner's approval and review restore, compliance, and product requirements.

Backup retention is a separate control boundary:

- The local backup scheduler keeps the newest **14 backup sets** (`BACKUP_RETENTION_COUNT=14`). This is count-based local recovery convenience, not the authoritative long-term policy.
- Object-storage lifecycle policy retains **8 weekly** and **12 monthly** verified backup sets. Object storage owns long-term deletion, immutability/object lock, access logging, and replication.
- The lifecycle database job does not delete backup files or object-storage versions.

## Required controls

- Supply secrets from the deployment secret manager; never commit a real URL or password.
- Use a database role limited to the lifecycle procedures/tables required by the contract.
- Trigger the Compose profile from an external scheduler that records actor, image digest, database identity, command, timestamps, exit status, and captured report.
- Allow only one lifecycle execution at a time. Treat an advisory-lock conflict as a skipped/failed schedule, not as permission to run another copy.
- Preserve dry-run and execution evidence according to the audit policy; redact connection strings and row contents.

## Dry-run, approval, and execution

1. Confirm a recent verified backup exists and the database is healthy.
2. Run the default dry-run and capture its structured report:

   ```bash
   docker compose --profile data-lifecycle run --rm data-lifecycle
   ```

   For a local source checkout, the equivalent is:

   ```bash
   DATA_LIFECYCLE_DATABASE_URL="postgresql://lifecycle_role:***@db:5432/vocab" \
   DATA_LIFECYCLE_CUTOFF="2026-01-01T00:00:00.000Z" \
   npm run data:lifecycle:dry-run
   ```

3. Review eligible row counts, cutoff timestamps, batch limits, lock/statement timeout evidence, and any skipped domains. Compare unusual changes with recent ingestion and incident activity.
4. Obtain approval from a named data owner/operator. Record the dry-run artifact digest, approved database identity, image digest, and approval ticket.
5. Reuse the exact canonical UTC `DATA_LIFECYCLE_CUTOFF` approved from dry-run; changing it invalidates approval. Keep `DATA_LIFECYCLE_CONFIRM_CUTOFF` empty during dry-run. For execution, set it to exactly the same byte-for-byte value as `DATA_LIFECYCLE_CUTOFF`. Execution is fail-closed unless the cutoff confirmation, database name returned by `SELECT current_database()`, explicit write authorization, and production confirmation required by the CLI are all valid.

   ```bash
   docker compose --profile data-lifecycle run --rm \
     -e DATA_LIFECYCLE_CUTOFF="2026-01-01T00:00:00.000Z" \
     -e DATA_LIFECYCLE_CONFIRM_CUTOFF="2026-01-01T00:00:00.000Z" \
     -e DATA_LIFECYCLE_CONFIRM="<current_database>" \
     -e DATA_LIFECYCLE_ALLOW_WRITE="true" \
     -e DATA_LIFECYCLE_PRODUCTION_CONFIRM="<production-confirmation>" \
     data-lifecycle \
     ./node_modules/.bin/tsx scripts/run-data-lifecycle.ts --execute
   ```

6. Capture the execution report and reconcile deleted/retained counts with the approved dry-run. Stop and investigate on any mismatch or partial failure; do not blindly retry.
7. After deletion, run targeted `ANALYZE` for tables changed materially, using a controlled database session, then verify query plans and latency. `ANALYZE` updates planner statistics without rewriting the whole table.

## Vacuum policy

Normal PostgreSQL autovacuum is the primary mechanism for reclaiming dead tuples. Monitor dead-tuple ratio, autovacuum progress, table/index growth, lock waits, and replica lag after lifecycle runs. Tune autovacuum per table only from measured evidence.

**Never schedule `VACUUM FULL`.** It rewrites the table, requires an exclusive lock, can cause extended unavailability, consumes extra disk, and increases replica/WAL pressure. If severe bloat makes it unavoidable, handle it as a separately approved maintenance event with capacity validation, backup/rollback planning, replica-impact review, an outage window, and post-operation verification.

## Failure and rollback

Deletion is not transactionally reversible after commit. On failure, preserve logs and reports, stop further schedules, and assess scope. Restore only through the documented isolated recovery process; prefer a forward correction when possible because a full database restore rewinds unrelated domains. Never use the lifecycle confirmation as authorization for restore, schema changes, or ad-hoc destructive SQL.
