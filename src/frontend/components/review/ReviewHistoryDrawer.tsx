import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { History, Clock, Undo2, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import clsx from "clsx";
import { Sheet } from "@/frontend/components/ui/Sheet";
import { Badge } from "@/frontend/components/ui/Badge";
import { Button } from "@/frontend/components/ui/Button";
import { Skeleton } from "@/frontend/components/ui/Skeleton";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { apiFetch } from "@/frontend/api/client";

export interface ReviewHistoryEntry {
  id: string; // reviewLogId（可直接用于 /review/undo）
  rating: "again" | "hard" | "good" | "easy" | string;
  created_at: string;
  word_slug: string;
  word_lemma: string;
}

interface ReviewHistoryDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 用于调用 /review/undo。未提供时条目撤销按钮禁用。 */
  sessionId?: string | null;
  /** 用于拉取本次会话内的评分（可选）。未提供时取最近 N 条全局。 */
  sessionScopeId?: string | null;
  /** 抽屉展示上限。默认 30。 */
  limit?: number;
  /**
   * 条目级撤销成功回调，用于消费方回退 UI 状态（例如 useReview.undoLast 的本地回滚）。
   * entry 是被撤销的那一条。
   */
  onUndoSuccess?: (entry: ReviewHistoryEntry) => void | Promise<void>;
  /** 是否允许对历史条目执行撤销：默认仅最新一条可撤销（后端限制）。 */
  allowUndoLatestOnly?: boolean;
}

const ratingConfig: Record<string, { label: string; tone: "default" | "warm" | "accent" }> = {
  again: { label: "重来", tone: "warm" },
  hard: { label: "困难", tone: "default" },
  good: { label: "良好", tone: "accent" },
  easy: { label: "简单", tone: "accent" },
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  return d.toLocaleDateString("zh-CN");
}

export function ReviewHistoryDrawer({
  open,
  onClose,
  sessionId,
  sessionScopeId,
  limit = 30,
  onUndoSuccess,
  allowUndoLatestOnly = true,
}: ReviewHistoryDrawerProps) {
  const [entries, setEntries] = useState<ReviewHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      // 如果后端 timeline 暂未支持会话筛选（v1 行为），保持参数透明。
      if (sessionScopeId) params.set("sessionId", sessionScopeId);
      const res = await apiFetch<{ items: ReviewHistoryEntry[]; total?: number }>(
        `/review/timeline?${params.toString()}`,
      );
      const items = res.items ?? [];
      setEntries(items);
      setTotal(typeof res.total === "number" ? res.total : items.length);
    } catch (e) {
      setEntries([]);
      setTotal(0);
      setError(e instanceof Error ? e.message : "加载历史记录失败");
    } finally {
      setLoading(false);
    }
  }, [limit, sessionScopeId]);

  // 打开抽屉时/会话 id 变更时刷新。
  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const handleUndo = useCallback(
    async (entry: ReviewHistoryEntry) => {
      if (!sessionId) return;
      setUndoingId(entry.id);
      try {
        const body: Record<string, string> = {
          reviewLogId: entry.id,
          sessionId,
        };
        // 为幂等避免前端重试副作用：给个一次性 key。
        body.idempotencyKey = `ui-history-undo-${entry.id}-${Date.now().toString(36)}`;
        await apiFetch<{ ok: true }>("/review/undo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        // 撤销成功后，从列表移除被撤销条目（后端消费了这条 log），并触发消费方本地回滚。
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
        setTotal((prev) => Math.max(0, prev - 1));
        await onUndoSuccess?.(entry);
      } catch (e) {
        setError(e instanceof Error ? e.message : "撤销失败");
      } finally {
        setUndoingId(null);
      }
    },
    [sessionId, onUndoSuccess],
  );

  const latestEntryId = useMemo(() => entries[0]?.id ?? null, [entries]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <History className="h-5 w-5 text-[var(--color-accent)]" />
          复习历史记录
        </span>
      }
      subtitle={total > 0 ? `共 ${total} 条，本次会话内可撤销最近 1 条评分` : "快捷键 H 开关此面板；Ctrl/Cmd+Z 直接撤销最新一条"}
      headerRight={
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} title="刷新">
          <RefreshCw className={clsx("h-4 w-4", loading && "animate-spin")} />
        </Button>
      }
    >
      {error ? (
        <div className="mb-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-accent-2)]">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          title="暂无复习记录"
          description="完成一次评分后，这里会列出最近的评分记录。"
          icon={<RotateCcw className="h-10 w-10" />}
        />
      ) : (
        <ul className="space-y-2">
          {entries.map((entry, index) => {
            const cfg = ratingConfig[entry.rating] ?? {
              label: entry.rating,
              tone: "default" as const,
            };
            const canUndo = Boolean(sessionId) && (!allowUndoLatestOnly || entry.id === latestEntryId);
            const isLatest = index === 0;
            return (
              <li
                key={entry.id}
                className={clsx(
                  "flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors",
                  isLatest
                    ? "border-[var(--color-border-strong)] bg-[var(--color-surface-glass-hover)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface-glass)] hover:border-[var(--color-border-strong)]",
                )}
              >
                <Link
                  to={`/words/${entry.word_slug}`}
                  onClick={onClose}
                  className="min-w-0 flex-1"
                  target="_self"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-[var(--color-ink)]">
                      {entry.word_lemma}
                    </span>
                    {isLatest ? (
                      <Badge tone="accent" className="shrink-0 ring-1 ring-inset ring-[var(--color-accent)]/40">
                        最新
                      </Badge>
                    ) : null}
                    <Badge tone={cfg.tone} className="shrink-0">
                      {cfg.label}
                    </Badge>
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--color-ink-soft)]">
                    <Clock className="h-3 w-3" />
                    {formatTime(entry.created_at)}
                  </div>
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canUndo || undoingId === entry.id}
                  onClick={() => void handleUndo(entry)}
                  title={
                    canUndo
                      ? "回退这条评分并重新评分"
                      : allowUndoLatestOnly
                        ? "仅允许撤销最新一条评分"
                        : "会话未就绪"
                  }
                >
                  {undoingId === entry.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Undo2 className="h-4 w-4" />
                  )}
                  撤销
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
