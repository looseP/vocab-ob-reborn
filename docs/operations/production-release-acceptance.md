# Production release acceptance

Production promotion is fail-closed. The hosted `production-acceptance` job downloads the exact release artifact and staging evidence, verifies the manifest digest sidecar, and binds all evidence to the release Git SHA and manifest SHA-256. Production cannot run unless this job succeeds and the protected `production` GitHub Environment reviewers approve.

## Go / No-Go

A `GO` requires the staging deployment evidence to contain exactly the ordered successful phases `pull`, `migration`, `rollout`, and `smoke`, plus `passed` results for migration rehearsal, database-role verification, a real backup/restore drill, rollback compatibility, a real alerting drill, and smoke. Missing, failed, unknown, duplicated, reordered, or identity-mismatched evidence is `NO_GO`.

The workflow-dispatch status inputs and corresponding protected Environment variables are attestations to independently executed checks. A bare `passed` string is insufficient: every check must carry an allowlisted source, UTC observation timestamp, and SHA-256 digest of its retained source evidence. External checks use `github-environment`; smoke is derived from and cryptographically bound to the staging deployment evidence. Configure `<CHECK>_OBSERVED_AT` and `<CHECK>_EVIDENCE_SHA256` protected variables for every external check. Never mark backup restore or alerting as passed without executing them against the appropriate isolated infrastructure and retaining the evidence whose digest is supplied. The verifier does not fabricate or infer those results.

## Evidence and retention

The release manifest and digest originate in `publish`; structured staging evidence originates in the deployment adapter and contains no image references, secrets, or environment-file paths. The final acceptance record contains only release identity and the decision. Artifacts are retained for 90 days.

## Rollback conditions

Stop promotion or roll back application traffic when smoke, readiness, alerting, restore evidence, role isolation, or rollback compatibility fails. Database migrations remain forward-only; if the previous application is incompatible with the migrated schema, use roll-forward recovery rather than destructive down migration.
