import type { ILlmUsageRepository, IOutboxRepository } from "../repositories/interfaces";

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
    deadLetter: number;
    oldestPendingAgeSeconds: number | null;
  };
  llmReservations: {
    pending: number;
    expiredPending: number;
    oldestPendingAgeSeconds: number;
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
        oldestPendingAgeSeconds: outbox.oldestPendingAgeSeconds,
      },
      llmReservations: {
        pending: reservations.pendingCount,
        expiredPending: reservations.expiredPendingCount,
        oldestPendingAgeSeconds: reservations.oldestPendingAgeSeconds,
      },
    };
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
