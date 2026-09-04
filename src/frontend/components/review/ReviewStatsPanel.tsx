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
}

export function ReviewStatsPanel() {
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
        <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">复习统计</h2>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-surface-muted)]">
            <CheckCircle2 className="h-5 w-5 text-[var(--color-accent)]" />
          </div>
          <div>
            <p className="text-xs text-[var(--color-ink-soft)]">今日复习</p>
            <p className="text-xl font-bold text-[var(--color-ink)]">{stats.todayCount}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-surface-muted)]">
            <Target className="h-5 w-5 text-[var(--color-accent-2)]" />
          </div>
          <div>
            <p className="text-xs text-[var(--color-ink-soft)]">累计复习</p>
            <p className="text-xl font-bold text-[var(--color-ink)]">{stats.totalCount}</p>
          </div>
        </div>
      </div>

      {total > 0 ? (
        <div>
          <p className="mb-3 text-sm font-medium text-[var(--color-ink-soft)]">评分分布</p>
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
          暂无复习记录
        </div>
      )}
    </Card>
  );
}
