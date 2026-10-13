/**
 * 备份调度器可测内核（2026-10-13）。
 *
 * 锁的是深度审查 P1 的两条行为：
 *   ① 单轮失败**绝不**把进程搞死（否则 restart: unless-stopped 无退避崩溃重启，
 *      瞬故障也打死备份）；失败按线性退避重试，重试耗尽也只回报 false；
 *   ② 每轮都落状态文件（成功与失败都写）—— 健康检查靠「新鲜度 + outcome」判断备份
 *      是否还活着（原先只探 pg_dump --version，失败千百回也 healthy），且"从没成功过"
 *      因此能与"还没跑过第一轮"区分开。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKUP_STATE_FILE_NAME,
  runBackupCycle,
  seedStateFromLatestManifest,
  writeBackupStateFile,
} from "../../scripts/backup-scheduler-support";
import type { BackupState } from "../../src/services/backup-freshness";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "backup-scheduler-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<Parameters<typeof runBackupCycle>[0]> = {}) {
  const slept: number[] = [];
  return {
    slept,
    createBackup: vi.fn(async () => {}),
    pruneOldBackups: vi.fn(async () => {}),
    onSuccess: vi.fn(),
    onRetry: vi.fn(),
    onExhausted: vi.fn(),
    sleep: vi.fn(async (ms: number) => {
      slept.push(ms);
    }),
    ...overrides,
  };
}

describe("runBackupCycle", () => {
  it("一次成功：不睡不退，回报成功并落状态文件回调", async () => {
    const d = deps();

    await expect(runBackupCycle(d, { retries: 3, backoffMs: 1000 })).resolves.toBe(true);

    expect(d.createBackup).toHaveBeenCalledTimes(1);
    expect(d.pruneOldBackups).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.onSuccess)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.onSuccess).mock.calls[0][0]).toBeInstanceOf(Date);
    expect(d.slept).toEqual([]);
    expect(d.onRetry).not.toHaveBeenCalled();
    expect(d.onExhausted).not.toHaveBeenCalled();
  });

  it("失败一次后成功：按 attempt × backoff 线性退避，最终成功", async () => {
    let calls = 0;
    const d = deps({
      createBackup: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("db briefly unavailable");
      }),
    });

    await expect(runBackupCycle(d, { retries: 3, backoffMs: 1000 })).resolves.toBe(true);

    expect(d.createBackup).toHaveBeenCalledTimes(2);
    expect(d.slept).toEqual([1000]); // 第 1 次重试前睡 1 × backoff
    expect(d.onRetry).toHaveBeenCalledWith({
      attempt: 1, retries: 3, delayMs: 1000, error: "db briefly unavailable",
    });
    expect(vi.mocked(d.onSuccess)).toHaveBeenCalledTimes(1);
  });

  it("连续失败：线性退避 1×/2×/3×，耗尽后回报 false 且**不抛错**", async () => {
    // 这条是 P1 的核心：原先失败即 throw ⇒ 进程退出 ⇒ 无退避崩溃重启。
    const d = deps({ createBackup: vi.fn(async () => { throw new Error("disk full"); }) });

    await expect(runBackupCycle(d, { retries: 3, backoffMs: 1000 })).resolves.toBe(false);

    expect(d.createBackup).toHaveBeenCalledTimes(4); // 首次 + 3 次重试
    expect(d.slept).toEqual([1000, 2000, 3000]);
    expect(d.onExhausted).toHaveBeenCalledWith({ attempts: 4, error: "disk full" });
    expect(d.onSuccess).not.toHaveBeenCalled();
  });

  it("retries=0：失败即进入下一轮，不睡", async () => {
    const d = deps({ createBackup: vi.fn(async () => { throw new Error("nope"); }) });

    await expect(runBackupCycle(d, { retries: 0, backoffMs: 1000 })).resolves.toBe(false);

    expect(d.createBackup).toHaveBeenCalledTimes(1);
    expect(d.slept).toEqual([]);
    expect(d.onExhausted).toHaveBeenCalledWith({ attempts: 1, error: "nope" });
  });

  it("保留清理失败同样走重试（备份成功但 prune 炸了也要重试整轮）", async () => {
    let pruneCalls = 0;
    const d = deps({
      pruneOldBackups: vi.fn(async () => {
        pruneCalls += 1;
        if (pruneCalls === 1) throw new Error("locked");
      }),
    });

    await expect(runBackupCycle(d, { retries: 2, backoffMs: 500 })).resolves.toBe(true);

    expect(d.createBackup).toHaveBeenCalledTimes(2);
    expect(pruneCalls).toBe(2);
  });
});

function state(overrides: Partial<BackupState> = {}): BackupState {
  return {
    at: "2026-10-13T01:02:03.000Z",
    outcome: "success",
    lastSuccessAt: "2026-10-13T01:02:03.000Z",
    lastError: null,
    ...overrides,
  };
}

describe("writeBackupStateFile", () => {
  it("写紧凑 JSON（健康检查要 grep \"outcome\":\"success\"），不留 .tmp 残留", () => {
    writeBackupStateFile(dir, state());

    const raw = readFileSync(join(dir, BACKUP_STATE_FILE_NAME), "utf8");
    expect(JSON.parse(raw)).toEqual(state());
    // 紧凑序列化：shell 里的 grep 才能匹配上
    expect(raw).toContain('"outcome":"success"');
    expect(raw).not.toContain('"outcome": "success"');
    expect(() => statSync(join(dir, `${BACKUP_STATE_FILE_NAME}.tmp`))).toThrow();
  });

  it("失败状态也写（outcome=failed + lastError），保留上次成功时间", () => {
    writeBackupStateFile(dir, state({
      at: "2026-10-13T02:00:00.000Z",
      outcome: "failed",
      lastSuccessAt: "2026-10-13T01:02:03.000Z",
      lastError: "disk full",
    }));

    const raw = readFileSync(join(dir, BACKUP_STATE_FILE_NAME), "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      outcome: "failed",
      lastError: "disk full",
      lastSuccessAt: "2026-10-13T01:02:03.000Z",
    });
    expect(raw).not.toContain('"outcome":"success"');
  });

  it("目录不存在时先建（首次运行 / 挂载点刚就位）", () => {
    writeBackupStateFile(join(dir, "a", "b"), state());

    expect(JSON.parse(readFileSync(join(join(dir, "a", "b"), BACKUP_STATE_FILE_NAME), "utf8")).outcome).toBe("success");
  });

  it("覆盖写：后一轮替换前一轮（mtime 向前走，健康检查才准）", () => {
    writeBackupStateFile(dir, state({ at: "2026-10-12T00:00:00.000Z" }));
    const first = statSync(join(dir, BACKUP_STATE_FILE_NAME)).mtimeMs;

    writeBackupStateFile(dir, state({ at: "2026-10-13T00:00:00.000Z" }));
    const second = statSync(join(dir, BACKUP_STATE_FILE_NAME)).mtimeMs;

    expect(second).toBeGreaterThanOrEqual(first);
  });
});

describe("seedStateFromLatestManifest", () => {
  it("挑最新的 manifest 播种到**独立的** stateDir（不碰 dump 目录）", () => {
    const manifestDir = join(dir, "backups");
    const stateDir = join(dir, "state");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, "old.dump.manifest.json"), "{}");
    writeFileSync(join(manifestDir, "new.dump.manifest.json"), "{}");
    // 让 new 的 mtime 明显晚于 old（文件系统 mtime 分辨率可能只有 1s）
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(manifestDir, "new.dump.manifest.json"), future, future);

    expect(seedStateFromLatestManifest(manifestDir, stateDir)).toBe(true);
    expect(JSON.parse(readFileSync(join(stateDir, BACKUP_STATE_FILE_NAME), "utf8")).outcome).toBe("success");
    // dump 目录里不该出现状态文件（否则就等于把 dump 目录共享给了 web）
    expect(() => statSync(join(manifestDir, BACKUP_STATE_FILE_NAME))).toThrow();
  });

  it("没有任何 manifest 时返回 false（等首轮结果再写）", () => {
    expect(seedStateFromLatestManifest(dir, join(dir, "state"))).toBe(false);
  });

  it("manifest 目录不存在时返回 false 且不抛", () => {
    expect(seedStateFromLatestManifest(join(dir, "missing"), join(dir, "state"))).toBe(false);
  });
});
