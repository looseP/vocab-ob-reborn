/**
 * 备份调度器的可测支撑逻辑（2026-10-13 从 run-backup-scheduler.ts 抽出）。
 *
 * 为什么抽出来：原脚本把重试与状态文件写入内联在 while 循环里，文件顶部还有
 * process.on 与 main().catch() 的导入期副作用，单测碰不得。而这段逻辑正是
 * 2026-10-13 深度审查点名的两个缺陷所在：
 *
 *   1) 单轮失败直接 throw，进程退出，restart: unless-stopped 无退避地崩溃重启，
 *      瞬故障（DB 抖一下、磁盘忙一秒）也能把备份打死；
 *   2) 健康检查只探 pg_dump --version，备份失败千百回也照样 healthy，
 *      「备份好久没成功」在单机栈里没人知道。
 *
 * 本模块只放纯逻辑（依赖全部可注入），IO 与进程生命周期仍留在脚本里。
 */
import { mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_STATE_FILE_NAME } from "../src/services/backup-freshness";

export { BACKUP_STATE_FILE_NAME };

export interface BackupStateFile {
  /** 最近一次成功备份的完成时间（ISO）。 */
  at: string;
  outcome: "success";
}

/**
 * 原子写「最近一次成功备份」状态文件。
 *
 * 原子性靠 write + rename（同目录 POSIX rename 是原子的）：健康检查永远不会读到写了
 * 一半的 JSON。目录不存在时先建（首次运行 / 挂载点刚就位）。
 */
export function writeBackupStateFile(dir: string, at: Date): void {
  const target = join(dir, BACKUP_STATE_FILE_NAME);
  const temp = target + ".tmp";
  const payload: BackupStateFile = { at: at.toISOString(), outcome: "success" };
  mkdirSync(dir, { recursive: true });
  writeFileSync(temp, JSON.stringify(payload) + "\n", { mode: 0o644 });
  renameSync(temp, target);
}

/**
 * 从既有的 `.manifest.json` 里挑最新一个，把状态文件 seeding 到 stateDir。
 *
 * 升级路径用：老版本不写状态文件，直接上「新鲜度」健康检查会让容器在等到下一轮成功
 * 备份之前一直显示 unhealthy（最坏一个 interval，默认 24h）。这里让已有的成功证据
 * 说话。manifestDir（dump 所在）与 stateDir（状态文件所在）是**两个目录**：后者是
 * 独立小卷、只放一个时间戳，可以安全地只读挂给 web 容器去暴露指标；把前者挂过去
 * 等于把整库 dump 送进 API 进程、绕过全部审计，那是另一回事。
 * 返回是否 seeding 成功（无 manifest / 读不了目录都算失败）。
 */
export function seedStateFromLatestManifest(manifestDir: string, stateDir: string): boolean {
  try {
    const manifests = readdirSync(manifestDir)
      .filter((name) => name.endsWith(".manifest.json"))
      .map((name) => ({ name, mtimeMs: statSync(join(manifestDir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = manifests[0];
    if (!latest) return false;
    writeBackupStateFile(stateDir, new Date(latest.mtimeMs));
    return true;
  } catch {
    return false;
  }
}

export interface BackupCycleDeps {
  createBackup: () => Promise<void>;
  pruneOldBackups: () => Promise<void>;
  /** 本轮成功：调用方通常在这里落状态文件。 */
  onSuccess?: (at: Date) => void;
  /** 第 n 次尝试失败、准备退避后重试。 */
  onRetry?: (info: { attempt: number; retries: number; delayMs: number; error: string }) => void;
  /** 全部尝试都失败。注意：此时不抛错，只回报 false。 */
  onExhausted?: (info: { attempts: number; error: string }) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface BackupCycleOptions {
  /** 失败后的重试次数（不含首次尝试）：0 = 失败即进入下一轮。 */
  retries: number;
  /** 退避基数：第 n 次重试前睡 n * backoffMs（线性退避，避免雪崩）。 */
  backoffMs: number;
}

/**
 * 跑一轮备份，失败按线性退避重试；全部失败也不抛错，只返回 false。
 *
 * 调度器的职责是持续尝试：瞬故障应当自愈，久故障的可见性由健康检查（状态文件新鲜度）
 * 与错误日志负责。原先「失败即 throw」把这两件事一起弄丢了：容器无限崩溃重启，
 * 而健康检查永远 healthy，没人知道备份已经停了。
 */
export async function runBackupCycle(
  deps: BackupCycleDeps,
  options: BackupCycleOptions,
): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = options.retries + 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await deps.createBackup();
      await deps.pruneOldBackups();
      deps.onSuccess?.(new Date());
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) {
        const delayMs = attempt * options.backoffMs;
        deps.onRetry?.({ attempt, retries: options.retries, delayMs, error: message });
        await sleep(delayMs);
        continue;
      }
      deps.onExhausted?.({ attempts, error: message });
      return false;
    }
  }
  return false;
}
