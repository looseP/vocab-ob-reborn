# Production release acceptance

Production promotion is fail-closed and split into two workflows. `release.yml` only verifies and publishes the immutable prepare artifact; it never stages or deploys. `promote-release.yml` requires a positive same-repository `prepare_run_id`, downloads that fixed release artifact, then performs staging, acceptance, and production. The hosted `production-acceptance` job downloads the exact release artifact and staging evidence, verifies the manifest digest sidecar, and binds all evidence to the release Git SHA and manifest SHA-256. Production cannot run unless this job succeeds and the protected `production` GitHub Environment reviewers approve.

## Go / No-Go

A `GO` requires the staging deployment evidence to contain exactly the ordered successful phases `pull`, `migration`, `rollout`, and `smoke`, plus `passed` results for migration rehearsal, database-role verification, a real backup/restore drill, rollback compatibility, a real alerting drill, and smoke. Missing, failed, unknown, duplicated, reordered, or identity-mismatched evidence is `NO_GO`.

A bare `passed` string or declared digest is insufficient. Each real rehearsal workflow must upload exactly one fixed same-repository artifact named `release-check-migration-rehearsal`, `release-check-database-roles`, `release-check-backup-restore`, `release-check-rollback-compatibility`, or `release-check-alerting-drill`, containing `evidence.json` built by `npm run release:check:evidence`. The artifact v1 has exactly `schemaVersion,check,status,producer,releaseSha,manifestSha256,observedAt`; producer is canonical per check and no secret, URL, database identifier, or path is permitted.

`workflow_dispatch` supplies five positive source run IDs. Tag releases read the corresponding protected production variables `<CHECK>_RUN_ID`; a missing or invalid variable fails closed as `NO_GO`. Downloads are pinned to `${{ github.repository }}`, the fixed artifact names, and GitHub's token—repository, artifact name, URL, and path are never operator inputs. The verifier reads and hashes the downloaded JSON bytes, compares the digest to the declaration, parses the exact schema, binds check/producer/current release SHA/manifest SHA, and enforces 30-day freshness. An old or altered source run therefore fails. Smoke remains derived from and re-hashed against staging deployment evidence bytes. Backup restore and alerting artifacts must come from workflows that truly ran those drills; this repository does not pretend that the release workflow itself performs them.

## Evidence and retention

The release manifest and digest originate in `publish`; structured staging evidence originates in the deployment adapter and contains no image references, secrets, or environment-file paths. The final acceptance record contains only release identity and the decision. Artifacts are retained for 90 days.

## Rollback conditions

Stop promotion or roll back application traffic when smoke, readiness, alerting, restore evidence, role isolation, or rollback compatibility fails. Database migrations remain forward-only; if the previous application is incompatible with the migrated schema, use roll-forward recovery rather than destructive down migration.
