import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDeploymentCommands, createDryRunPlan, createEvidence, executeDeploymentCommands, readDeploymentImages, summarizeDeploymentEvidence, validateSuccessfulDeploymentEvidence, withDeploymentLock } from "../../scripts/deploy-compose-release";

const directories: string[] = [];
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const reference = (name: string, character: string) => `ghcr.io/example/${name}@${digest(character)}`;

function manifest(images: unknown): string {
  const directory = mkdtempSync(resolve(tmpdir(), "deploy-contract-"));
  directories.push(directory);
  const path = resolve(directory, "release-manifest.json");
  writeFileSync(path, JSON.stringify({ images }));
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Compose release deployment contract", () => {
  it("accepts exactly the three immutable image references", () => {
    const images = {
      runtime: { reference: reference("runtime", "a") },
      migration: { reference: reference("migration", "b") },
      backup: { reference: reference("backup", "c") },
    };
    expect(readDeploymentImages(manifest(images))).toEqual({
      runtime: images.runtime.reference,
      migration: images.migration.reference,
      backup: images.backup.reference,
    });
  });

  it.each([
    ["missing backup", { runtime: { reference: reference("runtime", "a") }, migration: { reference: reference("migration", "b") } }],
    ["tagged runtime", { runtime: { reference: "ghcr.io/example/runtime:latest" }, migration: { reference: reference("migration", "b") }, backup: { reference: reference("backup", "c") } }],
    ["shell syntax", { runtime: { reference: `${reference("runtime", "a")}; id` }, migration: { reference: reference("migration", "b") }, backup: { reference: reference("backup", "c") } }],
  ])("fails closed for %s", (_name, images) => {
    expect(() => readDeploymentImages(manifest(images))).toThrow(/immutable registry reference|exactly runtime/);
  });

  it("orders pull, isolated migration, rollout readiness, and smoke without a shell", () => {
    const commands = buildDeploymentCommands("C:/safe/deploy.env", "C:/safe/images.env");
    expect(commands.map(({ binary, args }) => [binary, ...args])).toEqual([
      ["docker", "compose", "--env-file", "C:/safe/deploy.env", "--env-file", "C:/safe/images.env", "pull", "migrate", "web", "review-outbox-worker", "llm-reservation-reaper", "backup-scheduler"],
      ["docker", "compose", "--env-file", "C:/safe/deploy.env", "--env-file", "C:/safe/images.env", "run", "--rm", "--no-deps", "--no-build", "migrate"],
      ["docker", "compose", "--env-file", "C:/safe/deploy.env", "--env-file", "C:/safe/images.env", "up", "-d", "--no-deps", "--no-build", "--wait", "web", "review-outbox-worker", "llm-reservation-reaper", "backup-scheduler"],
      [process.platform === "win32" ? "npm.cmd" : "npm", "run", "release:smoke"],
    ]);
  });

  it("stops before rollout and smoke when migration fails", () => {
    const attempted: string[] = [];
    expect(() => executeDeploymentCommands(buildDeploymentCommands("C:/safe/deploy.env", "C:/safe/images.env"), ({ phase }) => {
      attempted.push(phase);
      if (phase === "migration") throw new Error("migration failed");
    })).toThrow("migration failed");
    expect(attempted).toEqual(["pull", "migration"]);
  });

  it("rejects additional image keys", () => {
    expect(() => readDeploymentImages(manifest({
      runtime: { reference: reference("runtime", "a") },
      migration: { reference: reference("migration", "b") },
      backup: { reference: reference("backup", "c") },
      unexpected: { reference: reference("unexpected", "d") },
    }))).toThrow(/exactly runtime/);
  });

  it("rejects a concurrent deployment before commands execute", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "deploy-lock-"));
    directories.push(directory);
    const lock = resolve(directory, "production.lock");
    writeFileSync(lock, "held");
    let executed = false;
    expect(() => withDeploymentLock(lock, () => { executed = true; })).toThrow(/holds the environment lock/);
    expect(executed).toBe(false);
  });

  it("records smoke failure and stops", () => {
    const evidence: Array<[string, boolean]> = [];
    expect(() => executeDeploymentCommands(buildDeploymentCommands("C:/safe/deploy.env", "C:/safe/images.env"), ({ phase }) => {
      if (phase === "smoke") throw new Error("smoke failed");
    }, (phase, success) => evidence.push([phase, success]))).toThrow("smoke failed");
    expect(evidence).toEqual([["pull", true], ["migration", true], ["rollout", true], ["smoke", false]]);
  });

  it("creates redacted evidence with manifest digest and timestamp", () => {
    const evidence = createEvidence("production", "a".repeat(64), "smoke", true, new Date("2026-07-11T00:00:00.000Z"));
    expect(evidence).toEqual({ environment: "production", manifestSha256: "a".repeat(64), phase: "smoke", success: true, timestamp: "2026-07-11T00:00:00.000Z" });
    expect(JSON.stringify(evidence)).not.toContain("ghcr.io");
  });

  it("requires exactly four ordered successful phases", () => {
    const items = (["pull", "migration", "rollout", "smoke"] as const).map((phase) => createEvidence("staging", "c".repeat(64), phase, true));
    expect(() => validateSuccessfulDeploymentEvidence(summarizeDeploymentEvidence("staging", "c".repeat(64), items))).not.toThrow();
    expect(() => validateSuccessfulDeploymentEvidence(summarizeDeploymentEvidence("staging", "c".repeat(64), items.slice(0, 3)))).toThrow(/exactly/);
    expect(() => summarizeDeploymentEvidence("staging", "c".repeat(64), [items[0], items[0]])).toThrow(/order/);
  });

  it("redacts absolute temporary and manifest paths from dry-run", () => {
    const deployEnvFile = "D:/deploy/production.env";
    const envFile = "C:/Users/secret/AppData/Temp/images.env";
    const output = JSON.stringify(createDryRunPlan("staging", "b".repeat(64), buildDeploymentCommands(deployEnvFile, envFile), deployEnvFile, envFile));
    expect(output).toContain("<persistent-deploy-env>");
    expect(output).toContain("<generated-images-env>");
    expect(output).not.toContain("D:/deploy");
    expect(output).not.toContain("C:/Users/secret");
    expect(output).not.toContain("release-manifest.json");
  });
});
