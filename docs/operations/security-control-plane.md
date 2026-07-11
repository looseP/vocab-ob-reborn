# Security control plane

## Runtime configuration

The HTTP process parses environment variables through `src/config/runtime.ts` and fails before binding a port when required values, numeric bounds, URL schemes, or paired LLM settings are invalid. Production requires HTTPS and a metrics credential distinct from the owner credential.

Secrets remain runtime-injected. Do not bake `.env`, owner tokens, database passwords, metrics tokens, signing keys, or provider keys into images or CI artifacts.

## Runtime least privilege

Long-running application containers run as the unprivileged `node` user with:

- a read-only root filesystem;
- all Linux capabilities dropped;
- `no-new-privileges` enabled;
- only a bounded `/tmp` tmpfs writable.

The backup scheduler is the explicit exception because it must write backup artifacts. Its backup mount must be constrained to the backup destination and protected by host/object-store controls.

## Database privileges

Use separate credentials outside local development:

- **migration role**: owns schema migrations; used only by the one-shot migration job;
- **application role**: DML on application tables and execute access to approved routines; no schema creation, role management, or database ownership;
- **worker role**: DML on outbox and reservation tables; no schema creation or database ownership;
- **backup role**: read-only access required by `pg_dump`; no application writes.

Production compose services receive their dedicated role URL via `APP_DATABASE_URL`, `WORKER_DATABASE_URL`, `BACKUP_DATABASE_URL`, and `MIGRATION_DATABASE_URL`. When unset, they fall back to `DATABASE_URL` for local development convenience only.

Provisioning roles is environment-specific and belongs in infrastructure-as-code or the managed database control plane. Never let the web or worker processes use the database owner credential in production.

## Database TLS

Production must set `DB_SSLMODE` to `require` or `verify-full`. The application connection pool enables SSL based on this setting. Use `verify-full` with a mounted CA certificate for maximum security. The runtime configuration validator rejects `DB_SSLMODE=disable` in production.

## Secret rotation

See `docs/operations/secret-rotation.md` for the full secret inventory, rotation procedures, and verification steps.

## Distributed authentication limiting

Authentication attempt counters are persisted in PostgreSQL, use hashed client identifiers, and are consumed atomically. This keeps the limit effective across horizontally scaled web replicas. `TRUST_PROXY=true` is safe only behind a trusted proxy that overwrites forwarding headers.

## Supply-chain evidence

CI uses a frozen npm lockfile, audits production dependencies, creates CycloneDX SBOM evidence, verifies production images contain no development test runtime, and runs with read-only repository permissions. Retain SBOM artifacts with the matching release commit and image digest.
