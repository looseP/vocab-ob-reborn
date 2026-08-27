import { useCallback, useState } from "react";
import { apiFetch } from "@/frontend/api/client";
import { useToast } from "@/frontend/components/ui/Toast";
import {
  createDrillQueue,
  deferDrillCard,
  remainingInDrill,
  submitDrillAnswer,
  type DrillCard,
  type DrillMode,
  type DrillQueueState,
} from "@/services/drill-engine";

interface DrillQueueResponse {
  items: DrillCard[];
}

export interface DrillFeedback {
  correct: boolean;
  correctAnswer: string;
  source?: string;
}

export interface DrillSessionStats {
  answered: number;
  correct: number;
  incorrect: number;
}

/**
 * L1 练习变体（cram drill）—— cloze/definition 自测。
 * 纯前端状态机：答对出队、答错回尾；全程不写复习数据。
 */
export function useDrill() {
  const [variant, setVariant] = useState<DrillMode>("cloze");
  const [queueState, setQueueState] = useState<DrillQueueState | null>(null);
  const [feedback, setFeedback] = useState<DrillFeedback | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DrillSessionStats>({ answered: 0, correct: 0, incorrect: 0 });
  const { addToast } = useToast();

  const currentCard = queueState?.queue[0] ?? null;

  const startDrill = useCallback(async (v: DrillMode) => {
    setVariant(v);
    setLoading(true);
    setError(null);
    setFeedback(null);
    setStats({ answered: 0, correct: 0, incorrect: 0 });
    try {
      const result = await apiFetch<DrillQueueResponse>("/review/drill/queue?limit=20");
      if (!result.items || result.items.length === 0) {
        setError("没有可练习的单词（先完成一些复习，词条需含例句）");
        setQueueState(null);
        return;
      }
      setQueueState(createDrillQueue(result.items));
      addToast("info", `已加载 ${result.items.length} 张练习卡`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载练习队列失败");
      setQueueState(null);
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  const submit = useCallback((answer: string) => {
    if (!queueState) return;
    const { correct, correctAnswer, next } = submitDrillAnswer(queueState, answer);
    setFeedback({
      correct,
      correctAnswer,
      source: currentCard?.clozeSource,
    });
    setQueueState(next);
    setStats((prev) => ({
      answered: prev.answered + 1,
      correct: prev.correct + (correct ? 1 : 0),
      incorrect: prev.incorrect + (correct ? 0 : 1),
    }));
  }, [queueState, currentCard]);

  const defer = useCallback(() => {
    if (!queueState) return;
    setQueueState(deferDrillCard(queueState));
    setFeedback(null);
  }, [queueState]);

  const nextCard = useCallback(() => {
    setFeedback(null);
  }, []);

  return {
    variant,
    queueState,
    feedback,
    loading,
    error,
    stats,
    currentCard,
    remaining: queueState ? remainingInDrill(queueState) : 0,
    startDrill,
    submit,
    defer,
    nextCard,
  };
}
