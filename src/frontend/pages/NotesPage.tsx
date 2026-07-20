import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Notebook, Clock, FileText } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Skeleton, SkeletonCard } from "@/frontend/components/ui/Skeleton";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { apiFetch } from "@/frontend/api/client";

interface NoteItem {
  id: string;
  wordSlug: string;
  wordLemma: string;
  wordTitle: string;
  contentMd: string;
  version: number;
  updatedAt: string;
}

interface NotesResponse {
  items: NoteItem[];
  total: number;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHr < 24) return `${diffHr} 小时前`;
  if (diffDay < 30) return `${diffDay} 天前`;
  return d.toLocaleDateString("zh-CN");
}

export function NotesPage() {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<NotesResponse>("/notes?limit=50")
      .then((result) => setNotes(result.items ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">笔记</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">词汇笔记和标注</p>
      </div>

      {loading ? (
        <div className="space-y-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : error ? (
        <Card>
          <EmptyState title="加载失败" description={error} />
        </Card>
      ) : notes.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Notebook className="h-10 w-10" />}
            title="暂无笔记"
            description="在单词详情页添加笔记后，这里会显示笔记列表"
            action={
              <Link to="/words">
                <span className="text-sm font-semibold text-[var(--color-accent)]">浏览词条库</span>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {notes.map((note) => (
            <Link key={note.id} to={`/words/${note.wordSlug}`}>
              <Card className="cursor-pointer transition-colors hover:border-[var(--color-border-strong)]">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="section-title text-lg font-semibold text-[var(--color-ink)]">
                        {note.wordLemma}
                      </h3>
                      <Badge tone="accent">v{note.version}</Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-[var(--color-ink-soft)]">
                      {note.contentMd || "(空笔记)"}
                    </p>
                    <div className="mt-2 flex items-center gap-1 text-xs text-[var(--color-ink-soft)]">
                      <Clock className="h-3 w-3" />
                      {formatDate(note.updatedAt)}
                    </div>
                  </div>
                  <FileText className="h-5 w-5 shrink-0 text-[var(--color-ink-soft)]" />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
