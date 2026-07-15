import { describe, expect, it } from "vitest";
import { operationMetricsResponseSchema } from "@/http/operation-metrics-response-contract";

const validSnapshot = {
  process: { uptimeSeconds: 10, draining: false },
  database: {
    healthy: true,
    totalConnections: 4,
    idleConnections: 2,
    waitingRequests: 0,
  },
  outbox: {
    pending: 1,
    processing: 2,
    deadLetter: 0,
    oldestPendingAgeSeconds: null,
  },
  llmReservations: {
    pending: 3,
    expiredPending: 1,
    oldestPendingAgeSeconds: 12.5,
  },
};

describe("operation metrics response contract", () => {
  it("accepts the complete runtime metrics snapshot", () => {
    expect(operationMetricsResponseSchema.parse(validSnapshot)).toEqual(validSnapshot);
  });

  it.each([
    ["negative uptime", { ...validSnapshot, process: { ...validSnapshot.process, uptimeSeconds: -1 } }],
    ["fractional pool count", { ...validSnapshot, database: { ...validSnapshot.database, totalConnections: 1.5 } }],
    ["negative outbox age", { ...validSnapshot, outbox: { ...validSnapshot.outbox, oldestPendingAgeSeconds: -1 } }],
    ["unknown field", { ...validSnapshot, internal: { secret: true } }],
  ])("rejects %s", (_label, snapshot) => {
    expect(() => operationMetricsResponseSchema.parse(snapshot)).toThrow();
  });

  it("rejects a missing operational component", () => {
    const { llmReservations: _removed, ...missing } = validSnapshot;
    expect(() => operationMetricsResponseSchema.parse(missing)).toThrow();
  });
});
