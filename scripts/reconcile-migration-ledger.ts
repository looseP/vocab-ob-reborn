/**
 * Migration-ledger reconciliation for release databases.
 *
 * The drizzle migrator decides what to apply from a single read of the ledger
 * (`select ... order by created_at desc limit 1`) and a strict `<` comparison
 * against each journal entry's `when` (node_modules/drizzle-orm/pg-core/dialect.cjs).
 * A database whose schema was advanced outside the migrator (db:push, manual
 * DDL) can therefore carry a ledger that is missing rows the journal already
 * accounts for — and the next `db:migrate` then replays a non-idempotent
 * migration on top of the existing schema.
 *
 * Replaying applied migrations cannot self-heal that state (the release chain
 * is linear and mostly non-idempotent by design, see ADR-0042), so the repair
 * path is ledger reconciliation: report the three-way status of every journal
 * entry against the ledger, then adopt the missing rows with a guarded INSERT.
 *
 * Commands:
 *   report                          (default, read-only) per-entry status plus
 *                                   max(created_at) and the missing count.
 *                                   Always exits 0 — it is a report.
 *   adopt --to <tag|idx> [--write]  generate guarded INSERTs for every missing
 *                                   entry at or before the target; without
 *                                   --write it only prints them (dry-run).
 *
 * Run: DATABASE_URL=... npx tsx scripts/reconcile-migration-ledger.ts report
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const releaseDir = path.join(projectRoot, "drizzle-release");

export interface MigrationJournalEntry {
  idx: number;
  tag: string;
  when: number;
}

export interface MigrationJournal {
  entries: MigrationJournalEntry[];
}

/** One ledger row as read from vocab_migrations.__v2_release_migrations. */
export interface AppliedLedgerRow {
  hash: string;
  created_at: string | number | bigint;
}

/**
 * `applied-exact`     — the file's hash is recorded with the journal's `when`;
 *                       the migrator will skip it.
 * `applied-different` — the file's hash is recorded under a different
 *                       created_at (the 0047–0049 tied-`when` incident wrote
 *                       three rows sharing one timestamp). The migrator only
 *                       compares created_at, so this is a warning, not a
 *                       repair target: adopting here would duplicate a row.
 * `missing`           — no ledger row carries the file's hash; the migrator
 *                       will replay the file once max(created_at) < when.
 */
export type LedgerStatus = "applied-exact" | "applied-different" | "missing";

export interface LedgerEntryDiff {
  idx: number;
  tag: string;
  when: number;
  hash: string;
  status: LedgerStatus;
  /** created_at of the ledger row whose hash matched (applied-* only). */
  ledgerWhen: number | null;
}

export interface LedgerDiff {
  entries: LedgerEntryDiff[];
  missing: LedgerEntryDiff[];
  maxJournalWhen: number;
  maxLedgerCreatedAt: number | null;
}

export interface AdoptStatement {
  idx: number;
  tag: string;
  when: number;
  hash: string;
  sql: string;
}

/** SHA-256 of the file's bytes — the exact hash drizzle records in the ledger. */
export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** Read and shape `meta/_journal.json`; throws on malformed entries. */
export function readJournal(releaseDirectory = releaseDir): MigrationJournal {
  const journalPath = path.join(releaseDirectory, "meta", "_journal.json");
  const raw = JSON.parse(readFileSync(journalPath, "utf8")) as { entries?: unknown };
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  if (entries.length === 0) {
    throw new Error(`no journal entries in ${journalPath}`);
  }
  return {
    entries: entries.map((value, index) => {
      const entry = (value ?? {}) as { idx?: unknown; tag?: unknown; when?: unknown };
      if (typeof entry.tag !== "string" || entry.tag.length === 0) {
        throw new Error(`journal entry ${index} has no tag`);
      }
      if (typeof entry.when !== "number" || !Number.isFinite(entry.when)) {
        throw new Error(`journal entry ${entry.tag} has no finite when`);
      }
      return {
        idx: typeof entry.idx === "number" ? entry.idx : index,
        tag: entry.tag,
        when: entry.when,
      };
    }),
  };
}

/**
 * Three-way status of every journal entry against the ledger rows.
 *
 * Matching is by file hash (identity), not by created_at alone: the tied-`when`
 * incident left rows whose timestamps collide across different files, so the
 * timestamp cannot say which file a row belongs to.
 */
export function computeLedgerDiff(
  journal: MigrationJournal,
  appliedRows: readonly AppliedLedgerRow[],
  resolveHash: (tag: string) => string,
): LedgerDiff {
  const rowsByHash = new Map<string, number[]>();
  for (const row of appliedRows) {
    const when = Number(row.created_at);
    if (!Number.isFinite(when)) continue;
    const bucket = rowsByHash.get(row.hash);
    if (bucket) bucket.push(when);
    else rowsByHash.set(row.hash, [when]);
  }

  const entries = journal.entries.map((entry) => {
    const hash = resolveHash(entry.tag);
    const candidates = rowsByHash.get(hash) ?? [];
    const exact = candidates.find((when) => when === entry.when);
    const ledgerWhen = exact ?? (candidates.length > 0 ? Math.max(...candidates) : null);
    const status: LedgerStatus = ledgerWhen === null
      ? "missing"
      : ledgerWhen === entry.when
        ? "applied-exact"
        : "applied-different";
    return { idx: entry.idx, tag: entry.tag, when: entry.when, hash, status, ledgerWhen };
  });

  const ledgerTimes = appliedRows
    .map((row) => Number(row.created_at))
    .filter((when) => Number.isFinite(when));

  return {
    entries,
    missing: entries.filter((entry) => entry.status === "missing"),
    maxJournalWhen: journal.entries.reduce((max, entry) => Math.max(max, entry.when), 0),
    maxLedgerCreatedAt: ledgerTimes.length > 0 ? Math.max(...ledgerTimes) : null,
  };
}

/**
 * Resolve `--to` to a position in the journal. Accepts a tag
 * (`0049_l3_contexts_translation`) or an idx (`49`, `0049`).
 */
export function resolveAdoptTarget(journal: MigrationJournal, target: string): number {
  const trimmed = target.trim();
  if (/^\d+$/.test(trimmed)) {
    const idx = Number(trimmed);
    const position = journal.entries.findIndex((entry) => entry.idx === idx);
    if (position >= 0) return position;
  }
  const position = journal.entries.findIndex((entry) => entry.tag === trimmed);
  if (position < 0) {
    throw new Error(
      `unknown migration target: ${target} (expected a journal tag like 0049_l3_contexts_translation or an idx like 49)`,
    );
  }
  return position;
}

/**
 * Guarded INSERTs for every missing entry at or before the target.
 *
 * The `WHERE NOT EXISTS` guard keeps the statement idempotent: re-running it,
 * or running it against a database whose ledger gained the row meanwhile, is a
 * no-op. The hash is the same sha256 drizzle would record (whole file bytes).
 */
export function buildAdoptStatements(diff: LedgerDiff, target: string): AdoptStatement[] {
  const position = resolveAdoptTarget({ entries: diff.entries }, target);
  return diff.entries
    .slice(0, position + 1)
    .filter((entry) => entry.status === "missing")
    .map((entry) => ({
      idx: entry.idx,
      tag: entry.tag,
      when: entry.when,
      hash: entry.hash,
      sql:
        "INSERT INTO vocab_migrations.__v2_release_migrations (hash, created_at)\n" +
        `SELECT '${entry.hash}', ${entry.when}\n` +
        "WHERE NOT EXISTS (\n" +
        `  SELECT 1 FROM vocab_migrations.__v2_release_migrations WHERE created_at = ${entry.when}\n` +
        ");",
    }));
}

/** Human-readable report lines: one per entry, then the tail summary. */
export function formatReport(diff: LedgerDiff): string[] {
  const lines = diff.entries.map((entry) => {
    const label = entry.status === "applied-different"
      ? `applied (different when: ledger has ${entry.ledgerWhen}, journal expects ${entry.when})`
      : entry.status === "applied-exact"
        ? "applied (exact when)"
        : "missing";
    return `${entry.tag} (idx ${entry.idx}, when ${entry.when}): ${label}`;
  });
  lines.push(
    `max(created_at) = ${diff.maxLedgerCreatedAt ?? "(empty ledger)"}; ` +
      `journal max when = ${diff.maxJournalWhen}; ` +
      `missing = ${diff.missing.length}/${diff.entries.length}`,
  );
  return lines;
}

/** Parse `adopt` flags; rejects anything else so typos fail loudly. */
export function parseAdoptArgs(args: readonly string[]): { target: string; write: boolean } {
  let target: string | undefined;
  let write = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--write") {
      write = true;
    } else if (arg === "--to") {
      target = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--to=")) {
      target = arg.slice("--to=".length);
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (!target) {
    throw new Error("adopt requires --to <tag|idx>");
  }
  return { target, write };
}

/**
 * Print (and with `write`, execute) the adopt statements. The execute/log
 * seams are injected so the dry-run path is testable without a database.
 */
export async function runAdopt(
  diff: LedgerDiff,
  target: string,
  options: {
    write: boolean;
    execute: (sql: string) => Promise<void>;
    log: (line: string) => void;
  },
): Promise<AdoptStatement[]> {
  const statements = buildAdoptStatements(diff, target);
  if (statements.length === 0) {
    options.log("nothing to adopt: every entry at or before the target is already in the ledger");
    return statements;
  }
  for (const statement of statements) {
    options.log(`${options.write ? "[adopt]" : "[dry-run]"} ${statement.tag} (when ${statement.when})`);
    options.log(statement.sql);
    if (options.write) {
      await options.execute(statement.sql);
    }
  }
  return statements;
}

/** Ledger rows, oldest first; an absent ledger reads as empty (fresh database). */
export async function readAppliedRows(pool: Pool): Promise<AppliedLedgerRow[]> {
  const exists = await pool.query<{ name: string | null }>(
    "SELECT to_regclass('vocab_migrations.__v2_release_migrations')::text AS name",
  );
  if (!exists.rows[0]?.name) {
    return [];
  }
  const result = await pool.query<AppliedLedgerRow>(
    "SELECT hash, created_at FROM vocab_migrations.__v2_release_migrations ORDER BY created_at ASC, id ASC",
  );
  return result.rows;
}

export function resolveHashForTag(tag: string): string {
  return sha256File(path.join(releaseDir, `${tag}.sql`));
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? "report";
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    return 1;
  }

  const journal = readJournal();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const appliedRows = await readAppliedRows(pool);
    const diff = computeLedgerDiff(journal, appliedRows, resolveHashForTag);

    if (command === "report") {
      for (const line of formatReport(diff)) console.log(line);
      return 0;
    }

    if (command === "adopt") {
      const { target, write } = parseAdoptArgs(argv.slice(1));
      await runAdopt(diff, target, {
        write,
        execute: async (sql) => {
          await pool.query(sql);
        },
        log: (line) => console.log(line),
      });

      // Re-read so the log states whether the guarded INSERTs actually landed
      // (a colliding created_at from an unrelated row would swallow one).
      const after = computeLedgerDiff(journal, await readAppliedRows(pool), resolveHashForTag);
      console.log(
        `after adopt: max(created_at) = ${after.maxLedgerCreatedAt ?? "(empty ledger)"}; ` +
          `missing = ${after.missing.length}/${after.entries.length}` +
          (write ? "" : " (dry-run: nothing was written)"),
      );
      return 0;
    }

    console.error(`unknown command: ${command} (expected report | adopt)`);
    return 1;
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
