import { useCallback, useState } from "react";
import { apiFetch } from "@/frontend/api/client";
import { useToast } from "@/frontend/components/ui/Toast";

export interface ReviewCard {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  definition_md: string;
  body_md: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  short_definition: string | null;
  examples: Array<{ text: string; translation?: string }>;
}

interface WordsResponse {
  items: ReviewCard[];
  total: number;
}

export type Rating = "again" | "hard" | "good" | "easy";

export function useReview() {
  const [queue, setQueue] = useState<ReviewCard[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 });
  const [completed, setCompleted] = useState(false);
  const { addToast } = useToast();

  const currentCard = !completed && currentIndex < queue.length ? queue[currentIndex] : null;
  const remaining = Math.max(0, queue.length - currentIndex);

  const startReview = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCompleted(false);
    setCurrentIndex(0);
    setStats({ reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 });
    try {
      const result = await apiFetch<WordsResponse>("/words?limit=20");
      if (!result.items || result.items.length === 0) {
        setError("没有可复习的单词");
        setQueue([]);
        return;
      }
      setQueue(result.items);
      addToast("info", `已加载 ${result.items.length} 张复习卡片`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载复习队列失败");
      setQueue([]);
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  const answer = useCallback(async (rating: Rating) => {
    if (!currentCard) return;
    setLoading(true);
    try {
      await apiFetch("/review/answer", {
        method: "POST",
        body: JSON.stringify({ rating, wordId: currentCard.id }),
      });
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
        addToast("success", "复习完成！");
      } else {
        setCurrentIndex(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交评分失败");
      addToast("error", "评分提交失败，请重试");
    } finally {
      setLoading(false);
    }
  }, [currentCard, currentIndex, queue.length, addToast]);

  const skip = useCallback(() => {
    const next = currentIndex + 1;
    if (next >= queue.length) {
      setCompleted(true);
    } else {
      setCurrentIndex(next);
    }
  }, [currentIndex, queue.length]);

  return {
    currentCard,
    queue,
    loading,
    error,
    stats,
    completed,
    currentIndex,
    remaining,
    startReview,
    answer,
    skip,
  };
}
