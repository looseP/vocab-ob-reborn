import { useCallback, useState } from "react";
import { apiFetch } from "@/frontend/api/client";
import { useToast } from "@/frontend/components/ui/Toast";

// M9 修复：浏览器内置 crypto.randomUUID() 用于幂等键生成。
// 不可用时回退到 crypto.getRandomValues 拼 16 进制，保证 always-available。
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface L2DrillTask {
  taskId: string;
  taskType: "cloze_mcq" | "synonym_discrimination" | "production";
  prompt: string;
  stepIndex: number;
  options?: string[];
  hintTranslation?: string | null;
  referenceExample?: string | null;
  /** P3-8: 来源标题（仅产出自评步 + L3 语境命中时填充） */
  sourceTitle?: string | null;
  /** P3-8: L3 语境 id，点击"查看原文"跳转用 */
  contextId?: string | null;
}

export interface L2DrillItem {
  progressId: string;
  stepId: string;
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
  l2DueAt: string | null;
  l2ReviewCount: number;
  singleStep: boolean;
  task: L2DrillTask;
}

interface QueueResponse {
  items: L2DrillItem[];
  session: { id: string; mode: string };
  stats: { total: number; remaining: number };
}

interface TaskAnswerResponse {
  ok: true;
  idempotent?: boolean;
  skipped?: boolean;
  outcome?: "correct" | "incorrect";
  nextStep: { type: "done" } | { type: "production"; step: { stepId: string; task: L2DrillTask } };
}

export type L2Verdict = "passed" | "weak";

export interface DrillStats {
  answered: number;
  correct: number;
  incorrect: number;
  selfPassed: number;
  selfWeak: number;
}

export function useL2Drill() {
  const [items, setItems] = useState<L2DrillItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  /** 非空表示当前卡处于产出步（辨析通过后或单步降级） */
  const [production, setProduction] = useState<{ stepId: string; task: L2DrillTask } | null>(null);
  /** 辨析后的即时反馈（答错时停留展示，用户点击后前进） */
  const [feedback, setFeedback] = useState<"correct" | "incorrect" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [stats, setStats] = useState<DrillStats>({ answered: 0, correct: 0, incorrect: 0, selfPassed: 0, selfWeak: 0 });
  const { addToast } = useToast();

  const currentItem = !completed && currentIndex < items.length ? items[currentIndex] : null;
  const remaining = Math.max(0, items.length - currentIndex);

  const startDrill = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCompleted(false);
    setCurrentIndex(0);
    setProduction(null);
    setFeedback(null);
    setStats({ answered: 0, correct: 0, incorrect: 0, selfPassed: 0, selfWeak: 0 });
    try {
      const result = await apiFetch<QueueResponse>("/l2-drill/queue?limit=20");
      if (!result.items || result.items.length === 0) {
        setError("没有待训练的 L2 单词");
        setItems([]);
        setSessionId(null);
        return;
      }
      // 单步降级卡直接进入产出步
      const first = result.items[0];
      setItems(result.items);
      setSessionId(result.session.id);
      if (first.singleStep && first.task.taskType === "production") {
        setProduction({ stepId: first.stepId, task: first.task });
      }
      addToast("info", `已加载 ${result.items.length} 张辨析卡片`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载辨析队列失败");
      setItems([]);
      setSessionId(null);
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  const advance = useCallback(() => {
    setProduction(null);
    setFeedback(null);
    const next = currentIndex + 1;
    if (next >= items.length) {
      setCompleted(true);
    } else {
      setCurrentIndex(next);
      const nextItem = items[next];
      if (nextItem.singleStep && nextItem.task.taskType === "production") {
        setProduction({ stepId: nextItem.stepId, task: nextItem.task });
      }
    }
  }, [currentIndex, items]);

  const submitChoice = useCallback(async (choiceIndex: number) => {
    // H1 修复：防重入 guard。点击瞬间 loading 尚为 false，按钮 disabled 依赖
    // React 重渲染，快速连点可双触发 → 两次不同幂等键 → 服务端第二个请求
    // 命中 'Drill step already settled' 被当错误显示。此 guard 在 setState
    // 生效前拦住重入（闭包里的 loading 是本次渲染的旧值，重入时已为 true）。
    if (!currentItem || !sessionId || production || loading) return;
    setLoading(true);
    try {
      // M9 修复：每次提交生成幂等键；网络抖动重放时服务端按已结算返回产出步入口
      const idempotencyKey = newIdempotencyKey();
      const result = await apiFetch<TaskAnswerResponse>("/l2-drill/task/answer", {
        method: "POST",
        body: JSON.stringify({ sessionId, stepId: currentItem.stepId, choiceIndex, idempotencyKey }),
      });
      if (result.skipped || result.idempotent) {
        if (result.skipped) addToast("warning", "该词已被暂停，已跳过");
        advance();
        return;
      }
      const correct = result.outcome === "correct";
      setStats((prev) => ({
        ...prev,
        answered: prev.answered + 1,
        correct: prev.correct + (correct ? 1 : 0),
        incorrect: prev.incorrect + (correct ? 0 : 1),
      }));
      if (!correct || result.nextStep.type === "done") {
        setFeedback(result.outcome ?? "correct");
        return;
      }
      // 答对 → 衔接产出自评步
      setProduction(result.nextStep.step);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
      addToast("error", "提交失败，请重试");
    } finally {
      setLoading(false);
    }
  }, [currentItem, sessionId, production, loading, advance, addToast]);

  const submitVerdict = useCallback(async (verdict: L2Verdict) => {
    // H1 修复：与 submitChoice 同款防重入 guard（连点两次自评 = 两个幂等键
    // = 第二次命中 'production step already settled'）。
    if (!production || !sessionId || loading) return;
    setLoading(true);
    try {
      // M9 修复：自评也生成幂等键，避免双击或网络重试触发 BusinessRuleError
      const idempotencyKey = newIdempotencyKey();
      await apiFetch("/l2-drill/self-assess", {
        method: "POST",
        body: JSON.stringify({ sessionId, stepId: production.stepId, verdict, idempotencyKey }),
      });
      setStats((prev) => ({
        ...prev,
        selfPassed: prev.selfPassed + (verdict === "passed" ? 1 : 0),
        selfWeak: prev.selfWeak + (verdict === "weak" ? 1 : 0),
      }));
      advance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
      addToast("error", "自评提交失败");
    } finally {
      setLoading(false);
    }
  }, [production, sessionId, loading, advance, addToast]);

  const undo = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      // M9 修复：撤销也加幂等键；多次点 Undo 不重复触发撤销副作用
      const idempotencyKey = newIdempotencyKey();
      await apiFetch("/l2-drill/undo", {
        method: "POST",
        body: JSON.stringify({ sessionId, idempotencyKey }),
      });
      addToast("success", "已撤销上一步");
      // 撤销后重拉队列以对齐服务端状态（幂等建步保证不重复计费）
      await startDrill();
    } catch (err) {
      addToast("warning", err instanceof Error ? err.message : "没有可撤销的步骤");
    } finally {
      setLoading(false);
    }
  }, [sessionId, startDrill, addToast]);

  return {
    currentItem,
    production,
    feedback,
    loading,
    error,
    completed,
    stats,
    currentIndex,
    remaining,
    startDrill,
    submitChoice,
    submitVerdict,
    /** 答错反馈页停留后，由用户点击进入下一张 */
    advanceAfterFeedback: advance,
    undo,
  };
}
