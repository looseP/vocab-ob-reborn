/**
 * 备份状态读取（2026-10-13，深度审查 P1 的最后一环）。
 *
 * 背景：`backup-scheduler` 容器每轮备份后往**独立小卷**（只放一个小 JSON，compose 里
 * 只读挂给 web）写 `backup-state.json`。web 读它，把「距上次成功备份多少秒」暴露成
 * runtime 指标，默认告警集因此能在备份停了的时候叫醒人 —— 在此之前，「备份好久没
 * 成功」在单机栈里没有任何自动信号（健康检查只探 `pg_dump --version`，失败千百回
 * 也 healthy）。
 *
 * 之所以读状态文件而不是挂 `/backups`：那是整库 dump，进 API 进程等于开一条绕过
 * 全部审计的数据出口。一个几字节的 JSON 没有这个风险。
 *
 * 读取端永不抛错：文件不存在 / 内容坏 ⇒ null，调用方据此不产出指标。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 与 `scripts/backup-scheduler-support.ts` 的写入端保持一致。 */
export const BACKUP_STATE_FILE_NAME = "backup-state.json";

export interface BackupState {
  /** 本轮（最近一次尝试）的完成时间。 */
  at: string;
  /** 本轮结果。失败也写文件 —— 否则"从没成功过"与"还没跑过第一轮"无法区分。 */
  outcome: "success" | "failed";
  /** 最近一次**成功**的时间；从未成功过则为 null。 */
  lastSuccessAt: string | null;
  /** 本轮失败原因（成功时为 null）。 */
  lastError: string | null;
}

function parseState(raw: string): BackupState | null {
  const parsed = JSON.parse(raw) as Partial<BackupState>;
  if (typeof parsed.at !== "string" || Number.isNaN(new Date(parsed.at).getTime())) return null;
  if (parsed.outcome !== "success" && parsed.outcome !== "failed") return null;
  const lastSuccessAt = parsed.lastSuccessAt ?? null;
  if (lastSuccessAt !== null && Number.isNaN(new Date(lastSuccessAt).getTime())) return null;
  return {
    at: parsed.at,
    outcome: parsed.outcome,
    lastSuccessAt,
    lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
  };
}

/** 读状态文件；读不到 / 内容坏 ⇒ null（绝不抛）。 */
export function readBackupState(stateDir: string): BackupState | null {
  try {
    return parseState(readFileSync(join(stateDir, BACKUP_STATE_FILE_NAME), "utf8"));
  } catch {
    return null;
  }
}

/**
 * 距上次**成功**备份的秒数；从未成功过（或读不到状态）⇒ null。
 *
 * 从未成功过也返回 null 而不是 0：指标语义是"上次成功多久了"，没有"上次成功"就
 * 不该有指标 —— 否则首部署就会被告警吵一遍。容器健康检查负责"从没成功过"这种更
 * 严重的状况（它看的是 outcome，不是年龄）。
 *
 * 未来时间戳归零而不是报负：容器时钟跳变（NTP 校正）不该让 `> 阈值` 的告警规则
 * 出现难以理解的取值。
 */
export function readBackupFreshnessSeconds(stateDir: string, now: Date = new Date()): number | null {
  const state = readBackupState(stateDir);
  if (!state?.lastSuccessAt) return null;
  const at = new Date(state.lastSuccessAt);
  if (Number.isNaN(at.getTime())) return null;
  const ageSeconds = Math.floor((now.getTime() - at.getTime()) / 1000);
  return ageSeconds > 0 ? ageSeconds : 0;
}
