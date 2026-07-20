import { useCallback, useState } from "react";
import { apiFetch } from "@/frontend/api/client";

export interface ReviewCard {
  wordId: string;
  slug: string;
  title: string;
  lemma: string;
  definitionMd: string;
  bodyMd: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  shortDefinition: string | null;
  examples: unknown[];
}

export interface ReviewAnswer {
  rating: "again" | "hard" | "good" | "easy";
  wordId: string;
}

export function useReview() {
  const [currentCard, setCurrentCard] = useState<ReviewCard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionStats, setSessionStats] = useState({ reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 });

  const fetchNext = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const card = await apiFetch<ReviewCard>("/review/next");
      setCurrentCard(card);
    } catch (err) {
      setCurrentCard(null);
      setError(err instanceof Error ? err.message : "Failed to fetch review card");
    } finally {
      setLoading(false);
    }
  }, []);

  const answer = useCallback(async (reviewAnswer: ReviewAnswer) => {
    setLoading(true);
    setError(null);
    try {
      await apiFetch("/review/answer", {
        method: "POST",
        body: JSON.stringify(reviewAnswer),
      });
      setSessionStats((prev) => ({
        reviewed: prev.reviewed + 1,
        again: prev.again + (reviewAnswer.rating === "again" ? 1 : 0),
        hard: prev.hard + (reviewAnswer.rating === "hard" ? 1 : 0),
        good: prev.good + (reviewAnswer.rating === "good" ? 1 : 0),
        easy: prev.easy + (reviewAnswer.rating === "easy" ? 1 : 0),
      }));
      await fetchNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit answer");
    } finally {
      setLoading(false);
    }
  }, [fetchNext]);

  const skip = useCallback(async (wordId: string) => {
    await apiFetch("/review/skip", { method: "POST", body: JSON.stringify({ wordId }) });
    await fetchNext();
  }, [fetchNext]);

  return { currentCard, loading, error, sessionStats, fetchNext, answer, skip };
}
