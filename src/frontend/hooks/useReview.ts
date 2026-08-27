import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/frontend/api/client";
import { useToast } from "@/frontend/components/ui/Toast";

export interface ReviewCard {
  progressId: string;
  word: {
    id: string;
    slug: string;
    title: string;
    lemma: string;
    short_definition: string | null;
    ipa: string | null;
    pos: string | null;
    cefr: string | null;
  };
  state: string;
  dueAt: string | null;
  lastRating: string | null;
  reviewCount: number;
  l1WeakSignal?: boolean;
  /** 队列优先级元数据（review/zen 模式，P1）。 */
  queueBucket?: string;
  queueLabel?: string;
  queueReason?: string;
  retrievability?: number | null;
}

interface QueueResponse {
  items: ReviewCard[];
  session: { id: string; mode: string; cardsSeen: number };
  stats: { total: number; remaining: number; deferredNewCards?: number };
}

export type Rating = "again" | "hard" | "good" | "easy";

const STATE_LABELS: Record<string, string> = {
  new: "新词",
  learning: "学习中",
  review: "复习中",
  relearning: "重新学习",
  suspended: "已停用",
};

export function labelReviewState(state: string): string {
  return STATE_LABELS[state] ?? state;
}

/** 幂等键：防评分请求快速连点/网络重试导致 review_logs 双写。 */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 最近一次已提交评分（撤销目标）。undo RPC 仅支持带 previous_snapshot 的 answer 日志。 */
interface LastAnswer {
  card: ReviewCard;
  rating: Rating;
  reviewLogId: string;
  /** 提交前的 currentIndex，撤销后回退到这里。 */
  indexBefore: number;
}

/**
 * 会话级缓存 key：避免"查看详情 → 返回"后复习队列被重置。
 * 按 (mode, wordIds) 分桶，不同模式/勾选集合的会话互不污染。
 * TTL = 30min，浏览器关闭或标签页关闭自动清理（sessionStorage 语义）。
 */
const STORAGE_PREFIX = "vocab:review:session:";
const STORAGE_TTL_MS = 30 * 60 * 1000;

interface PersistedSession {
  mode: string;
  wordIdsKey: string; // "" 或逗号分隔的 wordIds
  sessionId: string | null;
  queue: ReviewCard[];
  currentIndex: number;
  stats: { reviewed: number; again: number; hard: number; good: number; easy: number };
  deferredNewCards: number;
  completed: boolean;
  /** 本会话跳过的卡数（完成页区分"已评分/跳过/挂起"）。旧缓存无此字段时按 0 处理。 */
  skipped?: number;
  suspended?: number;
  savedAt: number;
}

function cacheKey(mode: string, wordIds?: string[]): string {
  const idsKey = (wordIds ?? []).join(",");
  return `${STORAGE_PREFIX}${mode}::${idsKey}`;
}

function readCache(mode: string, wordIds?: string[]): PersistedSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(cacheKey(mode, wordIds));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (Date.now() - (parsed.savedAt ?? 0) > STORAGE_TTL_MS) {
      sessionStorage.removeItem(cacheKey(mode, wordIds));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(session: Omit<PersistedSession, "savedAt"> & { wordIds?: string[] }): void {
  if (typeof window === "undefined") return;
  try {
    const key = cacheKey(session.mode, session.wordIds);
    const payload: PersistedSession = { ...session, savedAt: Date.now() };
    delete (payload as { wordIds?: string[] }).wordIds;
    sessionStorage.setItem(key, JSON.stringify(payload));
  } catch {
    /* quota / private mode: 静默失败，行为退化为无缓存 */
  }
}

function clearCache(mode: string, wordIds?: string[]): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(cacheKey(mode, wordIds));
  } catch {
    /* ignore */
  }
}

/** 清除所有过期的复习会话缓存，避免 sessionStorage 长期堆积碎片。 */
function sweepExpiredCache(): void {
  if (typeof window === "undefined") return;
  try {
    const now = Date.now();
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      const raw = sessionStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as PersistedSession;
      if (now - (parsed.savedAt ?? 0) > STORAGE_TTL_MS) {
        sessionStorage.removeItem(key);
      }
    }
  } catch {
    /* ignore */
  }
}

export function useReview() {
  const [queue, setQueue] = useState<ReviewCard[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<string>("review");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 });
  const [deferredNewCards, setDeferredNewCards] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [suspended, setSuspended] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [lastAnswer, setLastAnswer] = useState<LastAnswer | null>(null);
  /** 本次会话对应的 wordIds（startReview 时记录），用于缓存分桶。 */
  const wordIdsRef = useRef<string[] | undefined>(undefined);
  const { addToast } = useToast();

  const currentCard = !completed && currentIndex < queue.length ? queue[currentIndex] : null;
  const remaining = Math.max(0, queue.length - currentIndex);

  const startReview = useCallback(async (mode: string = "review", wordIds?: string[], options?: { force?: boolean }) => {
    // 先尝试命中缓存：同 mode + 同 wordIds 分桶，且 TTL 内有效。
    // force=true 时绕过缓存（用户主动"开始/重启"）。
    wordIdsRef.current = wordIds;
    sweepExpiredCache();
    if (!options?.force) {
      const cached = readCache(mode, wordIds);
      if (cached && cached.queue.length > 0) {
        setMode(cached.mode);
        setQueue(cached.queue);
        setSessionId(cached.sessionId);
        setCurrentIndex(cached.currentIndex);
        setStats(cached.stats);
        setDeferredNewCards(cached.deferredNewCards);
        setSkipped(cached.skipped ?? 0);
        setSuspended(cached.suspended ?? 0);
        setCompleted(cached.completed);
        setError(null);
        setLastAnswer(null);
        addToast("info", `已恢复复习会话（进度 ${cached.stats.reviewed}/${cached.queue.length}）`);
        return;
      }
    }
    setLoading(true);
    setError(null);
    setCompleted(false);
    setMode(mode);
    setCurrentIndex(0);
    setDeferredNewCards(0);
    setSkipped(0);
    setSuspended(0);
    setLastAnswer(null);
    setStats({ reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 });
    clearCache(mode, wordIds);
    try {
      const params = new URLSearchParams({ limit: "20", mode });
      if (wordIds && wordIds.length > 0) {
        params.set("wordIds", wordIds.join(","));
      }
      const result = await apiFetch<QueueResponse>(`/review/queue?${params.toString()}`);
      if (!result.items || result.items.length === 0) {
        setError("没有待复习的单词");
        setQueue([]);
        setSessionId(null);
        return;
      }
      setQueue(result.items);
      setSessionId(result.session.id);
      if (typeof result.stats?.deferredNewCards === "number") {
        setDeferredNewCards(result.stats.deferredNewCards);
      }
      addToast("info", `已加载 ${result.items.length} 张复习卡片`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载复习队列失败");
      setQueue([]);
      setSessionId(null);
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  // toast action 的 onClick 在创建时闭包固定，用 ref 保证拿到最新 undoLast（见下方 undoLast）
  const undoRef = useRef<() => void>(() => {});

  /**
   * 忙碌锁（ref 级）：串行化会推进队列/写服务器状态的互斥操作。
   * 评分/撤销/跳过/挂起/清弱信号必须互斥执行，否则快速连点会在同一事件循环内
   * 绕过 state 的 loading 判断（setState 异步），导致同卡双写评分等数据污染。
   * 忙碌期间的后续调用直接丢弃（不是排队）。
   */
  const busyRef = useRef(false);

  const answer = useCallback(async (rating: Rating) => {
    if (!currentCard || !sessionId) return;
    if (busyRef.current) return;
    busyRef.current = true;
    const idempotencyKey = newIdempotencyKey();
    setLoading(true);
    try {
      const result = await apiFetch<{ ok: boolean; reviewLogId?: string; idempotent?: boolean }>("/review/answer", {
        method: "POST",
        body: JSON.stringify({
          rating,
          progressId: currentCard.progressId,
          sessionId,
          mode,
          idempotencyKey,
        }),
      });
      // cram 返回合成 reviewLogId，服务端无日志可撤销；仅真实评分记录撤销目标
      if (typeof result.reviewLogId === "string" && !result.reviewLogId.startsWith("cram-")) {
        setLastAnswer({ card: currentCard, rating, reviewLogId: result.reviewLogId, indexBefore: currentIndex });
      }
      setStats((prev) => ({
        reviewed: prev.reviewed + 1,
        again: prev.again + (rating === "again" ? 1 : 0),
        hard: prev.hard + (rating === "hard" ? 1 : 0),
        good: prev.good + (rating === "good" ? 1 : 0),
        easy: prev.easy + (rating === "easy" ? 1 : 0),
      }));
      const next = currentIndex + 1;
      if (next >= queue.length) {
        setCompleted(true);
        addToast("success", mode === "cram" ? "练习完成！本次评分未写入复习数据" : "复习完成！FSRS 调度已更新");
      } else {
        setCurrentIndex(next);
        if (mode !== "cram") {
          addToast("info", `已记录「${currentCard.word.lemma}」评分`, {
            duration: 8000,
            action: { label: "撤销", onClick: () => void undoRef.current() },
          });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "评分失败");
      addToast("error", "评分提交失败");
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [currentCard, sessionId, currentIndex, queue.length, addToast, mode]);

  /** 撤销最近一次评分：服务端恢复 FSRS 快照，前端把卡片退回队首并回滚统计。 */
  const undoLast = useCallback(async () => {
    if (!lastAnswer || !sessionId) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    try {
      await apiFetch("/review/undo", {
        method: "POST",
        body: JSON.stringify({
          reviewLogId: lastAnswer.reviewLogId,
          sessionId,
          idempotencyKey: newIdempotencyKey(),
        }),
      });
      setLastAnswer(null);
      setCompleted(false);
      setCurrentIndex(lastAnswer.indexBefore);
      setStats((prev) => ({
        reviewed: Math.max(0, prev.reviewed - 1),
        again: Math.max(0, prev.again - (lastAnswer.rating === "again" ? 1 : 0)),
        hard: Math.max(0, prev.hard - (lastAnswer.rating === "hard" ? 1 : 0)),
        good: Math.max(0, prev.good - (lastAnswer.rating === "good" ? 1 : 0)),
        easy: Math.max(0, prev.easy - (lastAnswer.rating === "easy" ? 1 : 0)),
      }));
      addToast("success", `已撤销「${lastAnswer.card.word.lemma}」，卡片回到队首`);
    } catch (err) {
      // 已被撤销过/非最新日志等情况：目标不再有效，清掉避免死循环重试
      setLastAnswer(null);
      addToast("error", err instanceof Error ? err.message : "撤销失败");
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [lastAnswer, sessionId, addToast]);

  // 每次渲染刷新 ref，使 toast action 永远调到最新闭包
  undoRef.current = () => void undoLast();

  /**
   * 消费侧栏"历史记录"中某条撤销请求（已在 ReviewHistoryDrawer 中发过 /review/undo），
   * 前端做本地状态回滚：卡片进度、统计、lastAnswer。
   * 约定：允许在无 lastAnswer 时调用（例如从详情返回 lastAnswer 被清，但服务端仍可撤回最新日志）。
   */
  const applyHistoryUndo = useCallback(async (entry: { rating: string; reviewLogId: string; word_slug: string; word_lemma: string }) => {
    // 重要：ReviewHistoryDrawer 自己先 POST 了 /review/undo，然后才调用这个回调。
    // 因此这里绝对不能再次调用 undoLast()（会重复撤销，后端报错，stats 回滚也会 skip）。
    // 只需做本地状态回滚：递减 reviewed 与对应 rating；若命中 lastAnswer 则使用其 indexBefore 精确回退。
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const rating = entry.rating as typeof entry.rating & ("again" | "hard" | "good" | "easy");
      const matchedLast = lastAnswer && lastAnswer.reviewLogId === entry.reviewLogId;
      const prevCard = matchedLast ? lastAnswer.card.word.lemma : entry.word_lemma;
      setLastAnswer(null);
      setCompleted(false);
      setCurrentIndex((prev) => {
        if (matchedLast) {
          return (lastAnswer as NonNullable<typeof lastAnswer>).indexBefore;
        }
        return Math.max(0, prev - 1);
      });
      setStats((prev) => ({
        reviewed: Math.max(0, prev.reviewed - 1),
        again: Math.max(0, prev.again - (rating === "again" ? 1 : 0)),
        hard: Math.max(0, prev.hard - (rating === "hard" ? 1 : 0)),
        good: Math.max(0, prev.good - (rating === "good" ? 1 : 0)),
        easy: Math.max(0, prev.easy - (rating === "easy" ? 1 : 0)),
      }));
      addToast("success", matchedLast
        ? `已撤销「${prevCard}」，卡片回到队首`
        : `已撤销「${entry.word_lemma}」的评分，可重新评分`);
    } finally {
      busyRef.current = false;
    }
  }, [lastAnswer, addToast]);

  /** 跳过当前卡：持久化 skip 日志（幂等），再本地推进。 */
  const skip = useCallback(() => {
    if (!currentCard) return;
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      if (sessionId && mode !== "cram") {
        void apiFetch("/review/skip", {
          method: "POST",
          body: JSON.stringify({
            progressId: currentCard.progressId,
            sessionId,
            idempotencyKey: newIdempotencyKey(),
          }),
        }).catch(() => addToast("warning", "跳过未能同步到服务器"));
      }
      setLastAnswer(null);
      setSkipped((prev) => prev + 1);
      const next = currentIndex + 1;
      if (next >= queue.length) {
        setCompleted(true);
      } else {
        setCurrentIndex(next);
      }
    } finally {
      busyRef.current = false;
    }
  }, [currentCard, sessionId, mode, currentIndex, queue.length, addToast]);

  /** 挂起当前卡：该词退出复习调度（state=suspended），本地推进。 */
  const suspendCurrent = useCallback(async () => {
    if (!currentCard) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    try {
      await apiFetch("/review/suspend", {
        method: "POST",
        body: JSON.stringify({
          progressId: currentCard.progressId,
          ...(sessionId ? { sessionId } : {}),
          idempotencyKey: newIdempotencyKey(),
        }),
      });
      setLastAnswer(null);
      setSuspended((prev) => prev + 1);
      addToast("success", `已挂起「${currentCard.word.lemma}」，不再进入复习队列`);
      const next = currentIndex + 1;
      if (next >= queue.length) {
        setCompleted(true);
      } else {
        setCurrentIndex(next);
      }
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "挂起失败");
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [currentCard, sessionId, currentIndex, queue.length, addToast]);

  // Preview (自由浏览) navigation — pure browsing, no rating, no persistence.
  const browseNext = useCallback(() => {
    setCurrentIndex((index) => Math.min(index + 1, queue.length - 1));
  }, [queue.length]);

  const browsePrev = useCallback(() => {
    setCurrentIndex((index) => Math.max(index - 1, 0));
  }, []);

  const clearWeakSignal = useCallback(async (wordId: string) => {
    if (!currentCard) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    try {
      await apiFetch("/review/weak-signal/clear", {
        method: "POST",
        body: JSON.stringify({ wordId }),
      });
      setQueue((prev) => prev.map((c) =>
        c.word.id === wordId ? { ...c, l1WeakSignal: false } : c,
      ));
      addToast("success", "已清除弱信号标记");
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "清除弱信号失败");
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [currentCard, addToast]);

  /**
   * 每当会话的核心进度变化，同步写入 sessionStorage。
   * 缓存只在真实加载过队列后才写；未开始会话（queue 空）不写。
   */
  useEffect(() => {
    if (!queue.length && !sessionId) return;
    writeCache({
      mode,
      wordIds: wordIdsRef.current,
      wordIdsKey: (wordIdsRef.current ?? []).join(","),
      sessionId,
      queue,
      currentIndex,
      stats,
      deferredNewCards,
      skipped,
      suspended,
      completed,
    });
  }, [mode, sessionId, queue, currentIndex, stats, deferredNewCards, skipped, suspended, completed]);

  return {
    currentCard,
    queue,
    mode,
    sessionId,
    loading,
    error,
    stats,
    deferredNewCards,
    skipped,
    suspended,
    completed,
    currentIndex,
    remaining,
    /** 最近一次可撤销的评分（null = 无可撤销项）。 */
    lastAnswer,
    startReview,
    answer,
    skip,
    suspendCurrent,
    undoLast,
    applyHistoryUndo,
    browseNext,
    browsePrev,
    clearWeakSignal,
  };
}
