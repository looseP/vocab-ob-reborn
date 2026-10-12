import { createBackup } from "../scripts/postgres-backup";
import { logger } from "../src/observability/logger";
import { join } from "node:path";
import {
  runBackupCycle,
  seedStateFromLatestManifest,
  writeBackupStateFile,
} from "./backup-scheduler-support";

const intervalMs = parsePositiveInt("BACKUP_INTERVAL_MS", 86_400_000, 3_600_000, 604_800_000);
const maxBackups = parsePositiveInt("BACKUP_RETENTION_COUNT", 14, 1, 365);
const backupDir = process.env.BACKUP_DIR ?? "backups";
/**
 * 状态文件目录（独立小卷，只放一个时间戳）。与 backupDir 分开：web 容器只读挂这个
 * 目录去暴露「距上次成功备份多久了」指标，**不挂** dump 目录 —— 把整库 dump 送进
 * API 进程会绕过全部审计，那是另一回事。
 */
const stateDir = process.env.BACKUP_STATE_DIR ?? join(backupDir, ".state");
/**
 * 单轮失败后的重试次数（不含首次）与退避基数。默认 3 次 × 线性退避 ⇒ 瞬故障自愈，
 * 不再一失败就退出容器去撞 `restart: unless-stopped` 的无退避崩溃重启。
 */
const cycleRetries = parsePositiveInt("BACKUP_CYCLE_RETRIES", 3, 0, 10);
const retryBackoffMs = parsePositiveInt("BACKUP_RETRY_BACKOFF_MS", 60_000, 1_000, 3_600_000);
/**
 * 健康检查允许的「距上次成功备份」最大年龄。必须大于一个 interval，否则健康检查会在
 * 两轮备份之间误报 unhealthy（那比没有健康检查更糟）。compose 的 healthcheck 读同一个值。
 */
const healthMaxAgeSeconds = parsePositiveInt("BACKUP_HEALTH_MAX_AGE_SECONDS", 90_000, 600, 604_800);
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
    setTimeout(resolve, ms);
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
  if (process.env.BACKUP_REQUIRE_SIGNING_KEY === "true" && !process.env.BACKUP_SIGNING_KEY) {
    throw new Error("BACKUP_SIGNING_KEY is required when BACKUP_REQUIRE_SIGNING_KEY=true");
  }
  // 健康检查的新鲜度阈值必须宽于一个 interval，否则它会在两轮备份之间误报
  // unhealthy —— 一个永远误报的健康检查比没有更糟（训练大家忽略它）。
  if (healthMaxAgeSeconds * 1000 <= intervalMs) {
    throw new Error(
      `BACKUP_HEALTH_MAX_AGE_SECONDS (${healthMaxAgeSeconds}) must exceed BACKUP_INTERVAL_MS (${intervalMs}ms)`,
    );
  }

  logger.info("backup-scheduler", "Scheduler started", {
    intervalMs, maxBackups, backupDir, stateDir, cycleRetries, retryBackoffMs, healthMaxAgeSeconds,
  });

  // 升级路径：老版本不写状态文件，直接上新鲜度健康检查会让容器在等到下一轮成功之前
  // 一直 unhealthy（最坏 24h）。用最新的 manifest 把状态文件 seeding 出来。
  if (seedStateFromLatestManifest(backupDir, stateDir)) {
    logger.info("backup-scheduler", "Seeded backup state from latest manifest", { stateDir });
  } else {
    logger.info("backup-scheduler", "No prior backup manifest; state file appears after first success", { stateDir });
  }

  while (!stopping) {
    const ok = await runBackupCycle(
      {
        createBackup,
        pruneOldBackups,
        onSuccess: (at) => {
          try {
            writeBackupStateFile(stateDir, at);
          } catch (error) {
            // 备份已成功：状态文件只是可观测性载体，写不进去不能把一轮成功判成失败
            logger.warn("backup-scheduler", "Backup succeeded but state file write failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        onRetry: ({ attempt, delayMs, error }) =>
          logger.warn("backup-scheduler", "Backup attempt failed; retrying", { attempt, delayMs, error }),
        onExhausted: ({ attempts, error }) =>
          logger.error("backup-scheduler", "Backup cycle failed after all retries; will retry next interval", {
            attempts, error,
          }),
      },
      { retries: cycleRetries, backoffMs: retryBackoffMs },
    );

    if (ok) {
      logger.info("backup-scheduler", "Backup cycle completed", { nextInMs: intervalMs });
    } else {
      // 不退出：健康检查会因状态文件过期转 unhealthy（`docker compose ps` 一眼可见），
      // 下一个 interval 继续尝试。退出只会得到无退避的崩溃重启，反而更难诊断。
      logger.warn("backup-scheduler", "Backup cycle did not succeed this interval", { nextInMs: intervalMs });
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
