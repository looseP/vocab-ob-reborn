import { useEffect, useState } from "react";
import { TrendingUp, CheckCircle2, AlertCircle, Target } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Skeleton } from "@/frontend/components/ui/Skeleton";
import { apiFetch } from "@/frontend/api/client";

interface ReviewStats {
  todayCount: number;
  totalCount: number;
  ratingDist: { again: number; hard: number; good: number; easy: number };
  /** 阶梯会话分组（ADR-0036 LW-2）：metadata.source='typing' 聚合，可选 = 兼容旧响应。 */
  ladder?: {
    sessions: number;
    tierDist: { dictation: number; listen: number; copy: number };
    downgradeRate: number | null;
    avgWrongTimes: number | null;
  };
}

export interface ReviewStatsPanelProps {
  /**
   * L2 轨统计（来自仪表盘汇总 `/review/stats/dashboard`，批次 2 起由父级传入）。
   *
   * 原「更多统计」整组 4 卡删除后，L2 的三个数字并入本卡尾部的一个条件块
   * （与「阶梯会话」同款：无数据时整块不渲染）——L2 数字在页面上别处没有，
   * 不能随复读卡一起删掉。
   */
  l2?: { promoted: number; dueNow: number; weakSignal: number; reviewedToday: number } | null;
}

export function ReviewStatsPanel({ l2 = null }: ReviewStatsPanelProps = {}) {
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<ReviewStats>("/review/stats")
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Skeleton className="h-48 w-full" />;
  if (!stats) return null;

  const total = stats.ratingDist.again + stats.ratingDist.hard + stats.ratingDist.good + stats.ratingDist.easy;
  const ratings = [
    { label: "重来", value: stats.ratingDist.again, color: "var(--color-accent-2)" },
    { label: "困难", value: stats.ratingDist.hard, color: "var(--color-highlight)" },
    { label: "良好", value: stats.ratingDist.good, color: "var(--color-accent)" },
    { label: "简单", value: stats.ratingDist.easy, color: "var(--color-accent)" },
  ];

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <TrendingUp className="h-5 w-5 text-[var(--color-accent)]" />
        <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">L1 速刷统计</h2>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4">
        <div
          className="flex items-center gap-3"
          title="仅 L1 轨（速刷 / 阶梯）的评分次数；含 L2 的全轨今日数见行动区「今日已复习」。"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-surface-muted)]">
            <CheckCircle2 className="h-5 w-5 text-[var(--color-accent)]" />
          </div>
          <div>
            <p className="text-xs text-[var(--color-ink-soft)]">L1 今日复习</p>
            <p className="text-xl font-bold text-[var(--color-ink)]">{stats.todayCount}</p>
          </div>
        </div>
        <div className="flex items-center gap-3" title="仅 L1 轨的评分次数（建库以来累计）。">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-surface-muted)]">
            <Target className="h-5 w-5 text-[var(--color-accent-2)]" />
          </div>
          <div>
            <p className="text-xs text-[var(--color-ink-soft)]">L1 累计复习</p>
            <p className="text-xl font-bold text-[var(--color-ink)]">{stats.totalCount}</p>
          </div>
        </div>
      </div>

      {total > 0 ? (
        <div>
          <p className="mb-3 text-sm font-medium text-[var(--color-ink-soft)]">L1 评分分布</p>
          <div className="space-y-2">
            {ratings.map((r) => (
              <div key={r.label} className="flex items-center gap-3">
                <span className="w-10 text-xs text-[var(--color-ink-soft)]">{r.label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${(r.value / total) * 100}%`, backgroundColor: r.color }}
                  />
                </div>
                <span className="w-8 text-right text-xs font-medium tabular-nums text-[var(--color-ink)]">{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 py-4 text-sm text-[var(--color-ink-soft)]">
          <AlertCircle className="h-4 w-4" />
          暂无 L1 复习记录
        </div>
      )}

      {/* 阶梯会话分组（ADR-0036 LW-2）：source='typing' 聚合，供开关两组对比 */}
      {stats.ladder && stats.ladder.sessions > 0 && (
        <div className="mt-6 border-t border-[var(--color-border)] pt-4" data-testid="ladder-stats-group">
          <p className="mb-3 text-sm font-medium text-[var(--color-ink-soft)]">阶梯会话 · 产出轮</p>
          <div className="mb-3 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-[var(--color-surface-muted)] px-2 py-2">
              <p className="text-[10px] text-[var(--color-ink-soft)]">默写</p>
              <p className="text-lg font-bold text-[var(--color-ink)]">{stats.ladder.tierDist.dictation}</p>
            </div>
            <div className="rounded-lg bg-[var(--color-surface-muted)] px-2 py-2">
              <p className="text-[10px] text-[var(--color-ink-soft)]">听写</p>
              <p className="text-lg font-bold text-[var(--color-ink)]">{stats.ladder.tierDist.listen}</p>
            </div>
            <div className="rounded-lg bg-[var(--color-surface-muted)] px-2 py-2">
              <p className="text-[10px] text-[var(--color-ink-soft)]">照着打</p>
              <p className="text-lg font-bold text-[var(--color-ink)]">{stats.ladder.tierDist.copy}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-[var(--color-ink-soft)]">
            <span>产出作答 <b className="text-[var(--color-ink)]">{stats.ladder.sessions}</b></span>
            <span>自选降档率 <b className="text-[var(--color-ink)]">{stats.ladder.downgradeRate != null ? `${Math.round(stats.ladder.downgradeRate * 100)}%` : "—"}</b></span>
            <span>平均错键 <b className="text-[var(--color-ink)]">{stats.ladder.avgWrongTimes != null ? stats.ladder.avgWrongTimes : "—"}</b></span>
          </div>
        </div>
      )}

      {/* L2 轨道（批次 2）：由父级传入的汇总统计；未启用（四项全 0）时整块不渲染 */}
      {l2 && l2.promoted + l2.dueNow + l2.weakSignal + l2.reviewedToday > 0 && (
        <div className="mt-6 border-t border-[var(--color-border)] pt-4" data-testid="l2-track-group">
          <p className="mb-3 text-sm font-medium text-[var(--color-ink-soft)]">L2 轨道</p>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-[var(--color-surface-muted)] px-2 py-2">
              <p className="text-[10px] text-[var(--color-ink-soft)]">已晋升</p>
              <p className="text-lg font-bold text-[var(--color-ink)]">{l2.promoted}</p>
            </div>
            <div className="rounded-lg bg-[var(--color-surface-muted)] px-2 py-2">
              <p className="text-[10px] text-[var(--color-ink-soft)]">待辨析</p>
              <p className="text-lg font-bold text-[var(--color-ink)]">{l2.dueNow}</p>
            </div>
            <div className="rounded-lg bg-[var(--color-surface-muted)] px-2 py-2">
              <p className="text-[10px] text-[var(--color-ink-soft)]">今日复习</p>
              <p className="text-lg font-bold text-[var(--color-ink)]">{l2.reviewedToday}</p>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
