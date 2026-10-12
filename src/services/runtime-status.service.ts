import type { ILlmUsageRepository, IOutboxRepository } from "../repositories/interfaces";
import { readBackupFreshnessSeconds } from "./backup-freshness";

export interface RuntimeDatabaseStatus {
  ok: boolean;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export interface ComponentStatus {
  status: "up" | "down" | "draining";
  latencyMs?: number;
}

export interface ReadinessSnapshot {
  status: "ready" | "not_ready";
  checks: {
    process: ComponentStatus;
    database: ComponentStatus;
  };
}

export interface RuntimeMetricsSnapshot {
  process: {
    uptimeSeconds: number;
    draining: boolean;
  };
  database: {
    healthy: boolean;
    totalConnections: number;
    idleConnections: number;
    waitingRequests: number;
  };
  outbox: {
    pending: number;
    processing: number;
    /** 死信库存（历史累计）—— 只用于盘点，不可用于告警。 */
    deadLetter: number;
    /** 滚动窗口内新变成死信的数量 —— 告警看这个（见 OutboxMetrics.recentDeadLetters）。 */
    recentDeadLetters: number;
    oldestPendingAgeSeconds: number | null;
  };
  llmReservations: {
    pending: number;
    expiredPending: number;
    oldestPendingAgeSeconds: number;
  };
  /**
   * 备份新鲜度（2026-10-13）。`null` = 还没有成功备份（首次部署 / 状态卷未挂），
   * 此时**不产出指标**，告警规则自然不触发；一旦有了第一次成功，年龄只增不减，
   * 备份停了就会被 `VocabBackupStaleLocal` 抓到。默认告警阈值见
   * `docs/operations/alerting-rules.yaml`。
   */
  backup: {
    lastSuccessAgeSeconds: number | null;
  };
}

export class RuntimeStatusService {
  private draining = false;
  private readinessInFlight: Promise<ReadinessSnapshot> | null = null;
  private cachedReadiness: { value: ReadinessSnapshot; expiresAtMs: number } | null = null;

  constructor(
    private readonly checkDatabase: () => Promise<RuntimeDatabaseStatus>,
    private readonly outbox: IOutboxRepository,
    private readonly llmUsage: ILlmUsageRepository,
    private readonly readinessTimeoutMs = 1_000,
    private readonly startedAtMs = Date.now(),
    private readonly now: () => number = Date.now,
    /** 备份状态文件目录（compose 只读挂载）；空 = 不产出备份新鲜度指标。 */
    private readonly backupStateDir: string | null = null,
    private readonly successCacheMs = 1_000,
    private readonly failureCacheMs = 500,
  ) {
    if (!Number.isInteger(readinessTimeoutMs) || readinessTimeoutMs < 50 || readinessTimeoutMs > 10_000) {
      throw new Error("READINESS_TIMEOUT_MS must be an integer between 50 and 10000");
    }
  }

  setDraining(): void {
    this.draining = true;
    this.cachedReadiness = null;
  }

  isDraining(): boolean {
    return this.draining;
  }

  async getReadiness(): Promise<ReadinessSnapshot> {
    if (this.draining) return this.drainingSnapshot();

    const nowMs = this.now();
    if (this.cachedReadiness && this.cachedReadiness.expiresAtMs > nowMs) {
      return this.cachedReadiness.value;
    }
    if (!this.readinessInFlight) {
      this.readinessInFlight = this.probeReadiness();
    }

    const currentProbe = this.readinessInFlight;
    try {
      const result = await currentProbe;
      if (this.draining) return this.drainingSnapshot();
      this.cachedReadiness = {
        value: result,
        expiresAtMs: this.now() + (result.status === "ready" ? this.successCacheMs : this.failureCacheMs),
      };
      return result;
    } finally {
      if (this.readinessInFlight === currentProbe) this.readinessInFlight = null;
    }
  }

  private async probeReadiness(): Promise<ReadinessSnapshot> {
    const startedAt = this.now();
    const database = await this.withTimeout(this.checkDatabase(), this.readinessTimeoutMs)
      .catch(() => null);
    const latencyMs = Math.max(0, this.now() - startedAt);
    const databaseUp = database?.ok === true;

    return {
      status: databaseUp ? "ready" : "not_ready",
      checks: {
        process: { status: "up" },
        database: { status: databaseUp ? "up" : "down", latencyMs },
      },
    };
  }

  private drainingSnapshot(): ReadinessSnapshot {
    return {
      status: "not_ready",
      checks: {
        process: { status: "draining" },
        database: { status: "down" },
      },
    };
  }

  async getMetrics(): Promise<RuntimeMetricsSnapshot> {
    const [database, outbox, reservations] = await Promise.all([
      this.withTimeout(this.checkDatabase(), this.readinessTimeoutMs),
      this.withTimeout(this.outbox.getMetrics(), this.readinessTimeoutMs),
      this.withTimeout(this.llmUsage.getReservationMetrics(), this.readinessTimeoutMs),
    ]);

    return {
      process: {
        uptimeSeconds: Math.max(0, Math.floor((this.now() - this.startedAtMs) / 1_000)),
        draining: this.draining,
      },
      database: {
        healthy: database.ok,
        totalConnections: database.totalCount,
        idleConnections: database.idleCount,
        waitingRequests: database.waitingCount,
      },
      outbox: {
        pending: outbox.pending,
        processing: outbox.processing,
        deadLetter: outbox.deadLetter,
        recentDeadLetters: outbox.recentDeadLetters,
        oldestPendingAgeSeconds: outbox.oldestPendingAgeSeconds,
      },
      llmReservations: {
        pending: reservations.pendingCount,
        expiredPending: reservations.expiredPendingCount,
        oldestPendingAgeSeconds: reservations.oldestPendingAgeSeconds,
      },
      backup: {
        lastSuccessAgeSeconds: this.readBackupFreshnessSeconds(),
      },
    };
  }

  /**
   * 备份新鲜度：读调度器写的状态文件（compose 只读挂进来的独立小卷）。
   * 读不到 ⇒ null（首部署/未挂卷/还没成功过）⇒ 不产出指标，告警不触发。
   */
  private readBackupFreshnessSeconds(): number | null {
    if (!this.backupStateDir) return null;
    return readBackupFreshnessSeconds(this.backupStateDir, new Date());
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("runtime probe timed out")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
