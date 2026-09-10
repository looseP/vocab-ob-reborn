import { describe, expect, it } from "vitest";
import {
  MIN_COLLECTED_TEST_FILES,
  auditCollection,
  collectTestFiles,
  listDiskTestFiles,
} from "../../scripts/verify-test-collection";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/(.:)/, "$1");

describe("test collection gate", () => {
  it("pins a floor equal to the suite size when the gate landed", () => {
    expect(MIN_COLLECTED_TEST_FILES).toBe(140);
  });

  it("collects every on-disk unit test file via vitest itself (real repo parity)", () => {
    const collected = collectTestFiles(root);
    const disk = listDiskTestFiles(root);
    expect(collected.length).toBeGreaterThanOrEqual(MIN_COLLECTED_TEST_FILES);
    // If vitest's include/exclude ever silently drops an on-disk file, this
    // parity assertion turns red — the exact "worker 静默漏跑" failure mode.
    expect(collected).toEqual(disk);
  });

  it("flags missing and extra files in the audit diff", () => {
    const audit = auditCollection(
      ["tests/a.test.ts", "tests/ghost.test.ts"],
      ["tests/a.test.ts", "tests/b.test.ts"],
    );
    expect(audit.missing).toEqual(["tests/b.test.ts"]);
    expect(audit.extra).toEqual(["tests/ghost.test.ts"]);
  });

  it("ignores integration tests and node_modules when walking the disk", () => {
    const disk = listDiskTestFiles(root);
    expect(disk.some((file) => file.endsWith(".integration.test.ts"))).toBe(false);
    expect(disk.every((file) => file.startsWith("tests/"))).toBe(true);
    expect(disk).toEqual([...disk].sort());
  });
});
