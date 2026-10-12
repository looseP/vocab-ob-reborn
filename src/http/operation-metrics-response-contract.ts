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
  /**
   * 备份新鲜度。`null` = 还没有成功备份（首部署 / 状态卷未挂）—— 此时不产出指标，
   * 告警规则自然不触发。默认告警阈值见 `docs/operations/alerting-rules.yaml`
   * 的 `VocabBackupStaleLocal`。
   */
  backup: z.object({
    lastSuccessAgeSeconds: z.number().nonnegative().nullable(),
  }).strict(),
}).strict();
