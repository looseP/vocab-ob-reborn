import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { History, Clock } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Skeleton } from "@/frontend/components/ui/Skeleton";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { apiFetch } from "@/frontend/api/client";

interface TimelineEntry {
  id: string;
  rating: string;
  created_at: string;
  word_slug: string;
  word_lemma: string;
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

export function WordReviewTimeline() {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ items: TimelineEntry[] }>("/review/timeline?limit=20")
      .then((result) => setEntries(result.items ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Skeleton className="h-48 w-full" />;

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <History className="h-5 w-5 text-[var(--color-accent)]" />
        <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">复习时间线</h2>
      </div>

      {entries.length === 0 ? (
        <EmptyState title="暂无复习记录" description="开始复习后，这里会显示最近的复习历史" />
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => {
            const cfg = ratingConfig[entry.rating] ?? { label: entry.rating, tone: "default" as const };
            return (
              <Link
                key={entry.id}
                to={`/words/${entry.word_slug}`}
                className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-glass)] px-4 py-2.5 transition-colors hover:border-[var(--color-border-strong)]"
              >
                <div className="flex-1">
                  <span className="font-medium text-[var(--color-ink)]">{entry.word_lemma}</span>
                </div>
                <Badge tone={cfg.tone}>{cfg.label}</Badge>
                <div className="flex items-center gap-1 text-xs text-[var(--color-ink-soft)]">
                  <Clock className="h-3 w-3" />
                  {formatTime(entry.created_at)}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </Card>
  );
}
