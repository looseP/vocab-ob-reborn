/**
 * 复习队列全景（P1，2026-10-10）—— 前端 API 层。
 *
 * 此前用户没有任何入口能看到「队列里到底有哪些词」：只有仪表盘的数字、集合页的
 * 计数、复习日历未来侧按天点开。本模块给队列页提供「桶计数 + 分页清单 + 行内操作」。
 *
 * 行内操作复用已交付的 `/api/review/cards/{remove,expire}`（P1 队列编辑）——
 * 于是队列页同时做到「看得见」与「管得了」，不必先去词条详情页。
 */
import { apiFetch } from "./client";

/** 与后端 `reviewQueueListQuerySchema` 的 bucket 枚举一一对应（互斥桶，见仓储 JSDoc）。 */
export type ReviewQueueBucket = "all" | "due" | "learning" | "review" | "new" | "suspended";

export interface ReviewQueueCounts {
  due: number;
  learning: number;
  review: number;
  new: number;
  suspended: number;
  /** 非挂起、非新卡、已到期（= learning + due）：「现在就该复习」的张数。 */
  dueNow: number;
  total: number;
}

export interface ReviewQueueListItem {
  wordId: string;
  slug: string;
  title: string;
  lemma: string;
  shortDefinition: string | null;
  pos: string | null;
  cefr: string | null;
  state: "new" | "learning" | "review" | "relearning" | "suspended";
  dueAt: string | null;
  reviewCount: number;
  lapseCount: number;
  stability: number | null;
  intervalDays: number | null;
  lastReviewedAt: string | null;
  lastRating: "again" | "hard" | "good" | "easy" | null;
  /** ADR-0021：词条内容已更新，这张卡需要重看。 */
  needsRecheck: boolean;
}

export interface ReviewQueueListResponse {
  counts: ReviewQueueCounts;
  items: ReviewQueueListItem[];
  /** 过滤（桶 + 搜索）后的总行数。 */
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface ReviewQueueListParams {
  bucket?: ReviewQueueBucket;
  /** lemma / title 子串搜索；空白视作无搜索。 */
  q?: string | null;
  limit?: number;
  offset?: number;
}

export async function fetchReviewQueue(
  params: ReviewQueueListParams = {},
): Promise<ReviewQueueListResponse> {
  const query = new URLSearchParams();
  if (params.bucket) query.set("bucket", params.bucket);
  if (params.q?.trim()) query.set("q", params.q.trim());
  query.set("limit", String(params.limit ?? 50));
  query.set("offset", String(params.offset ?? 0));
  return apiFetch<ReviewQueueListResponse>(`/api/review/queue/list?${query.toString()}`);
}

/** 移出复习队列（物理删进度行 + 审计；未命中幂等零行）。 */
export async function removeReviewCards(wordIds: string[]): Promise<{ ok: boolean; count: number }> {
  return apiFetch<{ ok: boolean; count: number }>("/api/review/cards/remove", {
    method: "POST",
    body: JSON.stringify({ wordIds }),
  });
}

/** 提前到期（只提前、从不延后；挂起词不动）。 */
export async function expireReviewCards(wordIds: string[]): Promise<{ ok: boolean; count: number }> {
  return apiFetch<{ ok: boolean; count: number }>("/api/review/cards/expire", {
    method: "POST",
    body: JSON.stringify({ wordIds }),
  });
}
