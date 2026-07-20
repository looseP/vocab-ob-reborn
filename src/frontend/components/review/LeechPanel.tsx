import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Bug, AlertTriangle } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Skeleton } from "@/frontend/components/ui/Skeleton";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { apiFetch } from "@/frontend/api/client";

interface Leech {
  progressId: string;
  word: { id: string; slug: string; title: string; lemma: string; short_definition: string | null };
  lapseCount: number;
  state: string;
  dueAt: string | null;
}

interface LeechesResponse {
  items: Leech[];
  total: number;
}

export function LeechPanel() {
  const [leeches, setLeeches] = useState<Leech[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<LeechesResponse>("/review/leeches?limit=10")
      .then((result) => setLeeches(result.items ?? []))
      .catch(() => setLeeches([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Skeleton className="h-48 w-full" />;

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Bug className="h-5 w-5 text-[var(--color-accent-2)]" />
        <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">漏词管理</h2>
        {leeches.length > 0 && <Badge tone="warm">{leeches.length}</Badge>}
      </div>

      {leeches.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle className="h-8 w-8" />}
          title="暂无漏词"
          description="频繁遗忘的单词会显示在这里"
        />
      ) : (
        <div className="space-y-2">
          {leeches.map((leech) => (
            <Link
              key={leech.progressId}
              to={`/words/${leech.word.slug}`}
              className="flex items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-glass)] px-4 py-3 transition-colors hover:border-[var(--color-border-strong)]"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[var(--color-ink)]">{leech.word.lemma}</span>
                  <Badge tone="warm">遗忘 {leech.lapseCount} 次</Badge>
                </div>
                {leech.word.short_definition && (
                  <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{leech.word.short_definition}</p>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
