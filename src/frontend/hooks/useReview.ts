import { useCallback, useRef, useState } from "react";
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

export function useReview() {
  const [queue, setQueue] = useState<ReviewCard[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<string>("review");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 });
  const [deferredNewCards, setDeferredNewCards] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [lastAnswer, setLastAnswer] = useState<LastAnswer | null>(null);
  const { addToast } = useToast();

  const currentCard = !completed && currentIndex < queue.length ? queue[currentIndex] : null;
  const remaining = Math.max(0, queue.length - currentIndex);

  const startReview = useCallback(async (mode: string = "review", wordIds?: string[]) => {
    setLoading(true);
    setError(null);
    setCompleted(false);
    setMode(mode);
    setCurrentIndex(0);
    setDeferredNewCards(0);
    setLastAnswer(null);
    setStats({ reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 });
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

  const answer = useCallback(async (rating: Rating) => {
    if (!currentCard || !sessionId) return;
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
      setLoading(false);
    }
  }, [currentCard, sessionId, currentIndex, queue.length, addToast, mode]);

  /** 撤销最近一次评分：服务端恢复 FSRS 快照，前端把卡片退回队首并回滚统计。 */
  const undoLast = useCallback(async () => {
    if (!lastAnswer || !sessionId) return;
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
      setLoading(false);
    }
  }, [lastAnswer, sessionId, addToast]);

  // 每次渲染刷新 ref，使 toast action 永远调到最新闭包
  undoRef.current = () => void undoLast();

  /** 跳过当前卡：持久化 skip 日志（幂等），再本地推进。 */
  const skip = useCallback(() => {
    if (!currentCard) return;
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
    const next = currentIndex + 1;
    if (next >= queue.length) {
      setCompleted(true);
    } else {
      setCurrentIndex(next);
    }
  }, [currentCard, sessionId, mode, currentIndex, queue.length, addToast]);

  /** 挂起当前卡：该词退出复习调度（state=suspended），本地推进。 */
  const suspendCurrent = useCallback(async () => {
    if (!currentCard) return;
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
      setLoading(false);
    }
  }, [currentCard, addToast]);

  return {
    currentCard,
    queue,
    mode,
    loading,
    error,
    stats,
    deferredNewCards,
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
    browseNext,
    browsePrev,
    clearWeakSignal,
  };
}
