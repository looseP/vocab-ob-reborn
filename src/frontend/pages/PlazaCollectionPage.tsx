import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BookOpen, ChevronRight, Users } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { apiFetch } from "@/frontend/api/client";

interface PlazaWordCard {
  id: string;
  slug: string;
  lemma: string;
  cefr: string | null;
  short_definition: string | null;
  semantic_chain: string | null;
}
interface PlazaCollectionDetail {
  slug: string;
  title: string;
  kind: "semantic_field";
  count: number;
  updatedAt: string;
  words: PlazaWordCard[];
}

export function PlazaCollectionPage() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<PlazaCollectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    apiFetch<PlazaCollectionDetail>(`/plaza/collections/${encodeURIComponent(slug)}`, {
      signal: controller.signal,
    })
      .then((result) => setData(result))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "加载集合失败");
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
      });
    return () => controller.abort();
  }, [slug]);

  if (loading) {
    return (
      <Card className="flex items-center justify-center py-12">
        <Spinner />
        <span className="ml-3 text-[var(--color-ink-soft)]">加载中...</span>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card className="py-12 text-center">
        <p className="text-[var(--color-accent-2)]">{error ?? "集合不存在"}</p>
        <Link to="/plaza" className="mt-4 inline-block text-sm font-semibold text-[var(--color-accent)]">
          返回词汇广场
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1.5 text-sm text-[var(--color-ink-soft)]">
        <Link to="/plaza" className="hover:text-[var(--color-ink)]">
          词汇广场
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-[var(--color-ink)]">{data.title}</span>
      </nav>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warm">{data.kind === "semantic_field" ? "语义场" : data.kind}</Badge>
          <Badge>关联词条 {data.count}</Badge>
        </div>
        <h1 className="section-title mt-3 flex items-center gap-3 text-3xl font-bold text-[var(--color-ink)]">
          <Users className="h-7 w-7 text-[var(--color-accent)]" />
          {data.title}
        </h1>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          按主题组织的 {data.count} 个词条——浏览整组知识，点进词条可查看完整释义与词源。
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.words.map((word) => (
          <Link key={word.id} to={`/words/${word.slug}`}>
            <Card className="h-full transition-colors hover:border-[var(--color-border-strong)]">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <BookOpen className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                  <p className="truncate text-lg font-semibold text-[var(--color-ink)]">{word.lemma}</p>
                </div>
                {word.cefr && (
                  <Badge className="shrink-0">{word.cefr}</Badge>
                )}
              </div>
              {word.short_definition && (
                <p className="mt-2 text-sm leading-6 text-[var(--color-ink-soft)]">
                  {word.short_definition}
                </p>
              )}
              {word.semantic_chain && (
                <p className="mt-3 line-clamp-2 border-t border-[var(--color-border)] pt-3 text-xs leading-5 text-[var(--color-ink-soft)]">
                  {word.semantic_chain}
                </p>
              )}
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
