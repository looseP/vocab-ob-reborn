/**
 * 备份新鲜度读取（2026-10-13，深度审查 P1 的最后一环）。
 *
 * 锁两件事：
 *   ① 读得到 ⇒ 返回秒数（供 runtime 指标与 VocabBackupStaleLocal 告警）；
 *   ② 读不到 / 内容坏 ⇒ null 且**不抛**——「首部署、卷没挂、还没成功过」都不该把
 *      /metrics 打挂，更不该让告警在没有任何备份失败事实时乱响。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BACKUP_STATE_FILE_NAME, readBackupFreshnessSeconds } from "@/services/backup-freshness";

let dir: string;
const NOW = new Date("2026-10-13T12:00:00.000Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backup-freshness-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeState(at: unknown): void {
  writeFileSync(join(dir, BACKUP_STATE_FILE_NAME), JSON.stringify({ at, outcome: "success" }));
}

describe("readBackupFreshnessSeconds", () => {
  it("返回距上次成功备份的秒数", () => {
    writeState(new Date("2026-10-13T11:30:00.000Z").toISOString());

    expect(readBackupFreshnessSeconds(dir, NOW)).toBe(1800);
  });

  it("文件不存在 ⇒ null（首部署 / 卷没挂 / 还没成功过）", () => {
    expect(readBackupFreshnessSeconds(dir, NOW)).toBeNull();
  });

  it("目录不存在 ⇒ null 且不抛", () => {
    expect(readBackupFreshnessSeconds(join(dir, "missing"), NOW)).toBeNull();
  });

  it("内容不是合法 JSON ⇒ null", () => {
    writeFileSync(join(dir, BACKUP_STATE_FILE_NAME), "{ not json");

    expect(readBackupFreshnessSeconds(dir, NOW)).toBeNull();
  });

  it("缺 at 字段或 at 不是字符串 ⇒ null", () => {
    writeState(undefined);
    expect(readBackupFreshnessSeconds(dir, NOW)).toBeNull();
    writeState(12345);
    expect(readBackupFreshnessSeconds(dir, NOW)).toBeNull();
  });

  it("at 不是合法时间 ⇒ null", () => {
    writeState("not-a-timestamp");

    expect(readBackupFreshnessSeconds(dir, NOW)).toBeNull();
  });

  it("时钟跳变（at 在未来）⇒ 0 而不是负数", () => {
    // 负年龄会让 `> 阈值` 的告警规则出现难以理解的取值
    writeState(new Date("2026-10-13T12:05:00.000Z").toISOString());

    expect(readBackupFreshnessSeconds(dir, NOW)).toBe(0);
  });

  it("刚好等于阈值边界时不留 off-by-one", () => {
    writeState(new Date("2026-10-13T11:00:00.000Z").toISOString());

    expect(readBackupFreshnessSeconds(dir, NOW)).toBe(3600);
  });
});
