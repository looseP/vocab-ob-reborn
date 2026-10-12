/**
 * 备份新鲜度读取（2026-10-13，深度审查 P1 的最后一环）。
 *
 * 背景：`backup-scheduler` 容器每轮备份成功后，会往**独立小卷**（只放一个 JSON
 * 时间戳，compose 里只读挂给 web）写 `last-success.json`。web 读它，把「距上次成功
 * 备份多少秒」暴露成 runtime 指标，默认告警集因此能在备份停了的时候叫醒人 ——
 * 在此之前，「备份好久没成功」在单机栈里没有任何自动信号（健康检查只探
 * `pg_dump --version`，失败千百回也 healthy）。
 *
 * 之所以读状态文件而不是挂 `/backups`：那是整库 dump，进 API 进程等于开一条
 * 绕过全部审计的数据出口。时间戳没有这个风险。
 *
 * 读取端永不抛错：文件不存在（首次部署 / 卷没挂 / 还没成功过）返回 null，
 * 调用方据此**不产出指标**，告警规则自然不触发。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 与 `scripts/backup-scheduler-support.ts` 的写入端保持一致。 */
export const BACKUP_STATE_FILE_NAME = "last-success.json";

/**
 * 距上次成功备份的秒数；读不到 / 解析不了 / 时间为未来 ⇒ null。
 *
 * 未来时间戳归零而不是报错：容器时钟跳变（NTP 校正、挂载卷的 mtime 精度）不该让
 * 指标变成负数，负数会让 `> 阈值` 的告警规则出现难以理解的取值。
 */
export function readBackupFreshnessSeconds(stateDir: string, now: Date = new Date()): number | null {
  try {
    const raw = readFileSync(join(stateDir, BACKUP_STATE_FILE_NAME), "utf8");
    const parsed = JSON.parse(raw) as { at?: unknown };
    if (typeof parsed.at !== "string") return null;
    const at = new Date(parsed.at);
    if (Number.isNaN(at.getTime())) return null;
    const ageSeconds = Math.floor((now.getTime() - at.getTime()) / 1000);
    return ageSeconds > 0 ? ageSeconds : 0;
  } catch {
    return null;
  }
}
