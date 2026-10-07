import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildAdoptStatements,
  computeLedgerDiff,
  formatReport,
  parseAdoptArgs,
  readJournal,
  resolveAdoptTarget,
  runAdopt,
  sha256File,
  type AppliedLedgerRow,
  type MigrationJournal,
} from "../../scripts/reconcile-migration-ledger";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const JOURNAL: MigrationJournal = {
  entries: [
    { idx: 47, tag: "0047_first", when: 1000 },
    { idx: 48, tag: "0048_second", when: 2000 },
    { idx: 49, tag: "0049_third", when: 3000 },
  ],
};

const HASHES: Record<string, string> = {
  "0047_first": HASH_A,
  "0048_second": HASH_B,
  "0049_third": HASH_C,
};

function resolveHash(tag: string): string {
  return HASHES[tag];
}

describe("computeLedgerDiff", () => {
  it("classifies exact, different, and missing entries", () => {
    const rows: AppliedLedgerRow[] = [
      { hash: HASH_A, created_at: "1000" }, // exact
      { hash: HASH_B, created_at: "1500" }, // different when
      // HASH_C absent → missing
    ];
    const diff = computeLedgerDiff(JOURNAL, rows, resolveHash);

    expect(diff.entries.map((entry) => entry.status)).toEqual([
      "applied-exact",
      "applied-different",
      "missing",
    ]);
    expect(diff.entries[1].ledgerWhen).toBe(1500);
    expect(diff.missing.map((entry) => entry.tag)).toEqual(["0049_third"]);
  });

  it("matches by hash, not by created_at (tied-when incident)", () => {
    // Three rows sharing one created_at but carrying different file hashes:
    // created_at alone cannot identify a file.
    const rows: AppliedLedgerRow[] = [
      { hash: HASH_A, created_at: "1000" },
      { hash: HASH_B, created_at: "1000" },
      { hash: HASH_C, created_at: "1000" },
    ];
    const diff = computeLedgerDiff(JOURNAL, rows, resolveHash);
    expect(diff.entries.map((entry) => entry.status)).toEqual([
      "applied-exact",
      "applied-different",
      "applied-different",
    ]);
    expect(diff.missing).toHaveLength(0);
  });

  it("prefers an exact-when row over a duplicate hash at another when", () => {
    const rows: AppliedLedgerRow[] = [
      { hash: HASH_A, created_at: "999" },
      { hash: HASH_A, created_at: "1000" },
    ];
    const diff = computeLedgerDiff(JOURNAL, rows, resolveHash);
    expect(diff.entries[0].status).toBe("applied-exact");
    expect(diff.entries[0].ledgerWhen).toBe(1000);
  });

  it("reports an empty ledger as all-missing with a null max", () => {
    const diff = computeLedgerDiff(JOURNAL, [], resolveHash);
    expect(diff.missing).toHaveLength(3);
    expect(diff.maxLedgerCreatedAt).toBeNull();
    expect(diff.maxJournalWhen).toBe(3000);
  });

  it("computes the ledger max from applied rows", () => {
    const diff = computeLedgerDiff(
      JOURNAL,
      [{ hash: HASH_A, created_at: "1000" }, { hash: HASH_C, created_at: 3000 }],
      resolveHash,
    );
    expect(diff.maxLedgerCreatedAt).toBe(3000);
  });
});

describe("resolveAdoptTarget", () => {
  it("resolves a journal tag", () => {
    expect(resolveAdoptTarget(JOURNAL, "0048_second")).toBe(1);
  });

  it("resolves a bare idx and a zero-padded idx", () => {
    expect(resolveAdoptTarget(JOURNAL, "49")).toBe(2);
    expect(resolveAdoptTarget(JOURNAL, "0049")).toBe(2);
  });

  it("rejects an unknown target", () => {
    expect(() => resolveAdoptTarget(JOURNAL, "0051_nope")).toThrow(/unknown migration target/);
    expect(() => resolveAdoptTarget(JOURNAL, "99")).toThrow(/unknown migration target/);
  });
});

describe("buildAdoptStatements", () => {
  it("filters to missing entries at or before the target", () => {
    const diff = computeLedgerDiff(JOURNAL, [], resolveHash);

    expect(buildAdoptStatements(diff, "0048_second").map((statement) => statement.tag))
      .toEqual(["0047_first", "0048_second"]);
    expect(buildAdoptStatements(diff, "0049_third").map((statement) => statement.tag))
      .toEqual(["0047_first", "0048_second", "0049_third"]);
  });

  it("skips entries already applied at or before the target", () => {
    const diff = computeLedgerDiff(
      JOURNAL,
      [{ hash: HASH_A, created_at: "1000" }],
      resolveHash,
    );
    expect(buildAdoptStatements(diff, "0049_third").map((statement) => statement.tag))
      .toEqual(["0048_second", "0049_third"]);
  });

  it("does not adopt entries after the target", () => {
    const diff = computeLedgerDiff(JOURNAL, [], resolveHash);
    expect(buildAdoptStatements(diff, "0047_first").map((statement) => statement.tag))
      .toEqual(["0047_first"]);
  });

  it("carries the WHERE NOT EXISTS guard and the exact hash/when pair", () => {
    const diff = computeLedgerDiff(JOURNAL, [], resolveHash);
    const [statement] = buildAdoptStatements(diff, "0047_first");

    expect(statement.sql).toContain("WHERE NOT EXISTS (");
    expect(statement.sql).toContain("SELECT 1 FROM vocab_migrations.__v2_release_migrations");
    expect(statement.sql).toContain(`SELECT '${statement.hash}', ${statement.when}`);
  });

  it("守卫按 hash 判身份：tied-when 的缺失条目仍会被写入（不再被无关行的 when 吞掉）", () => {
    // 复刻真实账本残留（0046/0047/0048 共享 created_at = 1790405138087）：
    // 旧守卫 `WHERE created_at = 1000` 会命中 0046 那一行 ⇒ 0047 的 INSERT 写 0 行，
    // 命令却报成功，账本继续缺行、迁移器继续跳过该条。
    const tied: MigrationJournal = {
      entries: [
        { idx: 46, tag: "0046_tied", when: 1000 },
        { idx: 47, tag: "0047_tied", when: 1000 },
      ],
    };
    const hashes: Record<string, string> = { "0046_tied": HASH_A, "0047_tied": HASH_B };
    const diff = computeLedgerDiff(
      tied,
      [{ hash: HASH_A, created_at: "1000" }], // 0046 已入账，且占用 when=1000
      (tag) => hashes[tag],
    );
    expect(diff.missing.map((entry) => entry.tag)).toEqual(["0047_tied"]);

    const [statement] = buildAdoptStatements(diff, "0047_tied");
    expect(statement.hash).toBe(HASH_B);
    expect(statement.when).toBe(1000);
    expect(statement.sql).not.toMatch(/WHERE created_at =/);
    expect(statement.sql).toContain(`WHERE hash = '${HASH_B}'`);
  });

  it("returns nothing when every target entry is already applied", () => {
    const diff = computeLedgerDiff(
      JOURNAL,
      [
        { hash: HASH_A, created_at: "1000" },
        { hash: HASH_B, created_at: "2000" },
        { hash: HASH_C, created_at: "3000" },
      ],
      resolveHash,
    );
    expect(buildAdoptStatements(diff, "0049_third")).toEqual([]);
  });
});

describe("runAdopt", () => {
  const diff = () => computeLedgerDiff(JOURNAL, [], resolveHash);

  it("dry-run prints statements without executing them", async () => {
    const execute = vi.fn<(sql: string) => Promise<void>>().mockResolvedValue(undefined);
    const log = vi.fn<(line: string) => void>();

    const statements = await runAdopt(diff(), "0048_second", { write: false, execute, log });

    expect(statements).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([line]) => line).filter((line) => line.startsWith("[dry-run]"))).toHaveLength(2);
  });

  it("--write executes every generated statement once", async () => {
    const executed: string[] = [];
    const execute = vi.fn<(sql: string) => Promise<void>>(async (sql) => {
      executed.push(sql);
    });
    const log = vi.fn<(line: string) => void>();

    await runAdopt(diff(), "0049_third", { write: true, execute, log });

    expect(execute).toHaveBeenCalledTimes(3);
    expect(executed.every((sql) => sql.includes("WHERE NOT EXISTS ("))).toBe(true);
    expect(log.mock.calls.map(([line]) => line).filter((line) => line.startsWith("[adopt]"))).toHaveLength(3);
  });

  it("reports a no-op when the target has nothing missing", async () => {
    const complete = computeLedgerDiff(
      JOURNAL,
      [
        { hash: HASH_A, created_at: "1000" },
        { hash: HASH_B, created_at: "2000" },
      ],
      resolveHash,
    );
    const execute = vi.fn<(sql: string) => Promise<void>>().mockResolvedValue(undefined);
    const log = vi.fn<(line: string) => void>();

    await runAdopt(complete, "0048_second", { write: true, execute, log });

    expect(execute).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "nothing to adopt: every entry at or before the target is already in the ledger",
    );
  });

  it("写入后复核：missing 未按语句数下降 → 抛错（不再静默成功）", async () => {
    const execute = vi.fn<(sql: string) => Promise<void>>().mockResolvedValue(undefined);
    const log = vi.fn<(line: string) => void>();
    // 3 个 missing、目标内 2 条语句 → 期望剩 1；返回 2 说明有一条没真正写进去。
    const recheckMissing = vi.fn(async () => 2);

    await expect(
      runAdopt(diff(), "0048_second", { write: true, execute, log, recheckMissing }),
    ).rejects.toThrow(/a row was not written/);
    expect(recheckMissing).toHaveBeenCalledTimes(1);
  });

  it("写入后复核通过：missing 恰按语句数下降", async () => {
    const execute = vi.fn<(sql: string) => Promise<void>>().mockResolvedValue(undefined);
    const log = vi.fn<(line: string) => void>();
    const recheckMissing = vi.fn(async () => 1); // 3 − 2 条语句

    await runAdopt(diff(), "0048_second", { write: true, execute, log, recheckMissing });

    expect(recheckMissing).toHaveBeenCalledTimes(1);
  });

  it("dry-run 不复核（没写库就不该断言账本变了）", async () => {
    const execute = vi.fn<(sql: string) => Promise<void>>().mockResolvedValue(undefined);
    const log = vi.fn<(line: string) => void>();
    const recheckMissing = vi.fn(async () => 3);

    await runAdopt(diff(), "0048_second", { write: false, execute, log, recheckMissing });

    expect(recheckMissing).not.toHaveBeenCalled();
  });
});

describe("parseAdoptArgs", () => {
  it("accepts --to <target> with and without --write", () => {
    expect(parseAdoptArgs(["--to", "0049_l3_contexts_translation"])).toEqual({
      target: "0049_l3_contexts_translation",
      write: false,
    });
    expect(parseAdoptArgs(["--to", "49", "--write"])).toEqual({ target: "49", write: true });
    expect(parseAdoptArgs(["--write", "--to=0049"])).toEqual({ target: "0049", write: true });
  });

  it("requires --to", () => {
    expect(() => parseAdoptArgs(["--write"])).toThrow(/requires --to/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseAdoptArgs(["--to", "49", "--force"])).toThrow(/unexpected argument/);
  });
});

describe("formatReport", () => {
  it("labels each state and prints the tail summary", () => {
    const diff = computeLedgerDiff(
      JOURNAL,
      [{ hash: HASH_A, created_at: "1000" }, { hash: HASH_B, created_at: "1500" }],
      resolveHash,
    );
    const lines = formatReport(diff);

    expect(lines[0]).toContain("applied (exact when)");
    expect(lines[1]).toContain("applied (different when: ledger has 1500, journal expects 2000)");
    expect(lines[2]).toContain("missing");
    expect(lines[3]).toContain("max(created_at) = 1500");
    expect(lines[3]).toContain("missing = 1/3");
  });

  it("names an empty ledger instead of printing null", () => {
    const lines = formatReport(computeLedgerDiff(JOURNAL, [], resolveHash));
    expect(lines.at(-1)).toContain("(empty ledger)");
  });
});

describe("sha256File", () => {
  it("matches the sha256 of the file bytes (drizzle's ledger hash)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ledger-sha-"));
    try {
      const file = path.join(dir, "0049_sample.sql");
      const contents = "ALTER TABLE \"l3_contexts\" ADD COLUMN \"translation\" text;--> statement-breakpoint\n";
      writeFileSync(file, contents, "utf8");

      const expected = createHash("sha256").update(Buffer.from(contents, "utf8")).digest("hex");
      expect(sha256File(file)).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hashes the committed 0049 migration to the value the ledger records", () => {
    // The row adopted for dev/prod during G0; a mismatch would mean the file
    // was edited after the fact (forbidden — see ADR-0042).
    expect(sha256File(path.resolve("drizzle-release/0049_l3_contexts_translation.sql")))
      .toBe("86043e8a3822e526c23112908597ccbc0a20729050b572cc285c731f87593ae1");
  });
});

describe("readJournal", () => {
  it("reads the committed release journal with a strictly rising when", () => {
    const journal = readJournal();
    // The chain had 51 entries when reconciliation landed; assert a floor
    // rather than equality so adding 0051+ does not fail this test.
    expect(journal.entries.length).toBeGreaterThanOrEqual(51);
    for (let i = 1; i < journal.entries.length; i += 1) {
      expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
    }
  });
});
