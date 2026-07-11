import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const baseRef = process.env.ROLLBACK_BASE_REF ?? "HEAD^";
const worktree = mkdtempSync(join(tmpdir(), "vocab-rollback-"));
function git(args: string[], cwd = root): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
try {
  const baseSha = git(["rev-parse", baseRef + "^{commit}"]);
  git(["worktree", "add", "--detach", worktree, baseSha]);
  const currentJournal = git(["show", "HEAD:drizzle-release/meta/_journal.json"]);
  const previousJournal = git(["show", baseSha + ":drizzle-release/meta/_journal.json"]);
  const current = JSON.parse(currentJournal) as { entries: Array<{ tag: string }> };
  const previous = JSON.parse(previousJournal) as { entries: Array<{ tag: string }> };
  const currentTags = new Set(current.entries.map((entry) => entry.tag));
  for (const entry of previous.entries) if (!currentTags.has(entry.tag)) throw new Error(`Current migration journal removed ${entry.tag}`);
  console.log(JSON.stringify({ ok: true, baseSha, previousMigrations: previous.entries.length, currentMigrations: current.entries.length, strategy: "forward-compatible-no-down-migration" }));
} finally {
  try { git(["worktree", "remove", "--force", worktree]); } catch { rmSync(worktree, { recursive: true, force: true }); }
}
