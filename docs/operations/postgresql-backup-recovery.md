# PostgreSQL Backup, Recovery, and Rollback Runbook

## Objectives

- Initial RPO: 24 hours. Tighten only after measuring data-loss tolerance and storage cost.
- Recovery drill target: restore and pass the release database gate within 30 minutes for the current dataset.
- A backup is not considered valid until its SHA-256 manifest verifies and an isolated restore drill succeeds.

## Security boundaries

- Use a dedicated backup role with `CONNECT` and read access only. Do not use the application owner in scheduled jobs.
- Supply credentials through `DATABASE_URL` or a secret manager. The script never writes the URL or password to its manifest.
- Generate backups only on an encrypted volume with restrictive OS permissions, then move dump and manifest to encrypted object storage with versioning, immutability/retention lock, and access logging.
- Keep backup encryption keys outside the database account and test key recovery separately.

## Create and verify a backup

```bash
BACKUP_DIR=./backups \
DATABASE_URL="postgresql://backup_role:***@db:5432/vocab" \
npm run db:backup

npm run db:backup:verify -- ./backups/vocab-YYYYMMDDTHHMMSSZ.manifest.json
```

The custom-format dump is created through a unique partial file and atomically published with owner and ACL metadata removed. A sidecar manifest records the database name, size, pg_dump version, SHA-256 digest, migration count, public table count, and public function count.

PowerShell equivalent:

```powershell
$env:BACKUP_DIR = ".\backups"
$env:DATABASE_URL = "postgresql://backup_role:***@db:5432/vocab"
npm run db:backup
```

## Isolated recovery drill

Create an empty database whose name ends with `_drill`, `_restore`, or `_test`. The tool requires an exact `ALLOW_DESTRUCTIVE_RESTORE=host:port/database` confirmation, rejects the source identity, and refuses a non-empty target. These are guardrails, not a substitute for network/account isolation from production.

```bash
DATABASE_URL="postgresql://backup_role:***@prod-db:5432/vocab" \
DRILL_DATABASE_URL="postgresql://restore_role:***@drill-db:5432/vocab_drill" \
ALLOW_DESTRUCTIVE_RESTORE="drill-db:5432/vocab_drill" \
npm run db:restore:drill -- ./backups/vocab-YYYYMMDDTHHMMSSZ.manifest.json
```

The drill performs:

1. Manifest and SHA-256 verification.
2. `pg_restore --clean --if-exists --exit-on-error` into the explicit drill database.
3. Existing release database verification (`test:db-release`) against the restored database.
4. Comparison of restored migration/table/function evidence against the signed-by-storage manifest. For production-grade authenticity, store the manifest in immutable storage or add an external HMAC/signature; SHA-256 alone detects accidental corruption, not a malicious writer.

Never point `DRILL_DATABASE_URL` at production. The tool deliberately does not create or drop databases.

## Retention baseline

- Daily backups: 14 days.
- Weekly backups: 8 weeks.
- Monthly backups: 12 months.
- Retention deletion belongs to object-storage lifecycle policy, not the backup script. This avoids broad local deletion logic and provides auditable retention.

## Migration rollback decision

1. **Application-only fault, schema compatible:** redeploy the previous application image.
2. **Additive migration fault:** deploy a forward-fix migration; do not restore the entire database.
3. **Destructive migration or confirmed data corruption:** stop writes, capture an incident backup, restore the last verified backup to an isolated database, measure data loss, then choose controlled cutover.
4. **Unknown state:** make the API not-ready, preserve evidence, and do not run ad-hoc DDL.

A database restore is a last resort because it rewinds all domains, not just the faulty feature.

## Scheduled drill and evidence

An automated monthly recovery drill runs via GitHub Actions (`.github/workflows/monthly-drill.yml`) on the first day of each month. The workflow:

1. Creates a signed backup with `BACKUP_SIGNING_KEY`.
2. Verifies the manifest (SHA-256 + HMAC signature).
3. Creates an isolated `vocab_drill` database.
4. Runs `db:restore:drill` with the release database gate.
5. Records evidence to the workflow summary.

On failure, the workflow exits non-zero and should trigger an alert.

For manual drills, run at least monthly:

- Select the newest retained backup.
- Restore to a fresh isolated database.
- Run the release database gate and targeted integrity queries.
- Record backup timestamp, restore start/end, manifest SHA-256, PostgreSQL versions, row-count checks, RPO achieved, and RTO achieved.
- Delete the drill database only after evidence is retained.

Alert when no verified backup exists inside the RPO window, a scheduled backup fails, checksum verification fails, or the monthly restore drill is overdue.

## Automated scheduled backup

The `backup-scheduler` Compose service uses the dedicated `backup-runtime` Docker stage and runs `scripts/run-backup-scheduler.ts`. PostgreSQL client 17.10 comes from the digest-pinned official `postgres:17.10-bookworm` build stage, matching the Compose PostgreSQL major. The build extracts only `pg_dump`, `pg_restore`, and the architecture-specific shared-library closure reported by `ldd`; it does not copy the database server or the PostgreSQL image root filesystem. The final stage is rebuilt from `scratch` using the pinned Node Bookworm runtime filesystem, so `node`, `npm`, `tsx`, and the isolated restore verifier are available without inheriting either source image's entrypoint, command, exposed port, or data volume metadata. This avoids package downloads during the application image build without disabling TLS or repository signature verification. It:

- Creates a backup every `BACKUP_INTERVAL_MS` (default: 24h).
- Requires `BACKUP_SIGNING_KEY` by default in Compose (`BACKUP_REQUIRE_SIGNING_KEY=true`) and fails closed before starting when it is absent. Local script and CI invocations remain compatible unless they explicitly enable this requirement.
- Signs the manifest with `BACKUP_SIGNING_KEY` (HMAC-SHA256).
- Exits non-zero after a failed backup cycle so the service cannot remain healthy after persistent failures.
- Locks the dump and manifest files to read-only (`chmod 400`) after verification.
- Prunes backups beyond `BACKUP_RETENTION_COUNT` (default: 14).

Configure via environment variables in `.env`:

```
BACKUP_INTERVAL_MS=86400000
BACKUP_RETENTION_COUNT=14
BACKUP_SIGNING_KEY=<strong-key>
BACKUP_REQUIRE_SIGNING_KEY=true
BACKUP_OBJECT_LOCK=true
```

## Object lock and immutability

After backup creation and verification, the dump file and manifest are set to read-only (`chmod 0o400`). This prevents accidental modification or deletion on the filesystem level. For production-grade immutability:

- Use object storage with WORM (Write Once Read Many) / object lock enabled (e.g., S3 Object Lock, GCP Bucket Hold).
- Upload the dump and manifest to immutable storage immediately after creation.
- The filesystem lock is a defense-in-depth measure; the authoritative immutability belongs to the object storage lifecycle policy.

## Manifest signing

Backups are optionally signed with HMAC-SHA256 using `BACKUP_SIGNING_KEY`. The signature:

- Covers the entire manifest content (excluding the `hmac` field itself).
- Is stored in the `hmac` field of the manifest (version 2).
- Is verified during `db:backup:verify` and `db:restore:drill` when the key is provided.
- Detects malicious modification, not just accidental corruption (SHA-256 alone only detects corruption).

Version 1 manifests (without `hmac`) are still accepted for backwards compatibility when no signing key is provided.
