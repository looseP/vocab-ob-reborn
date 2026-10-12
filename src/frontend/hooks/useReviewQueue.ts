/**
 * 复习队列全景（P1，2026-10-10）—— 页面状态hook。
 *
 * 四块状态刻意分开：
 *  - `bucket`：当前分桶（tab）
 *  - `dueWindow`：到期窗口 facet（「今日到期」视图，2026-10-12 加）—— 与 bucket
 *    正交、二者互斥切换（见 `setBucket` / `setDueWindow` 的注释），初始值可来自 URL
 *  - `searchInput` / `query`：搜索框输入态 vs **防抖后**的提交态（输入时不打后端）
 *  - `offset`：`items` 是**累积**的（加载更多追加），刷新才归零
 *
 * 竞态：切桶/改搜索时旧请求可能后到，用单调递增的 seq 丢弃过期响应
 * （否则会出现「点到期、切到新卡，却看到到期的列表」）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  expireReviewCards,
  fetchReviewQueue,
  removeReviewCards,
  type ReviewQueueBucket,
  type ReviewQueueCounts,
  type ReviewQueueDueWindow,
  type ReviewQueueListItem,
} from "@/frontend/api/reviewQueue";

/** 每页 50：桶内几千张时翻 3~4 次就能看完，又不至于一次拉爆 DOM。 */
const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

export interface UseReviewQueueResult {
  bucket: ReviewQueueBucket;
  setBucket: (bucket: ReviewQueueBucket) => void;
  /**
   * 到期窗口 facet（「今日到期」视图）。与 `bucket` 正交：非 null 时清单是
   * `bucket=all + dueWindow`（今天到期的全部卡，不管状态）。深链可分享
   * （仪表盘副标题 → `/review-queue?dueWindow=today`）。
   */
  dueWindow: ReviewQueueDueWindow | null;
  setDueWindow: (dueWindow: ReviewQueueDueWindow | null) => void;
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
  // 「今日到期」facet 支持深链：初始值从 URL 读，进/退时同步写回（replace，不堆历史）。
  const [searchParams, setSearchParams] = useSearchParams();
  const initialDueWindow: ReviewQueueDueWindow | null =
    searchParams.get("dueWindow") === "today" ? "today" : null;
  const [bucket, setBucketState] = useState<ReviewQueueBucket>(initialDueWindow ? "all" : "due");
  const [dueWindow, setDueWindowState] = useState<ReviewQueueDueWindow | null>(initialDueWindow);

  const syncDueWindowParam = useCallback(
    (next: ReviewQueueDueWindow | null) => {
      const params = new URLSearchParams(searchParams);
      if (next) params.set("dueWindow", next);
      else params.delete("dueWindow");
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  /**
   * 切状态桶 ⇒ 清掉 facet。两种是并列的「看法」：facet 的清单跨状态桶（今日到期 = 学习中 +
   * 到期 + 已掌握里今天到点的），若与状态桶叠加，tab 上的计数（facet 全局量）会与清单
   * 对不上 —— 宁可互斥，不要出一个「数字和列表不一致」的混合态。
   */
  const setBucket = useCallback(
    (next: ReviewQueueBucket) => {
      setBucketState(next);
      setDueWindowState(null);
      syncDueWindowParam(null);
    },
    [syncDueWindowParam],
  );

  /** 进「今日到期」⇒ bucket=all + facet；退 ⇒ 回默认的「到期」桶（现在能复习的）。 */
  const setDueWindow = useCallback(
    (next: ReviewQueueDueWindow | null) => {
      setDueWindowState(next);
      setBucketState(next ? "all" : "due");
      syncDueWindowParam(next);
    },
    [syncDueWindowParam],
  );

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
    async (
      nextBucket: ReviewQueueBucket,
      nextQuery: string,
      nextDueWindow: ReviewQueueDueWindow | null,
      offset: number,
      append: boolean,
    ) => {
      const mine = ++seq.current;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      try {
        const res = await fetchReviewQueue({
          bucket: nextBucket,
          dueWindow: nextDueWindow,
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

  // 桶 / 搜索 / facet 变化 ⇒ 归零重载第一页
  useEffect(() => {
    void fetchPage(bucket, query, dueWindow, 0, false);
  }, [bucket, query, dueWindow, fetchPage]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    void fetchPage(bucket, query, dueWindow, offsetRef.current, true);
  }, [bucket, query, dueWindow, hasMore, loadingMore, fetchPage]);

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
        const fresh = await fetchReviewQueue({ bucket, dueWindow, q: query || null, limit: 1, offset: 0 });
        setCounts(fresh.counts);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "操作失败");
      } finally {
        setPendingWordId(null);
      }
    },
    [bucket, dueWindow, query],
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
    dueWindow,
    setDueWindow,
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
