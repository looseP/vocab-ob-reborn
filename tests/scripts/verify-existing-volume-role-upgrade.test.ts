import { describe, expect, it, vi } from "vitest";
import {
  allocateUpgradePort,
  authoritativeMigrationCount,
  existingVolumeCleanupInvocation,
  existingVolumeEnvironment,
  existingVolumeInvocations,
  existingVolumeProjectName,
  runExistingVolumeRoleUpgrade,
} from "../../scripts/verify-existing-volume-role-upgrade";
import type { CommandInvocation } from "../../scripts/run-database-roles-acceptance";

const UUID = "01234567-89ab-cdef-0123-456789abcdef";
const PROJECT = "vocab-observatory-existing-volume-0123456789abcdef0123456789abcdef";
const PASSWORDS = [
  "upgrade-app-password-1",
  "upgrade-worker-password-2",
  "upgrade-backup-password-3",
  "upgrade-migration-password-4",
] as const;

describe("existing local volume role upgrade", () => {
  it("derives the expected migration count from the authoritative journal", () => {
    expect(authoritativeMigrationCount()).toBe(13);
  });

  it("guards the disposable Compose project and cleanup", () => {
    expect(existingVolumeProjectName(UUID)).toBe(PROJECT);
    expect(() => existingVolumeProjectName("../../other")).toThrow(/unguarded/);
    expect(() => existingVolumeCleanupInvocation("vocab-existing-volume", {})).toThrow(/unguarded/);
  });

  it("allocates a loopback port from the required high range", async () => {
    const port = await allocateUpgradePort();
    expect(port).toBeGreaterThanOrEqual(49152);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it("inherits occupied-port retries and exhaustion from the shared allocator", async () => {
    const candidatePort = vi.fn<() => number>()
      .mockReturnValueOnce(50001)
      .mockReturnValueOnce(50002);
    const probePort = vi.fn<(port: number) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(allocateUpgradePort({ candidatePort, probePort, attempts: 2 })).resolves.toBe(50002);
    await expect(allocateUpgradePort({
      candidatePort: () => 50003,
      probePort: async () => false,
      attempts: 2,
    })).rejects.toThrow(/after 2 attempts/);
  });

  it("keeps the historical admin and creates four distinct governed URLs", () => {
    const env = existingVolumeEnvironment(61234, PASSWORDS);
    expect(new URL(env.DATABASE_ADMIN_URL!).username).toBe("vocab");
    expect([
      env.APP_DATABASE_URL,
      env.WORKER_DATABASE_URL,
      env.BACKUP_DATABASE_URL,
      env.MIGRATION_DATABASE_URL,
    ].map((value) => new URL(value!).username)).toEqual([
      "vocab_app",
      "vocab_worker",
      "vocab_backup",
      "vocab_migration",
    ]);
    expect(new Set([
      env.APP_DATABASE_URL,
      env.WORKER_DATABASE_URL,
      env.BACKUP_DATABASE_URL,
      env.MIGRATION_DATABASE_URL,
    ].map((value) => new URL(value!).password)).size).toBe(4);
  });

  it("freezes legacy migration, prepare, governed migration, converge, full role verification, and data verification order", () => {
    const env = existingVolumeEnvironment(61234, PASSWORDS);
    expect(existingVolumeInvocations(PROJECT, env).map(({ command, args }) => [command, args])).toEqual([
      ["docker", ["compose", "-f", "compose.database-roles-acceptance.yaml", "-p", PROJECT, "up", "-d", "--wait", "postgres"]],
      ["npm", ["exec", "--", "tsx", "scripts/verify-existing-volume-role-upgrade.ts", "legacy"]],
      ["npm", ["exec", "--", "tsx", "scripts/bootstrap-database-roles.ts", "prepare"]],
      ["npm", ["run", "db:migrate"]],
      ["npm", ["exec", "--", "tsx", "scripts/bootstrap-database-roles.ts", "converge"]],
      ["npm", ["run", "test:db-roles"]],
      ["npm", ["exec", "--", "tsx", "scripts/verify-existing-volume-role-upgrade.ts", "verify"]],
    ]);
    expect(existingVolumeCleanupInvocation(PROJECT, env).args).toEqual([
      "compose", "-f", "compose.database-roles-acceptance.yaml", "-p", PROJECT,
      "down", "--volumes", "--remove-orphans",
    ]);
  });

  it("cleans the guarded project after success", async () => {
    const calls: CommandInvocation[] = [];
    await runExistingVolumeRoleUpgrade({
      uuid: () => UUID,
      password: vi.fn<() => string>()
        .mockReturnValueOnce(PASSWORDS[0])
        .mockReturnValueOnce(PASSWORDS[1])
        .mockReturnValueOnce(PASSWORDS[2])
        .mockReturnValueOnce(PASSWORDS[3]),
      allocatePort: async () => 61234,
      run: async (invocation) => { calls.push(invocation); },
      onSignal: () => undefined,
      offSignal: () => undefined,
    });
    expect(calls).toHaveLength(8);
    expect(calls.at(-1)?.args).toContain("down");
  });

  it("does not report success when SIGINT arrives during cleanup", async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const calls: CommandInvocation[] = [];
    await expect(runExistingVolumeRoleUpgrade({
      uuid: () => UUID,
      password: (() => {
        let index = 0;
        return () => PASSWORDS[index++]!;
      })(),
      allocatePort: async () => 61234,
      run: async (invocation) => {
        calls.push(invocation);
        if (invocation.args.includes("down")) listeners.get("SIGINT")?.();
      },
      onSignal: (signal, listener) => { listeners.set(signal, listener); },
      offSignal: (signal) => { listeners.delete(signal); },
    })).rejects.toThrow(/interrupted by SIGINT/);
    expect(calls.at(-1)?.args).toContain("down");
    expect(listeners.size).toBe(0);
  });

  it("turns SIGTERM into a primary failure, aborts the active command, and still cleans", async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const calls: CommandInvocation[] = [];
    await expect(runExistingVolumeRoleUpgrade({
      uuid: () => UUID,
      password: (() => {
        let index = 0;
        return () => PASSWORDS[index++]!;
      })(),
      allocatePort: async () => 61234,
      run: async (invocation, signal) => {
        calls.push(invocation);
        if (calls.length === 1) {
          listeners.get("SIGTERM")?.();
          expect(signal?.aborted).toBe(true);
        }
      },
      onSignal: (signal, listener) => { listeners.set(signal, listener); },
      offSignal: (signal) => { listeners.delete(signal); },
    })).rejects.toThrow(/interrupted by SIGTERM/);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toContain("down");
    expect(listeners.size).toBe(0);
  });
});
