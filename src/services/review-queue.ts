/**
 * ReviewQueue —— 标准复习队列优先级构建器（P1）。
 *
 * 对齐原项目 vocab-observatory 的 buildReviewQueueBatch 语义，让 v2 的
 * review/zen 队列不再只是简单的 due_at 排序：
 * - 优先级分桶：needs_recheck / learning / review / new
 * - 排序键：stateRank → 预测回忆率风险(1-retrievability 降序) →
 *   逾期时长(降序) → due_at(升序) → review_count(升序)
 * - 新卡配额限制：每批新卡不超过 MAX_NEW_CARDS_PER_BATCH 张且占比不超过
 *   MAX_NEW_CARD_SHARE，超额新卡 defer（deferredNewCards），避免新卡挤占
 *   到期复习。
 *
 * 纯函数模块：无 DB 访问、无副作用，便于单元测试。
 */

import { getCurrentRetrievability, DEFAULT_DESIRED_RETENTION } from "../fsrs";
import type { StoredSchedulerCard } from "../fsrs";
import type { ReviewState } from "../domain";

export const REVIEW_QUEUE_CANDIDATE_LIMIT = 200;
export const REVIEW_QUEUE_BATCH_LIMIT = 20;
export const MAX_NEW_CARDS_PER_BATCH = 8;
export const MAX_NEW_CARD_SHARE = 0.4;

export type ReviewQueuePriorityBucket = "learning" | "at-risk" | "overdue" | "new";

/** 构建器所需的候选卡字段（progress 行的子集）。 */
export interface ReviewQueueCandidate {
  state: ReviewState;
  due_at: string | null;
  review_count: number;
  desired_retention: number | null;
  scheduler_payload: unknown;
  needs_recheck?: boolean;
}

export interface ReviewQueuePriorityDetails {
  bucket: ReviewQueuePriorityBucket;
  label: string;
  reason: string;
  retrievability: number | null;
}

export interface PrioritizedReviewQueueCandidate<T extends ReviewQueueCandidate> {
  item: T;
  priority: ReviewQueuePriorityDetails;
}

export interface ReviewQueueBatch<T extends ReviewQueueCandidate> {
  /** 因新卡配额被推迟到后续批次的新卡数量。 */
  deferredNewCards: number;
  /** 配额过滤后还有剩余卡片可继续分页（offset+items.length < eligible.length）。 */
  hasMore: boolean;
  /** 配额过滤后全部可入选卡数（跨页一致，供客户端估算总进度）。 */
  eligibleTotal: number;
  items: PrioritizedReviewQueueCandidate<T>[];
}

interface QueuePrioritySnapshot extends ReviewQueuePriorityDetails {
  dueTimestamp: number;
  overdueMs: number;
  retrievabilityRisk: number;
  reviewCount: number;
  stateRank: number;
}

/** Recheck 卡无论底层状态一律提权到最高层级（内容已变更需先重看）。 */
function getStateRank(state: ReviewState, needsRecheck?: boolean): number {
  if (needsRecheck) return 0;
  switch (state) {
    case "learning":
    case "relearning":
      return 0;
    case "review":
      return 1;
    case "new":
      return 2;
    default:
      return 3;
  }
}

function getDueTimestamp(dueAt: string | null): number {
  if (!dueAt) return Number.POSITIVE_INFINITY;
  const timestamp = new Date(dueAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function formatOverdueWindow(overdueMs: number): string {
  if (overdueMs < 60 * 60 * 1000) return "<1h";
  if (overdueMs < 24 * 60 * 60 * 1000) return `${Math.round(overdueMs / (60 * 60 * 1000))}h`;
  return `${Math.round(overdueMs / (24 * 60 * 60 * 1000))}d`;
}

function formatRecallPercent(retrievability: number): string {
  return `${Math.max(0, Math.min(100, Math.round(retrievability * 100)))}%`;
}

function describeQueuePriority(
  candidate: ReviewQueueCandidate,
  overdueMs: number,
  retrievability: number | null,
): Pick<QueuePrioritySnapshot, "bucket" | "label" | "reason" | "retrievability"> {
  if (candidate.needs_recheck) {
    return {
      bucket: "learning",
      label: "重新核对",
      reason: "内容已更新，请重看",
      retrievability,
    };
  }

  if (candidate.state === "learning" || candidate.state === "relearning") {
    return {
      bucket: "learning",
      label: candidate.state === "relearning" ? "重新学习" : "学习中",
      reason: "短期卡片优先于成熟复习",
      retrievability,
    };
  }

  if (candidate.state === "new") {
    return {
      bucket: "new",
      label: "新卡片",
      reason: "新卡以小批量穿插在到期复习之后",
      retrievability: null,
    };
  }

  if (typeof retrievability === "number" && retrievability <= 0.6) {
    return {
      bucket: "at-risk",
      label: "风险提示",
      reason:
        overdueMs > 0
          ? `预测回忆率 ${formatRecallPercent(retrievability)}，已逾期 ${formatOverdueWindow(overdueMs)}`
          : `预测回忆率 ${formatRecallPercent(retrievability)}`,
      retrievability,
    };
  }

  return {
    bucket: "overdue",
    label: "到期复习",
    reason: overdueMs > 0 ? `已到期 ${formatOverdueWindow(overdueMs)}` : "到期",
    retrievability,
  };
}

function getQueuePrioritySnapshot(
  candidate: ReviewQueueCandidate,
  now: Date,
  weights?: readonly number[] | null,
): QueuePrioritySnapshot {
  const dueTimestamp = getDueTimestamp(candidate.due_at);
  const nowTimestamp = now.getTime();
  const overdueMs =
    Number.isFinite(dueTimestamp) && dueTimestamp !== Number.POSITIVE_INFINITY
      ? Math.max(nowTimestamp - dueTimestamp, 0)
      : 0;
  const retrievability = getCurrentRetrievability(
    candidate.scheduler_payload as StoredSchedulerCard | null | undefined,
    now,
    candidate.desired_retention ?? DEFAULT_DESIRED_RETENTION,
    weights,
  );
  const details = describeQueuePriority(candidate, overdueMs, retrievability);

  return {
    ...details,
    dueTimestamp,
    overdueMs,
    retrievabilityRisk:
      typeof retrievability === "number" && Number.isFinite(retrievability)
        ? 1 - retrievability
        : 0,
    reviewCount: candidate.review_count,
    stateRank: getStateRank(candidate.state, candidate.needs_recheck),
  };
}

function sortScoredReviewQueueItems<T extends ReviewQueueCandidate>(
  items: Array<{ item: T; priority: QueuePrioritySnapshot }>,
) {
  return items.sort((left, right) => {
    if (left.priority.stateRank !== right.priority.stateRank) {
      return left.priority.stateRank - right.priority.stateRank;
    }
    if (left.priority.retrievabilityRisk !== right.priority.retrievabilityRisk) {
      return right.priority.retrievabilityRisk - left.priority.retrievabilityRisk;
    }
    if (left.priority.overdueMs !== right.priority.overdueMs) {
      return right.priority.overdueMs - left.priority.overdueMs;
    }
    if (left.priority.dueTimestamp !== right.priority.dueTimestamp) {
      return left.priority.dueTimestamp - right.priority.dueTimestamp;
    }
    return left.priority.reviewCount - right.priority.reviewCount;
  });
}

function getMaxNewCardsPerBatch(limit: number): number {
  return Math.max(
    1,
    Math.min(MAX_NEW_CARDS_PER_BATCH, Math.ceil(limit * MAX_NEW_CARD_SHARE)),
  );
}

function scoreReviewQueueItems<T extends ReviewQueueCandidate>(
  items: T[],
  now = new Date(),
  weights?: readonly number[] | null,
) {
  return sortScoredReviewQueueItems(
    items.map((item) => ({
      item,
      priority: getQueuePrioritySnapshot(item, now, weights),
    })),
  );
}

/** 仅排序，不施加新卡配额（供测试/复用）。 */
export function prioritizeReviewQueueItems<T extends ReviewQueueCandidate>(
  items: T[],
  now = new Date(),
  weights?: readonly number[] | null,
): T[] {
  return scoreReviewQueueItems(items, now, weights).map(({ item }) => item);
}

/**
 * 构建单批复习队列：按优先级排序 + 新卡配额限制。
 * 支持 offset 分页：先对整个候选池施加配额得到"可入选"列表，再按
 * offset/limit 切片，保证跨页配额一致（新卡占比不会因分页被放大）。
 * 返回选中项（含优先级元数据）与因配额被推迟的新卡数。
 */
export function buildReviewQueueBatch<T extends ReviewQueueCandidate>(
  items: T[],
  now = new Date(),
  limit = REVIEW_QUEUE_BATCH_LIMIT,
  weights?: readonly number[] | null,
  offset = 0,
): ReviewQueueBatch<T> {
  const sorted = scoreReviewQueueItems(items, now, weights);
  const maxNewCards = getMaxNewCardsPerBatch(limit);

  const eligible: PrioritizedReviewQueueCandidate<T>[] = [];
  let selectedNewCards = 0;

  for (const entry of sorted) {
    if (entry.item.state === "new" && !entry.item.needs_recheck) {
      if (selectedNewCards >= maxNewCards) {
        continue;
      }
      selectedNewCards += 1;
    }
    eligible.push({
      item: entry.item,
      priority: {
        bucket: entry.priority.bucket,
        label: entry.priority.label,
        reason: entry.priority.reason,
        retrievability: entry.priority.retrievability,
      },
    });
  }

  const page = eligible.slice(offset, offset + limit);
  const totalNewCards = sorted.filter(
    (entry) => entry.item.state === "new" && !entry.item.needs_recheck,
  ).length;

  return {
    deferredNewCards: Math.max(totalNewCards - selectedNewCards, 0),
    hasMore: offset + page.length < eligible.length,
    eligibleTotal: eligible.length,
    items: page,
  };
}
