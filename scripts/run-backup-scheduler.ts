import { createBackup } from "../scripts/postgres-backup";
import { logger } from "../src/observability/logger";

const intervalMs = parsePositiveInt("BACKUP_INTERVAL_MS", 86_400_000, 3_600_000, 604_800_000);
const maxBackups = parsePositiveInt("BACKUP_RETENTION_COUNT", 14, 1, 365);
const backupDir = process.env.BACKUP_DIR ?? "backups";
let stopping = false;

function parsePositiveInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function pruneOldBackups(): Promise<void> {
  const { readdirSync, statSync, unlinkSync } = await import("node:fs");
  const { join } = await import("node:path");
  const entries = readdirSync(backupDir)
    .filter((f) => f.endsWith(".manifest.json"))
    .map((f) => ({ name: f, mtime: statSync(join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const entry of entries.slice(maxBackups)) {
    const manifestPath = join(backupDir, entry.name);
    const dumpName = entry.name.replace(/\.manifest\.json$/, ".dump");
    const dumpPath = join(backupDir, dumpName);
    try { unlinkSync(manifestPath); } catch { /* may be locked */ }
    try { unlinkSync(dumpPath); } catch { /* may be locked */ }
    logger.info("backup-scheduler", "Pruned old backup", { manifest: entry.name });
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  logger.info("backup-scheduler", "Scheduler started", { intervalMs, maxBackups, backupDir });

  while (!stopping) {
    try {
      await createBackup();
      await pruneOldBackups();
    } catch (error) {
      logger.error("backup-scheduler", "Backup cycle failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(intervalMs);
  }
}

function requestShutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info("backup-scheduler", "Scheduler shutdown requested", { signal });
}

process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGINT", () => requestShutdown("SIGINT"));

main().catch((error) => {
  logger.error("backup-scheduler", "Scheduler failed to start", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
