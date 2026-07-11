# Release candidate and environment verification

## Artifact identity

A release candidate is accepted only when the schema v2 manifest binds the exact Git commit; complete runtime, migration, and backup OCI references in `registry/repository@sha256:<64 lowercase hex>` form; npm plus runtime/migration/backup CycloneDX SBOM digests; migration journal digest; runtime versions; and completed release gates. Local Docker image IDs and mutable tags are not release identities.

CI generates `release-manifest.json` and its lowercase SHA-256 sidecar `release-manifest.sha256` after all three image digests and SBOMs exist, verifies them, and uploads them as immutable workflow evidence. `RELEASE_MANIFEST_DIGEST_PATH` may select another canonical repository-relative sidecar path; absolute, traversal, and backslash paths are rejected. Generation is fail-closed: `RUNTIME_IMAGE`, `MIGRATION_IMAGE`, and `BACKUP_IMAGE` must each be explicitly supplied as immutable OCI references. Generator logs expose only digests, not complete registry references. Local contract tests may inject syntactically valid fake digests; they do not require registry access. Production deployment must consume the exact references from that manifest.

## Database roles

Production uses separate credentials:

| Role | Allowed | Denied |
|---|---|---|
| app | application table DML, approved routines | DDL, role administration |
| worker | outbox/reservation application DML | DDL, schema destruction |
| backup | table SELECT for logical backup | all writes and DDL |
| migration | schema CREATE/ALTER/DROP during one-shot job | long-running application use |

`npm run test:db-roles` creates temporary NOLOGIN group roles in the CI database and verifies positive and negative permissions with `SET ROLE`. It never stores role passwords.

## Deployment smoke

Run after deployment:

```sh
SMOKE_BASE_URL=https://vocab.example.com \
SMOKE_METRICS_BEARER_TOKEN=... \
NODE_ENV=production \
npm run release:smoke
```

It verifies liveness, readiness, request-ID propagation, metrics fail-closed behavior, and authenticated metrics content. The token is read only from the environment and is never printed.

## Deployment runners and lock operations

The release workflow deploys on dedicated self-hosted Linux runners labelled `vocab-staging` and `vocab-production`. Each runner must execute in its corresponding target environment, have Docker Compose access to that environment, and must not be registered for untrusted pull-request workflows. GitHub Environment protection and job-level `deploy-staging` / `deploy-production` concurrency complement the host lock; production must configure required reviewers.

`npm run release:deploy` requires `RELEASE_DEPLOY_ENV_FILE` to point at a persistent, permission-controlled file on the target host containing the non-image Compose configuration (database connection, application origin, owner and metrics tokens, backup settings, and other required values). The adapter requires an absolute path to a regular file, rejects a missing file, the manifest itself, and files under the system temporary directory, and on Linux rejects any group/world permission bits (`mode & 077`). It supplies this persistent file first and a generated image-only file second, so only the three immutable manifest image references override host configuration; dry-run output redacts both paths.

`npm run release:deploy` also requires the environment variable `RELEASE_DEPLOY_LOCK_FILE`. Set the GitHub Environment variable of that name to an absolute file path in a shared, persistent directory visible to every deployment runner for that environment; a runner-local temporary directory does not provide mutual exclusion. Staging and production must use different lock paths so one environment cannot block or release the other environment's deployment.

The adapter creates the lock atomically and holds it across image pull, the one-shot migration, readiness-gated rollout, and smoke verification. Lock contention fails closed before migration. The adapter never automatically treats an existing lock as stale because process age alone cannot prove that a remote deployment is inactive.

If a deployment process crashes, its lock file can remain. Remove it manually only after confirming through the deployment system and target host process list that no deployment using that environment is running. Record the incident and the operator performing the removal, then delete only that environment's configured `RELEASE_DEPLOY_LOCK_FILE`; never use a wildcard, recursive cleanup, age-based job, or automatic stale-lock deletion.

## Rollback contract

Database migrations are forward-only. `npm run release:rollback-check` proves the current migration journal is an append-only superset of the selected rollback application revision. It does not run destructive down migrations.

Before increasing traffic, deploy the previous application image against the migrated staging database and execute browser/API smoke. A failure means the migration is not rollback compatible and the release must use roll-forward recovery.

## Evidence retention

Retain the release manifest, both SBOMs, CI logs, database-role result, deployment smoke output, restore evidence, and rollback exercise with the same RC identifier. Rotate any credential that appears in logs or shell history.
