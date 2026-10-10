/**
 * ReviewQueue —— 标准复习队列优先级构建器（P1）。
 *
 * 对齐原项目 vocab-observatory 的 buildReviewQueueBatch 语义，让 v2 的
 * review/zen 队列不再只是简单的 due_at 排序：
 * - 优先级分桶：needs_recheck / learning / review / new
 * - 排序键：stateRank → 预测回忆率风险(1-retrievability 降序) →
 *   逾期时长(降序) → due_at(升序) → review_count(升序)
 * - **通道隔离**（2026-10-10，见 ReviewQueueChannel）：新学与到期复习是两条
 *   独立通道，候选池阶段就分开，不再靠配额事后筛。
 * - 新卡配额：仅作用于 new 通道 / 未隔离的混流池，控制单次新学的认知负荷。
 *
 * 纯函数模块：无 DB 访问、无副作用，便于单元测试。
 */

import { getCurrentRetrievability, DEFAULT_DESIRED_RETENTION } from "../fsrs";
import type { StoredSchedulerCard } from "../fsrs";
import { isNewChannelState, isReviewChannelState } from "../domain";
import type { ReviewQueueChannel, ReviewState } from "../domain";

/**
 * 候选快照宽度（阶段一）。
 *
 * 两阶段取数让这个值可以远大于旧实现的 200：阶段一只取 user_word_progress
 * 的窄列 + words 的两个 content hash（needs_recheck 读时派生用），阶段二只水合
 * 当前批的 20 张 word 详情。内存不再随池宽乘以 word 大字段（examples/metadata），
 * 因此单会话可连续翻完上千张到期卡，不必「退出重进」刷新候选池。
 */
export const REVIEW_QUEUE_CANDIDATE_LIMIT = 2000;
/**
 * 快照余量：会话 offset 超过基础宽度时自动扩窗（offset + margin），
 * 保证任意深翻都取得到切片区间 —— 2000 不是硬上限，只是默认窗口。
 */
export const REVIEW_QUEUE_SNAPSHOT_MARGIN = 200;
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
      // 2026-10-10：新学/复习隔离后，新卡**不再穿插**在到期复习队列里，而是走
      // 独立的 new 通道。这句文案只会在通道未隔离的调用方（练习模式）出现。
      reason: "新卡以小批量出现在新词通道",
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
 * 复习通道（2026-10-10 新学/复习隔离）。类型定义在 domain（`ReviewQueueChannel`），
 * 这里只做队列侧的语义化封装。
 *
 * 背景与设计理由见 `src/domain/index.ts` 的同名类型注释；一句话版本：
 * 新卡与到期复习是**两条独立通道**（构造性隔离：候选池阶段就分开），
 * 而非靠配额事后筛。
 */
/**
 * 候选是否属于复习通道。**与仓储的 SQL 谓词同口径**（复用 domain 的
 * `isReviewChannelState`，避免两处枚举漂移）：已作答过的卡（短循环 + 到期成熟卡），
 * 外加内容已变更需重看的 needs_recheck 卡。
 *
 * 注意 learning/relearning **属于复习通道** —— 它们和到期复习共享同一套
 * 「记得/忘了」的判断动作，认知负荷一致，拆开反而割裂。真正的隔离线在
 * 「从未作答」vs「已作答过」。
 */
export function isInReviewChannel(candidate: ReviewQueueCandidate): boolean {
  return isReviewChannelState(candidate.state, candidate.needs_recheck);
}

export function isInNewChannel(candidate: ReviewQueueCandidate): boolean {
  return isNewChannelState(candidate.state, candidate.needs_recheck);
}

/** 候选集是否属于某通道（null = 不限，用于练习模式与旧调用方兼容）。 */
export function matchesChannel(
  candidate: ReviewQueueCandidate,
  channel: ReviewQueueChannel | null,
): boolean {
  if (channel === null) return true;
  return channel === "new" ? isInNewChannel(candidate) : isInReviewChannel(candidate);
}

/**
 * 新卡配额（2026-10-10 隔离后**只对未隔离的混流池生效**）。
 *
 * 旧口径（每批 8 张 + 占比 0.4）是「挤在一条队列里怕新卡挤占复习」的补丁；通道隔离后
 * 复习不再与新卡争位置，这个配额对 review 通道已无意义（池里本就没有新卡）。
 *
 * **刻意不给 new 通道设默认配额**：新词的学习量已由 `dailyReviewLimit` 的**独立**
 * 新词额度闸门管（默认 20 个/天），那才是用户可感知的旋钮。若这里再按池截断，
 * `eligibleTotal` 会被钉死成配额值、`hasMore` 恒为 false —— 分页直接失效，
 * 连带废掉「池宽 2000 可连续翻完上千张」的两阶段取数成果。
 * 需要临时缩小单次新学量时，走 `maxNewCards` 显式参数。
 */
export const DEFAULT_MIXED_POOL_NEW_CARD_QUOTA = 8;

/**
 * 构建单批复习队列：**按通道隔离** + 优先级排序 + 新卡配额限制。
 *
 * 支持 offset 分页：先对整个候选池施加通道过滤与配额得到"可入选"列表，再按
 * offset/limit 切片，保证跨页配额一致（新卡占比不会因分页被放大）。
 * 返回选中项（含优先级元数据）与因配额被推迟的新卡数。
 *
 * @param channel 通道；`null` = 不做通道隔离（练习模式 / 旧调用方），
 *   此时行为与隔离前完全一致（配额仍作用于混流池）。
 * @param maxNewCards 新卡配额上限；仅当池中确实混有新卡（`new` 通道或 `null`）时生效。
 *   未传时：`null` 通道用旧口径（`getMaxNewCardsPerBatch`），`new` 通道**不限**
 *   （额度由每日新词闸门管，见 DEFAULT_MIXED_POOL_NEW_CARD_QUOTA 注释）。
 */
export function buildReviewQueueBatch<T extends ReviewQueueCandidate>(
  items: T[],
  now = new Date(),
  limit = REVIEW_QUEUE_BATCH_LIMIT,
  weights?: readonly number[] | null,
  offset = 0,
  channel: ReviewQueueChannel | null = null,
  maxNewCards?: number,
): ReviewQueueBatch<T> {
  const sorted = scoreReviewQueueItems(items, now, weights);
  // 通道隔离优先：候选池阶段就分开，而不是靠配额事后筛。
  const pooled = channel === null ? sorted : sorted.filter((entry) => matchesChannel(entry.item, channel));
  // 配额只在「池里真的混有新卡」时才有意义；review 通道里新卡为 0，配额不参与。
  // new 通道默认不限：设默认配额会把 eligibleTotal 钉死成配额值 ⇒ hasMore 恒 false
  // ⇒ 分页失效（连带废掉两阶段取数的池宽 2000 成果）。用户可感的旋钮是每日新词额度。
  const quota =
    maxNewCards ??
    (channel === "new" ? Number.POSITIVE_INFINITY : getMaxNewCardsPerBatch(limit));
  const eligible: PrioritizedReviewQueueCandidate<T>[] = [];
  let selectedNewCards = 0;

  for (const entry of pooled) {
    if (isInNewChannel(entry.item)) {
      if (selectedNewCards >= quota) {
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
  const totalNewCards = pooled.filter(
    (entry) => isInNewChannel(entry.item),
  ).length;

  return {
    deferredNewCards: Math.max(totalNewCards - selectedNewCards, 0),
    hasMore: offset + page.length < eligible.length,
    eligibleTotal: eligible.length,
    items: page,
  };
}
