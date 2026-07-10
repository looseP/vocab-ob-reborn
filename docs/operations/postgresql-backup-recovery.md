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

Run at least monthly:

- Select the newest retained backup.
- Restore to a fresh isolated database.
- Run the release database gate and targeted integrity queries.
- Record backup timestamp, restore start/end, manifest SHA-256, PostgreSQL versions, row-count checks, RPO achieved, and RTO achieved.
- Delete the drill database only after evidence is retained.

Alert when no verified backup exists inside the RPO window, a scheduled backup fails, checksum verification fails, or the monthly restore drill is overdue.
