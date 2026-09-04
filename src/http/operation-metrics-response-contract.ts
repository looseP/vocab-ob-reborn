import { z } from "zod";
import type { RuntimeMetricsSnapshot } from "../services/runtime-status.service";

export const operationMetricsResponseSchema: z.ZodType<RuntimeMetricsSnapshot> = z.object({
  process: z.object({
    uptimeSeconds: z.number().int().nonnegative(),
    draining: z.boolean(),
  }).strict(),
  database: z.object({
    healthy: z.boolean(),
    totalConnections: z.number().int().nonnegative(),
    idleConnections: z.number().int().nonnegative(),
    waitingRequests: z.number().int().nonnegative(),
  }).strict(),
  outbox: z.object({
    pending: z.number().int().nonnegative(),
    processing: z.number().int().nonnegative(),
    deadLetter: z.number().int().nonnegative(),
    oldestPendingAgeSeconds: z.number().nonnegative().nullable(),
  }).strict(),
  llmReservations: z.object({
    pending: z.number().int().nonnegative(),
    expiredPending: z.number().int().nonnegative(),
    oldestPendingAgeSeconds: z.number().nonnegative(),
  }).strict(),
}).strict();
