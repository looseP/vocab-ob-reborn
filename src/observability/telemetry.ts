import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { RuntimeMetricsSnapshot } from "../services/runtime-status.service";

const SERVICE_NAME = "vocab_observatory";

export class Telemetry {
  readonly registry = new Registry();
  private readonly httpRequests: Counter<"method" | "route" | "status_class">;
  private readonly httpDuration: Histogram<"method" | "route" | "status_class">;
  private readonly runtimeGauge: Gauge<"metric">;

  constructor(collectProcessMetrics = true) {
    this.registry.setDefaultLabels({ service: SERVICE_NAME });
    if (collectProcessMetrics) collectDefaultMetrics({ register: this.registry, prefix: `${SERVICE_NAME}_` });

    this.httpRequests = new Counter({
      name: `${SERVICE_NAME}_http_requests_total`,
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
