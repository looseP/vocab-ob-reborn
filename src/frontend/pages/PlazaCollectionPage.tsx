import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BookOpen, ChevronRight, Layers, Users } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { apiFetch } from "@/frontend/api/client";

type PlazaKind = "semantic_field" | "root_affix";
type RootFamilyType = "simple" | "compound" | "mixed";

interface PlazaWordCard {
  id: string;
  slug: string;
  lemma: string;
  cefr: string | null;
  short_definition: string | null;
  semantic_chain: string | null;
}
interface RootWordCard extends PlazaWordCard {
  root: string | null;
  prefix: string | null;
  suffix: string | null;
}
interface PlazaCollectionDetail {
  slug: string;
  title: string;
  kind: PlazaKind;
  count: number;
  updatedAt: string;
  type?: RootFamilyType;
  words: PlazaWordCard[] | RootWordCard[];
}

const TYPE_LABEL: Record<RootFamilyType, string> = {
  simple: "简单词根",
  compound: "复合词根",
  mixed: "混合词族",
};

export function PlazaCollectionPage() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<PlazaCollectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    // 语义场集合走 /plaza/collections/:slug；词根家族走 /plaza/roots/:slug
    const isRoot = slug.startsWith("root-");
    const path = isRoot ? `/plaza/roots/${encodeURIComponent(slug)}` : `/plaza/collections/${encodeURIComponent(slug)}`;
    apiFetch<PlazaCollectionDetail>(path, {
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

  const isRoot = data.kind === "root_affix";
  const kindLabel = isRoot ? "词根词缀" : "语义场";

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
          <Badge tone="warm">{kindLabel}</Badge>
          <Badge>{isRoot ? `家族 ${data.count} 词` : `关联词条 ${data.count}`}</Badge>
          {isRoot && data.type && <Badge>{TYPE_LABEL[data.type]}</Badge>}
        </div>
        <h1 className="section-title mt-3 flex items-center gap-3 text-3xl font-bold text-[var(--color-ink)]">
          {isRoot ? <Layers className="h-7 w-7 text-[var(--color-accent)]" /> : <Users className="h-7 w-7 text-[var(--color-accent)]" />}
          {isRoot ? `-${data.title}-` : data.title}
        </h1>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">
          {isRoot
            ? `共享「${data.title}」词根的 ${data.count} 个词——按词源关系组织，点进词条查看完整释义与词根结构。`
            : `按主题组织的 ${data.count} 个词条——浏览整组知识，点进词条可查看完整释义与词源。`}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.words.map((word) => {
          const rootWord = word as RootWordCard;
          return (
            <Link key={word.id} to={`/words/${word.slug}`}>
              <Card className="h-full transition-colors hover:border-[var(--color-border-strong)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <BookOpen className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                    <p className="truncate text-lg font-semibold text-[var(--color-ink)]">{word.lemma}</p>
                  </div>
                  {word.cefr && <Badge className="shrink-0">{word.cefr}</Badge>}
                </div>
                {isRoot && (rootWord.prefix || rootWord.suffix) && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    {rootWord.prefix && (
                      <span className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[var(--color-ink-soft)]">
                        {rootWord.prefix}
                      </span>
                    )}
                    {rootWord.root && (
                      <span className="rounded-md border border-[var(--color-accent)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-semibold text-[var(--color-accent)]">
                        {rootWord.root}
                      </span>
                    )}
                    {rootWord.suffix && (
                      <span className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[var(--color-ink-soft)]">
                        {rootWord.suffix}
                      </span>
                    )}
                  </div>
                )}
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
          );
        })}
      </div>
    </div>
  );
}
