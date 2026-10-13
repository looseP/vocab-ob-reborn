/**
 * 备份状态读取（2026-10-13，深度审查 P1 的最后一环）。
 *
 * 锁三件事：
 *   ① 读得到 ⇒ 返回距上次**成功**的秒数（供 runtime 指标与 VocabBackupStaleLocal 告警）；
 *   ② 读不到 / 内容坏 ⇒ null 且**不抛**——「首部署、卷没挂」都不该把 /metrics 打挂；
 *   ③ 从未成功过 ⇒ null 而不是 0：没有"上次成功"就不该有指标，否则首部署就被告警吵一遍。
 *      「从没成功过」这种更严重的状况由**容器健康检查**负责（它看 outcome，不看年龄）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BACKUP_STATE_FILE_NAME,
  readBackupFreshnessSeconds,
  readBackupState,
} from "@/services/backup-freshness";

let dir: string;
const NOW = new Date("2026-10-13T12:00:00.000Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backup-freshness-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeState(content: unknown): void {
  writeFileSync(
    join(dir, BACKUP_STATE_FILE_NAME),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

const SUCCESS_AT = "2026-10-13T11:30:00.000Z";

describe("readBackupState", () => {
  it("解析成功状态", () => {
    writeState({ at: SUCCESS_AT, outcome: "success", lastSuccessAt: SUCCESS_AT, lastError: null });

    expect(readBackupState(dir)).toEqual({
      at: SUCCESS_AT,
      outcome: "success",
      lastSuccessAt: SUCCESS_AT,
      lastError: null,
    });
  });

  it("解析失败状态并保留上次成功时间", () => {
    writeState({
      at: "2026-10-13T12:00:00.000Z",
      outcome: "failed",
      lastSuccessAt: SUCCESS_AT,
      lastError: "disk full",
    });

    expect(readBackupState(dir)).toMatchObject({ outcome: "failed", lastError: "disk full", lastSuccessAt: SUCCESS_AT });
  });

  it("文件不存在 / 目录不存在 / 坏 JSON ⇒ null 且不抛", () => {
    expect(readBackupState(dir)).toBeNull();
    expect(readBackupState(join(dir, "missing"))).toBeNull();
    writeState("{ not json");
    expect(readBackupState(dir)).toBeNull();
  });

  it("outcome 不是 success/failed ⇒ null（防止旧格式/半截状态混过去）", () => {
    writeState({ at: SUCCESS_AT, outcome: "pending", lastSuccessAt: null, lastError: null });

    expect(readBackupState(dir)).toBeNull();
  });

  it("at 缺失或不是合法时间 ⇒ null", () => {
    writeState({ outcome: "success", lastSuccessAt: SUCCESS_AT, lastError: null });
    expect(readBackupState(dir)).toBeNull();
    writeState({ at: "nope", outcome: "success", lastSuccessAt: SUCCESS_AT, lastError: null });
    expect(readBackupState(dir)).toBeNull();
  });
});

describe("readBackupFreshnessSeconds", () => {
  it("返回距上次成功备份的秒数", () => {
    writeState({ at: SUCCESS_AT, outcome: "success", lastSuccessAt: SUCCESS_AT, lastError: null });

    expect(readBackupFreshnessSeconds(dir, NOW)).toBe(1800);
  });

  it("刚失败但上次成功不久 ⇒ 仍按上次成功算年龄（告警看的是多久没成功）", () => {
    writeState({
      at: "2026-10-13T11:59:00.000Z",
      outcome: "failed",
      lastSuccessAt: SUCCESS_AT,
      lastError: "disk full",
    });

    expect(readBackupFreshnessSeconds(dir, NOW)).toBe(1800);
  });

  it("从未成功过（lastSuccessAt=null）⇒ null，不产出指标", () => {
    // 否则首部署/全失败栈会被告警从第一天吵到删规则
    writeState({ at: SUCCESS_AT, outcome: "failed", lastSuccessAt: null, lastError: "boom" });

    expect(readBackupFreshnessSeconds(dir, NOW)).toBeNull();
  });

  it("时钟跳变（lastSuccessAt 在未来）⇒ 0 而不是负数", () => {
    writeState({
      at: "2026-10-13T12:05:00.000Z",
      outcome: "success",
      lastSuccessAt: "2026-10-13T12:05:00.000Z",
      lastError: null,
    });

    expect(readBackupFreshnessSeconds(dir, NOW)).toBe(0);
  });

  it("lastSuccessAt 是坏值 ⇒ null（不把 NaN 渗进指标）", () => {
    writeState({ at: SUCCESS_AT, outcome: "success", lastSuccessAt: "yesterday", lastError: null });

    expect(readBackupFreshnessSeconds(dir, NOW)).toBeNull();
  });
});
