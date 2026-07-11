# Release candidate and environment verification

## Artifact identity

A release candidate is accepted only when one manifest binds the exact Git commit, runtime and migration image IDs, npm/container SBOM digests, migration journal digest, runtime versions, and completed release gates.

CI generates `release-manifest.json` after both images and SBOMs exist, verifies it, and uploads it as an immutable workflow artifact. Production deployment must use the image digest from that manifest, never a mutable tag.

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

## Rollback contract

Database migrations are forward-only. `npm run release:rollback-check` proves the current migration journal is an append-only superset of the selected rollback application revision. It does not run destructive down migrations.

Before increasing traffic, deploy the previous application image against the migrated staging database and execute browser/API smoke. A failure means the migration is not rollback compatible and the release must use roll-forward recovery.

## Evidence retention

Retain the release manifest, both SBOMs, CI logs, database-role result, deployment smoke output, restore evidence, and rollback exercise with the same RC identifier. Rotate any credential that appears in logs or shell history.
