import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  expectedJournalTail,
  journalTailProblems,
  readReleaseJournalTail,
} from "../../scripts/run-rls-acceptance-migrations";

const JOURNAL = {
  version: "7",
  dialect: "postgresql",
  entries: [
    { idx: 0, when: 1000, tag: "0000_baseline" },
    { idx: 1, when: 2000, tag: "0001_routines" },
    { idx: 2, when: 3000, tag: "0002_session_scope" },
  ],
};

describe("expectedJournalTail", () => {
  it("returns the entry count and the highest when", () => {
    expect(expectedJournalTail(JOURNAL)).toEqual({ entryCount: 3, maxWhen: 3000 });
  });

  it("finds the max when even when entries are not sorted", () => {
    expect(expectedJournalTail({ entries: [{ when: 5000 }, { when: 1000 }] }))
      .toEqual({ entryCount: 2, maxWhen: 5000 });
  });

  it("rejects a journal without entries", () => {
    expect(() => expectedJournalTail({})).toThrow(/no entries array/);
    expect(() => expectedJournalTail({ entries: [] })).toThrow(/no entries array/);
    expect(() => expectedJournalTail(null)).toThrow(/no entries array/);
  });

  it("rejects a non-finite when", () => {
    expect(() => expectedJournalTail({ entries: [{ when: "3000" }] })).toThrow(/no finite when/);
    expect(() => expectedJournalTail({ entries: [{ when: Number.NaN }] })).toThrow(/no finite when/);
  });

  it("reads the committed journal and agrees with the raw file", () => {
    const tail = readReleaseJournalTail();
    // Floors, not equality: the chain grows, and the assertion that matters is
    // that the parse path agrees with the raw journal.
    expect(tail.entryCount).toBeGreaterThanOrEqual(51);
    expect(tail.maxWhen).toBeGreaterThanOrEqual(1791259673129);

    const raw = JSON.parse(
      readFileSync(resolve("drizzle-release", "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ when: number }> };
    expect(tail.entryCount).toBe(raw.entries.length);
    expect(tail.maxWhen).toBe(Math.max(...raw.entries.map((entry) => entry.when)));
  });
});

describe("journalTailProblems", () => {
  const tail = { entryCount: 3, maxWhen: 3000 };

  it("accepts a ledger that reached the chain's terminal state", () => {
    expect(journalTailProblems(tail, { migrationCount: 3, maxCreatedAt: 3000 })).toEqual([]);
  });

  it("flags a ledger that silently skipped the tail (tied-when regression)", () => {
    const problems = journalTailProblems(tail, { migrationCount: 2, maxCreatedAt: 2000 });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/ledger has 2 rows but the journal declares 3 entries/);
    expect(problems[1]).toMatch(/max\(created_at\) is 2000 but the journal's last when is 3000/);
  });

  it("flags a ledger whose max lags even when the count matches", () => {
    // The 0047–0049 incident shape: rows exist, but a tied/older max means the
    // migrator replays the tail instead of skipping it.
    const problems = journalTailProblems(tail, { migrationCount: 3, maxCreatedAt: 2000 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/max\(created_at\) is 2000/);
  });

  it("flags an empty ledger as null, not as zero", () => {
    const problems = journalTailProblems(tail, { migrationCount: 0, maxCreatedAt: null });
    expect(problems).toHaveLength(2);
    expect(problems[1]).toMatch(/max\(created_at\) is null/);
  });

  it("flags a ledger with rows the journal does not declare", () => {
    const problems = journalTailProblems(tail, { migrationCount: 4, maxCreatedAt: 3000 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/ledger has 4 rows/);
  });
});
