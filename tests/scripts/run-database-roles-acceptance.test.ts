import { describe, expect, it, vi } from "vitest";
import {
  acceptanceEnvironment,
  acceptanceInvocations,
  acceptanceProjectName,
  cleanupInvocation,
  runDatabaseRolesAcceptance,
  throwOrchestrationErrors,
  type CommandInvocation,
} from "../../scripts/run-database-roles-acceptance";

const UUID = "01234567-89ab-cdef-0123-456789abcdef";
const PROJECT = "vocab-observatory-db-roles-0123456789abcdef0123456789abcdef";
const PASSWORDS = [
  "admin-password-0001",
  "app-password-000002",
  "worker-password-003",
  "backup-password-004",
  "migration-password-5",
] as const;

describe("database roles acceptance orchestration", () => {
  it("guards random project names", () => {
    expect(acceptanceProjectName(UUID)).toBe(PROJECT);
    expect(() => acceptanceProjectName("../../other-project")).toThrow(/unguarded Compose project/);
    expect(() => cleanupInvocation("vocab-observatory-database-roles-acceptance", {})).toThrow(/unguarded Compose project/);
  });

  it("routes five exact identities through one dynamic high loopback port with distinct passwords", () => {
    const env = acceptanceEnvironment(61234, PASSWORDS);
    const expected = {
      DATABASE_ADMIN_URL: "vocab_roles_admin",
      APP_DATABASE_URL: "vocab_app",
      WORKER_DATABASE_URL: "vocab_worker",
      BACKUP_DATABASE_URL: "vocab_backup",
      MIGRATION_DATABASE_URL: "vocab_migration",
    } as const;
    expect(env.DATABASE_ROLES_ACCEPTANCE_PORT).toBe("61234");
    for (const [name, username] of Object.entries(expected)) {
      const url = new URL(env[name]!);
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.port).toBe("61234");
      expect(url.pathname).toBe("/vocab_roles_acceptance");
      expect(url.username).toBe(username);
    }
    expect(new Set(Object.keys(expected).map((name) => new URL(env[name]!).password)).size).toBe(5);
    expect(() => acceptanceEnvironment(49151, PASSWORDS)).toThrow(/dynamic high port/);
    expect(() => acceptanceEnvironment(61234, [...PASSWORDS.slice(0, 4), PASSWORDS[0]!])).toThrow(/five distinct/);
  });

  it("freezes the required command arguments and strict execution order", () => {
    const env = acceptanceEnvironment(61234, PASSWORDS);
    const invocations = acceptanceInvocations(PROJECT, env);
    expect(invocations.map(({ command, args }) => [command, args])).toEqual([
      ["docker", ["compose", "-f", "compose.database-roles-acceptance.yaml", "-p", PROJECT, "up", "-d", "--wait", "postgres"]],
      ["npm", ["exec", "--", "tsx", "scripts/bootstrap-database-roles.ts", "prepare"]],
      ["npm", ["run", "db:migrate"]],
      ["npm", ["exec", "--", "tsx", "scripts/bootstrap-database-roles.ts", "converge"]],
      ["npm", ["exec", "--", "tsx", "scripts/verify-database-roles.ts"]],
      ["npm", ["exec", "--", "tsx", "scripts/verify-backup-rls-acceptance.ts"]],
    ]);
    expect(invocations[2]?.env.DATABASE_URL).toBe(env.MIGRATION_DATABASE_URL);
    expect(cleanupInvocation(PROJECT, env).args).toEqual([
      "compose", "-f", "compose.database-roles-acceptance.yaml", "-p", PROJECT,
      "down", "--volumes", "--remove-orphans",
    ]);
  });

  it("always cleans only its guarded project and returns success after cleanup", async () => {
    const calls: CommandInvocation[] = [];
    const result = await runDatabaseRolesAcceptance({
      uuid: () => UUID,
      password: vi.fn<() => string>()
        .mockReturnValueOnce(PASSWORDS[0])
        .mockReturnValueOnce(PASSWORDS[1])
        .mockReturnValueOnce(PASSWORDS[2])
        .mockReturnValueOnce(PASSWORDS[3])
        .mockReturnValueOnce(PASSWORDS[4]),
      allocatePort: async () => 61234,
      run: async (invocation) => { calls.push(invocation); },
      onSignal: () => undefined,
      offSignal: () => undefined,
    });
    expect(calls).toHaveLength(7);
    expect(calls.at(-1)?.args).toEqual([
      "compose", "-f", "compose.database-roles-acceptance.yaml", "-p", PROJECT,
      "down", "--volumes", "--remove-orphans",
    ]);
    expect(result).toMatchObject({ ok: true, project: PROJECT, port: 61234, cleanupCompleted: true });
  });

  it("cleans after primary failure and preserves both primary and cleanup errors", async () => {
    const primary = new Error("docker unavailable");
    const cleanup = new Error("cleanup unavailable");
    const calls: CommandInvocation[] = [];
    await expect(runDatabaseRolesAcceptance({
      uuid: () => UUID,
      password: (() => {
        let index = 0;
        return () => PASSWORDS[index++]!;
      })(),
      allocatePort: async () => 61234,
      run: async (invocation) => {
        calls.push(invocation);
        if (calls.length === 1) throw primary;
        throw cleanup;
      },
      onSignal: () => undefined,
      offSignal: () => undefined,
    })).rejects.toMatchObject({
      name: "AggregateError",
      errors: [primary, cleanup],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toContain("down");
  });

  it("turns a signal into a primary failure and still enters cleanup", async () => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const calls: CommandInvocation[] = [];
    await expect(runDatabaseRolesAcceptance({
      uuid: () => UUID,
      password: (() => {
        let index = 0;
        return () => PASSWORDS[index++]!;
      })(),
      allocatePort: async () => 61234,
      run: async (invocation, signal) => {
        calls.push(invocation);
        if (calls.length === 1) {
          listeners.get("SIGINT")?.();
          expect(signal?.aborted).toBe(true);
        }
      },
      onSignal: (signal, listener) => { listeners.set(signal, listener); },
      offSignal: (signal) => { listeners.delete(signal); },
    })).rejects.toThrow(/interrupted by SIGINT/);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toContain("down");
    expect(listeners.size).toBe(0);
  });

  it("does not swallow a cleanup-only failure", () => {
    const cleanup = new Error("cleanup failed");
    expect(() => throwOrchestrationErrors(undefined, cleanup)).toThrow(cleanup);
  });
});
