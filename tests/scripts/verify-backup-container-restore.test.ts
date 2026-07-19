import { describe, expect, it } from "vitest";
import {
  buildBackupContainerRestoreArguments,
  containerRestoreEnvironment,
  hostVerificationEnvironment,
  resolveBackupContainerDrillConfiguration,
} from "../../scripts/verify-backup-container-restore";

const environment = {
  DATABASE_ADMIN_URL: "postgresql://vocab_ci_admin:AdminPassword_123456@localhost:5432/vocab",
  BACKUP_DATABASE_URL: "postgresql://vocab_backup:BackupPassword_1234@localhost:5432/vocab",
  MIGRATION_DATABASE_URL: "postgresql://vocab_migration:MigrationPassword_123@localhost:5432/vocab",
};

describe("backup container restore acceptance", () => {
  it("derives an isolated drill database with separate restore and verification identities", () => {
    expect(resolveBackupContainerDrillConfiguration(environment)).toEqual({
      databaseName: "vocab_backup_drill",
      sourceUrl: "postgresql://vocab_backup:BackupPassword_1234@host.docker.internal:5432/vocab",
      restoreUrl: "postgresql://vocab_migration:MigrationPassword_123@host.docker.internal:5432/vocab_backup_drill",
      verificationUrl: "postgresql://vocab_ci_admin:AdminPassword_123456@localhost:5432/vocab_backup_drill",
      destructiveConfirmation: "host.docker.internal:5432/vocab_backup_drill",
    });
  });

  it("rejects role and database identity drift", () => {
    expect(() => resolveBackupContainerDrillConfiguration({
      ...environment,
      BACKUP_DATABASE_URL: "postgresql://vocab_app:BackupPassword_1234@localhost:5432/vocab",
    })).toThrow(/must use vocab_backup/);
    expect(() => resolveBackupContainerDrillConfiguration({
      ...environment,
      MIGRATION_DATABASE_URL: "postgresql://vocab_migration:MigrationPassword_123@localhost:5432/other",
    })).toThrow(/same PostgreSQL endpoint/);
    expect(() => resolveBackupContainerDrillConfiguration({
      ...environment,
      BACKUP_DATABASE_URL: "postgresql://vocab_backup:BackupPassword_1234@other-db:5432/vocab",
    })).toThrow(/same PostgreSQL endpoint/);
    expect(() => resolveBackupContainerDrillConfiguration({
      ...environment,
      DATABASE_ADMIN_URL: "postgresql://vocab_migration:AdminPassword_123456@localhost:5432/vocab",
    })).toThrow(/distinct verification identity/);
    expect(() => resolveBackupContainerDrillConfiguration({
      DATABASE_ADMIN_URL: "postgresql://vocab_ci_admin:AdminPassword_123456@remote-db:5432/vocab",
      BACKUP_DATABASE_URL: "postgresql://vocab_backup:BackupPassword_1234@remote-db:5432/vocab",
      MIGRATION_DATABASE_URL: "postgresql://vocab_migration:MigrationPassword_123@remote-db:5432/vocab",
    })).toThrow(/requires a loopback PostgreSQL endpoint/);
  });

  it("runs the built backup image as a hardened non-root restore environment", () => {
    const args = buildBackupContainerRestoreArguments("backup:test");
    expect(args).toEqual(expect.arrayContaining([
      "--add-host", "host.docker.internal:host-gateway",
      "--read-only",
      "--security-opt", "no-new-privileges:true",
      "--cap-drop", "ALL",
      "--tmpfs", "/backups:rw,noexec,nosuid,size=128m,uid=1000,gid=1000,mode=0700",
      "--entrypoint", "/bin/sh",
      "backup:test",
    ]));
    const script = args.at(-1) ?? "";
    expect(script).toContain("postgres-backup.ts create");
    expect(script).toContain("postgres-backup.ts verify");
    expect(script).toContain("postgres-backup.ts restore-only");
    expect(script).not.toContain("postgres-backup.ts restore-drill");
    expect(script).toContain('test "$#" -eq 1');
    expect(args.join(" ")).not.toContain("DATABASE_ADMIN_URL");
    expect(args.join(" ")).not.toContain("DRILL_TEST_DATABASE_URL");
  });

  it("isolates container and host verification credentials from the parent environment", () => {
    const configuration = resolveBackupContainerDrillConfiguration(environment);
    const parent = {
      ...environment,
      PATH: "C:/tools",
      UNRELATED_SECRET: "must-not-propagate",
    };
    const container = containerRestoreEnvironment(parent, configuration, "SigningKey_12345678901234567890");
    expect(container).toMatchObject({
      PATH: "C:/tools",
      DATABASE_URL: configuration.sourceUrl,
      DRILL_DATABASE_URL: configuration.restoreUrl,
      ALLOW_DESTRUCTIVE_RESTORE: configuration.destructiveConfirmation,
      BACKUP_SIGNING_KEY: "SigningKey_12345678901234567890",
    });
    expect(container).not.toHaveProperty("DATABASE_ADMIN_URL");
    expect(container).not.toHaveProperty("BACKUP_DATABASE_URL");
    expect(container).not.toHaveProperty("MIGRATION_DATABASE_URL");
    expect(container).not.toHaveProperty("UNRELATED_SECRET");

    const verification = hostVerificationEnvironment(parent, configuration.verificationUrl);
    expect(verification).toMatchObject({
      PATH: "C:/tools",
      DATABASE_URL: configuration.verificationUrl,
      TEST_DATABASE_URL: configuration.verificationUrl,
    });
    expect(verification).not.toHaveProperty("BACKUP_DATABASE_URL");
    expect(verification).not.toHaveProperty("MIGRATION_DATABASE_URL");
    expect(verification).not.toHaveProperty("UNRELATED_SECRET");
  });
});
