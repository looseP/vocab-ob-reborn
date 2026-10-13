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
    /**
     * 滚动窗口（5 分钟）内新变成死信的数量 —— 告警看这个。
     * `deadLetter` 是历史库存，只用于盘点；拿它做 `> 0` 告警会让 critical 永久亮着
     * （2026-10-12 线上实测 522 条存量）。
     */
    recentDeadLetters: z.number().int().nonnegative(),
    oldestPendingAgeSeconds: z.number().nonnegative().nullable(),
  }).strict(),
  llmReservations: z.object({
    pending: z.number().int().nonnegative(),
    expiredPending: z.number().int().nonnegative(),
    oldestPendingAgeSeconds: z.number().nonnegative(),
  }).strict(),
}).strict();
