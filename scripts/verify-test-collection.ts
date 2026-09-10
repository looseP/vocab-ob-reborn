/**
 * Unit-test collection integrity gate.
 *
 * Guards against "silent under-collection": a vitest config change, a broken
 * glob, or a worker failure that makes the suite quietly run fewer test files
 * than exist on disk. CI (Engineering Gate → npm run test:unit) fails when:
 *
 *   1. vitest collects fewer files than the pinned floor (MIN_COLLECTED_TEST_FILES), or
 *   2. vitest's collected set misses any non-integration unit test file on disk.
 *
 * The floor is a snapshot of the suite size when this gate landed (140 files);
 * raise it as the suite grows, never lower it. The parity check (2) is the
 * primary guard and self-adjusts as files are added or removed.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MIN_COLLECTED_TEST_FILES = 140;

export type CollectionAudit = {
  collected: string[];
  disk: string[];
  /** Disk files vitest did NOT collect — the silent-skip failure mode. */
  missing: string[];
  /** Collected entries that no longer exist on disk (stale vitest output). */
  extra: string[];
};

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** Recursively list unit test files on disk, mirroring vitest's include/exclude. */
export function listDiskTestFiles(root = process.cwd()): string[] {
  const base = root.replace(/[\\/]+$/, "");
  const filesRoot = join(base, "tests");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (
        (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) &&
        !entry.name.endsWith(".integration.test.ts")
      ) {
        out.push(toPosix(full.slice(base.length + 1)));
      }
    }
  };
  walk(filesRoot);
  return out.sort();
}

/** Ask vitest itself what it would collect (authoritative, no tests run). */
export function collectTestFiles(root = process.cwd()): string[] {
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules", "vitest", "vitest.mjs"), "list", "--filesOnly"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`vitest list --filesOnly failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => toPosix(line.trim()))
    .filter((line) => line.length > 0)
    .sort();
}

export function auditCollection(collected: string[], disk: string[]): CollectionAudit {
  const collectedSet = new Set(collected);
  const diskSet = new Set(disk);
  return {
    collected,
    disk,
    missing: disk.filter((file) => !collectedSet.has(file)),
    extra: collected.filter((file) => !diskSet.has(file)),
  };
}

export function verifyTestCollection(root = process.cwd()): string[] {
  const failures: string[] = [];
  const audit = auditCollection(collectTestFiles(root), listDiskTestFiles(root));

  if (audit.collected.length < MIN_COLLECTED_TEST_FILES) {
    failures.push(
      `collected ${audit.collected.length} test files < floor ${MIN_COLLECTED_TEST_FILES} — ` +
        "the suite silently shrank; check vitest include/exclude and worker health",
    );
  }
  if (audit.missing.length > 0) {
    failures.push(
      `vitest did not collect ${audit.missing.length} on-disk test file(s): ` +
        audit.missing.join(", "),
    );
  }
  if (audit.extra.length > 0) {
    failures.push(
      `vitest collected ${audit.extra.length} file(s) that no longer exist on disk: ` +
        audit.extra.join(", "),
    );
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const failures = verifyTestCollection();
    if (failures.length > 0) {
      console.error(`Test collection gate failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    } else {
      const audit = auditCollection(collectTestFiles(), listDiskTestFiles());
      console.log(`Test collection gate passed: ${audit.collected.length} files collected, ${audit.disk.length} on disk, 0 missing.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}
