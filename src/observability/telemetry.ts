import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { RuntimeMetricsSnapshot } from "../services/runtime-status.service";

const SERVICE_NAME = "vocab_observatory";
export const HTTP_REQUESTS_METRIC_NAME = `${SERVICE_NAME}_http_requests_total`;

export type L3ContextOutcome = "hit" | "miss" | "error";
export type L2VerdictLabel = "passed" | "weak";

export class Telemetry {
  readonly registry = new Registry();
  private readonly httpRequests: Counter<"method" | "route" | "status_class">;
  private readonly httpDuration: Histogram<"method" | "route" | "status_class">;
  private readonly runtimeGauge: Gauge<"metric">;
  /** P2-5: L3 语境命中率（产出步拉到 L3 语境 vs 总查询次数） */
  private readonly l3ContextHits: Counter<"outcome">;
  /** P2-5: L3 语境查询延迟直方图（best-effort 路径下的端到端耗时） */
  private readonly l3ContextDuration: Histogram<"outcome">;
  /** P2-5: L2 产出自评 verdict 计数（按是否带 L3 语境分桶，用于质量对比） */
  private readonly l2ProductionVerdict: Counter<"verdict" | "has_l3_context">;
  /** P2-6: L2→L1 弱信号触发频率（L2 连续 again 触发 L1 重刷） */
  private readonly l2WeakSignalTriggered: Counter<"track">;

  constructor(collectProcessMetrics = true) {
    this.registry.setDefaultLabels({ service: SERVICE_NAME });
    if (collectProcessMetrics) collectDefaultMetrics({ register: this.registry, prefix: `${SERVICE_NAME}_` });

    this.httpRequests = new Counter({
      name: HTTP_REQUESTS_METRIC_NAME,
      help: "Completed HTTP requests by stable route and status class.",
      labelNames: ["method", "route", "status_class"],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: `${SERVICE_NAME}_http_request_duration_seconds`,
      help: "HTTP request latency by stable route and status class.",
      labelNames: ["method", "route", "status_class"],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.runtimeGauge = new Gauge({
      name: `${SERVICE_NAME}_runtime`,
      help: "Runtime operational gauges. The metric label is a bounded enum.",
      labelNames: ["metric"],
      registers: [this.registry],
    });
    // P2-5: L3 语境监控指标（FR-12 接线2 上线后开始采集真实流量）
    this.l3ContextHits = new Counter({
      name: `${SERVICE_NAME}_l3_context_hits_total`,
      help: "L3 context lookup outcomes for L2 production step (hit/miss/error). hit = L3 returned ≥1 snippet; miss = L3 empty; error = lookup failed and was swallowed.",
      labelNames: ["outcome"],
      registers: [this.registry],
    });
    this.l3ContextDuration = new Histogram({
      name: `${SERVICE_NAME}_l3_context_lookup_duration_seconds`,
      help: "End-to-end L3 context lookup duration (including the RLS-scoped transaction).",
      labelNames: ["outcome"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [this.registry],
    });
    this.l2ProductionVerdict = new Counter({
      name: `${SERVICE_NAME}_l2_production_verdict_total`,
      help: "L2 production self-assessment verdicts split by whether the L2 task carried an L3 referenceExample (for A/B quality comparison).",
      labelNames: ["verdict", "has_l3_context"],
      registers: [this.registry],
    });
    this.l2WeakSignalTriggered = new Counter({
      name: `${SERVICE_NAME}_l2_weak_signal_triggered_total`,
      help: "L2→L1 weak-signal cascade triggers. Increments when CrossTrackService detects L2 recent_ratings all-again window and marks L1 progress for re-review.",
      labelNames: ["track"],
      registers: [this.registry],
    });
  }

  observeHttp(method: string, route: string, status: number, durationSeconds: number): void {
    const labels = {
      method: method.toUpperCase(),
      route: route || "unmatched",
      status_class: `${Math.floor(status / 100)}xx`,
    };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, durationSeconds);
  }

  /**
   * P2-5: 记录单次 L3 语境查询的结果 + 耗时。L3ContextSourceAdapter /
   * L2DrillService.fetchContextSnippets 调用。best-effort 路径下 error 也
   * 会被吞掉返回 []，但仍计入此指标以便监控 L3 故障率。
   */
  observeL3ContextLookup(outcome: L3ContextOutcome, durationSeconds: number): void {
    this.l3ContextHits.inc({ outcome });
    this.l3ContextDuration.observe({ outcome }, durationSeconds);
  }

  /**
   * P2-5: 记录 L2 产出自评 verdict + 是否带 L3 语境。
   * 用于监控 L3 语境接入对产出步通过率的影响（A/B 对比）。
   */
  observeL2ProductionVerdict(verdict: L2VerdictLabel, hasL3Context: boolean): void {
    this.l2ProductionVerdict.inc({
      verdict,
      has_l3_context: hasL3Context ? "true" : "false",
    });
  }

  /**
   * P2-6: 记录 L2→L1 弱信号级联触发（L2 连续 again 满足窗口，标记 L1 重刷）。
   * CrossTrackService.checkL2FailureCascade 触发时调用。track='l2' 标记
   * 来源，便于与 review-outbox track='l1' 事件区分。
   */
  observeL2WeakSignalTriggered(): void {
    this.l2WeakSignalTriggered.inc({ track: "l2" });
  }

  setRuntime(snapshot: RuntimeMetricsSnapshot): void {
    const values: Record<string, number> = {
      process_uptime_seconds: snapshot.process.uptimeSeconds,
      process_draining: snapshot.process.draining ? 1 : 0,
      database_healthy: snapshot.database.healthy ? 1 : 0,
      database_connections_total: snapshot.database.totalConnections,
      database_connections_idle: snapshot.database.idleConnections,
      database_waiting_requests: snapshot.database.waitingRequests,
      outbox_pending: snapshot.outbox.pending,
      outbox_processing: snapshot.outbox.processing,
      outbox_dead_letter: snapshot.outbox.deadLetter,
      outbox_oldest_pending_age_seconds: snapshot.outbox.oldestPendingAgeSeconds ?? 0,
      llm_reservations_pending: snapshot.llmReservations.pending,
      llm_reservations_expired_pending: snapshot.llmReservations.expiredPending,
      llm_reservations_oldest_pending_age_seconds: snapshot.llmReservations.oldestPendingAgeSeconds,
    };
    for (const [metric, value] of Object.entries(values)) this.runtimeGauge.set({ metric }, value);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}

export const telemetry = new Telemetry();
