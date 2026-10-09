import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Plus, Sparkles, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { Badge } from "@/frontend/components/ui/Badge";
import { Button } from "@/frontend/components/ui/Button";
import { useToast } from "@/frontend/components/ui/Toast";
import { apiFetch } from "@/frontend/api/client";

/**
 * P1-A：生词预审快闪（先筛后生）。
 *
 * 「突破性学习」的前置漏斗：整组逐词按第一反应判定「认识 / 不认识」，
 * 只把不认识的词用 /api/review/cards/batch 写入 FSRS 队列——熟词不污染
 * 调度参数、不挤占每日新卡配额。复用 preview（自由复习）只读通道的
 * 判定语义：本组件零 DB 写，写队列只发生在总结页的显式「加入」动作。
 *
 * 键盘：→/1 认识，←/2 不认识，空格/回车 翻面看释义，Esc 退出。
 */

export interface PrecheckWord {
  id: string;
  lemma: string;
  cefr: string | null;
  short_definition: string | null;
}

interface PlazaPrecheckFlowProps {
  /** 待预审词（按集合顺序）。 */
  words: PrecheckWord[];
  /** 关闭快闪（未入队的判定不产生任何写入）。 */
  onClose: () => void;
  /** 入队成功回调（父页面刷新集合内复习统计）。 */
  onEnqueued: (result: { added: number; skipped: number; wordIds: string[] }) => void;
}

type Stage = "card" | "summary";

export function PlazaPrecheckFlow({ words, onClose, onEnqueued }: PlazaPrecheckFlowProps) {
  const [index, setIndex] = useState(0);
  const [showBack, setShowBack] = useState(false);
  const [unknownIds, setUnknownIds] = useState<string[]>([]);
  const [knownIds, setKnownIds] = useState<string[]>([]);
  const [stage, setStage] = useState<Stage>(words.length > 0 ? "card" : "summary");
  const [enqueuing, setEnqueuing] = useState(false);
  const [enqueued, setEnqueued] = useState<{ added: number; skipped: number } | null>(null);
  const { addToast } = useToast();

  const total = words.length;
  const current = words[index];

  const judge = useCallback((known: boolean) => {
    if (!current) return;
    if (known) {
      setKnownIds((prev) => (prev.includes(current.id) ? prev : [...prev, current.id]));
    } else {
      setUnknownIds((prev) => (prev.includes(current.id) ? prev : [...prev, current.id]));
    }
    setShowBack(false);
    if (index + 1 >= total) {
      setStage("summary");
    } else {
      setIndex(index + 1);
    }
  }, [current, index, total]);

  useEffect(() => {
    if (stage !== "card") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "1") {
        e.preventDefault();
        judge(true);
      } else if (e.key === "ArrowLeft" || e.key === "2") {
        e.preventDefault();
        judge(false);
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setShowBack((v) => !v);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage, judge, onClose]);

  const enqueueUnknown = async () => {
    if (unknownIds.length === 0) return;
    setEnqueuing(true);
    try {
      const res = await apiFetch<{ ok: boolean; added: number; skipped: number }>(
        "/api/review/cards/batch",
        {
          method: "POST",
          body: JSON.stringify({ wordIds: unknownIds }),
        },
      );
      if (res.ok) {
        setEnqueued({ added: res.added, skipped: res.skipped });
        addToast(
          "success",
          `成功加入 ${res.added} 个生词到复习队列${res.skipped > 0 ? `（已在队列 ${res.skipped} 词）` : ""}`,
        );
        onEnqueued({ added: res.added, skipped: res.skipped, wordIds: unknownIds });
      }
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "加入复习计划失败");
    } finally {
      setEnqueuing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="生词预审"
        className="w-full max-w-xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-strong)] p-6 shadow-[var(--shadow-panel-strong)]"
      >
        {stage === "card" && current ? (
          <>
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
                生词预审 {index + 1} / {total} · 已标记生词 {unknownIds.length}
              </p>
              <button
                type="button"
                aria-label="关闭预审"
                onClick={onClose}
                className="rounded-lg p-1 text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface-glass-hover)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-[width]"
                style={{ width: `${Math.round((index / total) * 100)}%` }}
              />
            </div>

            <div className="mt-6 flex min-h-[180px] flex-col items-center justify-center gap-3 text-center">
              <p className="text-4xl font-bold text-[var(--color-ink)]">{current.lemma}</p>
              {current.cefr && <Badge>{current.cefr}</Badge>}
              {showBack ? (
                <p className="mt-2 max-w-md text-base leading-7 text-[var(--color-ink-soft)]">
                  {current.short_definition ?? "（该词暂无简义，可在词条页查看完整释义）"}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowBack(true)}
                  className="mt-2 text-sm font-semibold text-[var(--color-accent)] hover:underline"
                >
                  先回忆词义，点击查看释义（空格）
                </button>
              )}
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <Button variant="secondary" onClick={() => judge(false)}>
                <ThumbsDown className="h-4 w-4" /> 不认识（←）
              </Button>
              <Button onClick={() => judge(true)}>
                <ThumbsUp className="h-4 w-4" /> 认识（→）
              </Button>
            </div>
            <p className="mt-3 text-center text-xs text-[var(--color-ink-soft)]">
              按第一反应判定即可：只把「不认识」的词加入复习计划，熟词不占每日新卡配额。
            </p>
          </>
        ) : (
          <div className="text-center">
            <Sparkles className="mx-auto h-8 w-8 text-[var(--color-accent)]" />
            <h2 className="section-title mt-3 text-2xl font-bold text-[var(--color-ink)]">预审完成</h2>
            <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
              本组 {total} 词：已认识 {knownIds.length} · 生词 {unknownIds.length}
            </p>

            <div className="mt-6 flex flex-col gap-3">
              {unknownIds.length > 0 && !enqueued && (
                <Button onClick={enqueueUnknown} disabled={enqueuing}>
                  <Plus className="h-4 w-4" />
                  {enqueuing ? "加入中..." : `把 ${unknownIds.length} 个生词加入复习计划`}
                </Button>
              )}
              {enqueued && (
                <>
                  <p className="text-sm font-semibold text-[var(--color-accent)]">
                    <Check className="inline h-4 w-4" /> 已加入复习队列（新 {enqueued.added}
                    {enqueued.skipped > 0 ? ` · 已在队列 ${enqueued.skipped}` : ""}）
                  </p>
                  <Link to={`/review?wordIds=${unknownIds.join(",")}`}>
                    <Button variant="secondary">立即复习这 {unknownIds.length} 个生词</Button>
                  </Link>
                </>
              )}
              {unknownIds.length === 0 && (
                <p className="text-sm text-[var(--color-ink-soft)]">
                  本组全部认识，无需入队——直接去复习队列巩固别的词吧。
                </p>
              )}
              <Button variant="secondary" onClick={onClose}>
                {enqueued || unknownIds.length === 0 ? "完成" : "暂不入队，返回"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
