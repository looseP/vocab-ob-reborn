/**
 * 复习队列全景（P1，2026-10-10）—— 页面状态hook。
 *
 * 三块状态刻意分开：
 *  - `bucket`：当前分桶（tab）
 *  - `searchInput` / `query`：搜索框输入态 vs **防抖后**的提交态（输入时不打后端）
 *  - `offset`：`items` 是**累积**的（加载更多追加），刷新才归零
 *
 * 竞态：切桶/改搜索时旧请求可能后到，用单调递增的 seq 丢弃过期响应
 * （否则会出现「点到期、切到新卡，却看到到期的列表」）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  expireReviewCards,
  fetchReviewQueue,
  removeReviewCards,
  type ReviewQueueBucket,
  type ReviewQueueCounts,
  type ReviewQueueListItem,
} from "@/frontend/api/reviewQueue";

/** 每页 50：桶内几千张时翻 3~4 次就能看完，又不至于一次拉爆 DOM。 */
const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

export interface UseReviewQueueResult {
  bucket: ReviewQueueBucket;
  setBucket: (bucket: ReviewQueueBucket) => void;
  searchInput: string;
  setSearchInput: (value: string) => void;
  items: ReviewQueueListItem[];
  counts: ReviewQueueCounts | null;
  /** 过滤后的总行数（≠ items.length：后者是已加载的累积量）。 */
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => void;
  /** 提前到期：把 due_at 提到现在（该卡立刻进池排队）。 */
  expireOne: (wordId: string) => Promise<void>;
  /** 移出队列：物理删进度行（重新加入后 FSRS 从头）。 */
  removeOne: (wordId: string) => Promise<void>;
  /** 正在操作中的 wordId（行内按钮 loading/禁用）。 */
  pendingWordId: string | null;
}

export function useReviewQueue(): UseReviewQueueResult {
  const [bucket, setBucket] = useState<ReviewQueueBucket>("due");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ReviewQueueListItem[]>([]);
  const [counts, setCounts] = useState<ReviewQueueCounts | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingWordId, setPendingWordId] = useState<string | null>(null);

  const seq = useRef(0);
  const offsetRef = useRef(0);

  const fetchPage = useCallback(
    async (nextBucket: ReviewQueueBucket, nextQuery: string, offset: number, append: boolean) => {
      const mine = ++seq.current;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      try {
        const res = await fetchReviewQueue({
          bucket: nextBucket,
          q: nextQuery || null,
          limit: PAGE_SIZE,
          offset,
        });
        if (mine !== seq.current) return; // 已有更新的请求在飞，丢弃本次
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setCounts(res.counts);
        setTotal(res.total);
        setHasMore(res.hasMore);
        setError(null);
        offsetRef.current = offset + res.items.length;
      } catch (err) {
        if (mine !== seq.current) return;
        setError(err instanceof Error ? err.message : "加载队列失败");
      } finally {
        if (mine === seq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [],
  );

  // 搜索防抖：输入时不打后端
  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 桶 / 搜索变化 ⇒ 归零重载第一页
  useEffect(() => {
    void fetchPage(bucket, query, 0, false);
  }, [bucket, query, fetchPage]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    void fetchPage(bucket, query, offsetRef.current, true);
  }, [bucket, query, hasMore, loadingMore, fetchPage]);

  /** 操作成功后：本地摘掉该行，再静默刷新桶计数（不动已加载的分页累积）。 */
  const applyMutation = useCallback(
    async (wordId: string, mutate: (id: string) => Promise<{ count: number }>) => {
      setPendingWordId(wordId);
      try {
        const res = await mutate(wordId);
        if (res.count > 0) {
          setItems((prev) => prev.filter((item) => item.wordId !== wordId));
          setTotal((prev) => Math.max(0, prev - res.count));
        }
        // 计数是 tab 徽标的唯一来源，必须回源（limit=1 只为拿 counts）
        const fresh = await fetchReviewQueue({ bucket, q: query || null, limit: 1, offset: 0 });
        setCounts(fresh.counts);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "操作失败");
      } finally {
        setPendingWordId(null);
      }
    },
    [bucket, query],
  );

  const expireOne = useCallback(
    (wordId: string) => applyMutation(wordId, (id) => expireReviewCards([id])),
    [applyMutation],
  );

  const removeOne = useCallback(
    (wordId: string) => applyMutation(wordId, (id) => removeReviewCards([id])),
    [applyMutation],
  );

  return {
    bucket,
    setBucket,
    searchInput,
    setSearchInput,
    items,
    counts,
    total,
    hasMore,
    loading,
    loadingMore,
    error,
    loadMore,
    expireOne,
    removeOne,
    pendingWordId,
  };
}
