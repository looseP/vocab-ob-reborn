import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Search, Users, History, X } from "lucide-react";
import { Input } from "@/frontend/components/ui/Input";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { apiFetch } from "@/frontend/api/client";

interface PlazaCollectionSummary {
  slug: string;
  title: string;
  kind: "semantic_field";
  count: number;
  updatedAt: string;
}
interface PlazaGroup {
  kind: "semantic_field";
  label: string;
  count: number;
  collections: PlazaCollectionSummary[];
}
interface PlazaOverview {
  available: boolean;
  counts: { showing: number; total: number };
  groups: PlazaGroup[];
  total: number;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

export function PlazaPage() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [data, setData] = useState<PlazaOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedSetQuery = useCallback((value: string) => {
    setQuery(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(value), 300);
  }, []);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    const query = params.toString();
    apiFetch<PlazaOverview>(`/plaza${query ? `?${query}` : ""}`, { signal })
      .then((result) => setData(result))
      .catch((err) => {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : "加载词汇广场失败");
      })
      .finally(() => {
        if (signal?.aborted) return;
        setLoading(false);
      });
  }, [debouncedQuery]);

  // 最近搜索持久化（localStorage，最多 6 条，最近优先）
  useEffect(() => {
    try {
      const raw = localStorage.getItem("vocab-plaza-recent");
      setRecent(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    if (debouncedQuery.trim()) {
      setRecent((prev) => {
        const next = [debouncedQuery.trim(), ...prev.filter((t) => t !== debouncedQuery.trim())].slice(0, 6);
        try {
          localStorage.setItem("vocab-plaza-recent", JSON.stringify(next));
        } catch {
          /* 忽略 localStorage 写入失败 */
        }
        return next;
      });
    }
  }, [debouncedQuery]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const applySearch = useCallback((value: string) => {
    setQuery(value);
    setDebouncedQuery(value);
  }, []);

  const removeRecent = useCallback((term: string) => {
    setRecent((prev) => {
      const next = prev.filter((t) => t !== term);
      try {
        localStorage.setItem("vocab-plaza-recent", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">词汇广场</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">
          按主题浏览整组词汇——从词库实时聚合的语义场集合（自生长，随词库精修自动更新）
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-soft)]" />
          <Input
            type="search"
            placeholder="搜索语义场（如：学校、太空、健康）..."
            value={query}
            onChange={(e) => debouncedSetQuery(e.target.value)}
            className="w-full pl-11"
          />
        </div>
      </div>

      {query === "" && recent.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <History className="h-4 w-4 text-[var(--color-ink-soft)]" />
          {recent.map((term) => (
            <span
              key={term}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--color-pill-border)] bg-[var(--color-pill-bg)] py-1 pl-3 pr-1.5 text-sm text-[var(--color-pill-text)]"
            >
              <button type="button" onClick={() => applySearch(term)} className="hover:underline">
                {term}
              </button>
              <button
                type="button"
                aria-label={`删除最近搜索「${term}」`}
                onClick={() => removeRecent(term)}
                className="rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {loading && !data ? (
        <Card className="flex items-center justify-center py-12">
          <Spinner />
          <span className="ml-3 text-[var(--color-ink-soft)]">加载中...</span>
        </Card>
      ) : error ? (
        <Card className="py-12 text-center">
          <p className="text-[var(--color-accent-2)]">{error}</p>
        </Card>
      ) : data && data.counts.total === 0 ? (
        <Card className="py-12 text-center">
          <p className="text-[var(--color-ink-soft)]">
            还没有语义场集合。词库导入 L1 词汇批次后，这里会自动按主题分组展示。
          </p>
        </Card>
      ) : data && data.counts.showing === 0 ? (
        <Card className="py-12 text-center">
          <p className="text-[var(--color-ink-soft)]">没有匹配的语义场，换个关键词试试。</p>
        </Card>
      ) : (
        data?.groups.map((group) => (
          <section key={group.kind} className="space-y-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
                  已加载 {data.counts.showing} / {data.counts.total} 个语义场
                </p>
                <h2 className="section-title flex items-center gap-2 text-lg font-bold text-[var(--color-ink)]">
                  <Users className="h-5 w-5 text-[var(--color-accent)]" />
                  {group.label}
                </h2>
              </div>
              <p className="text-sm text-[var(--color-ink-soft)]">{group.count} 个主题</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.collections.map((collection) => (
                <Link key={collection.slug} to={`/plaza/${encodeURIComponent(collection.slug)}`}>
                  <Card className="h-full transition-colors hover:border-[var(--color-border-strong)]">
                    <div className="flex items-start justify-between gap-4">
                      <Badge tone="warm">{group.label}</Badge>
                      <span className="text-xs text-[var(--color-ink-soft)]">
                        {collection.updatedAt ? formatDate(collection.updatedAt) : ""}
                      </span>
                    </div>
                    <h3 className="section-title mt-4 text-xl font-bold text-[var(--color-ink)]">
                      {collection.title}
                    </h3>
                    <div className="mt-3 flex items-center gap-2">
                      <Badge>关联词条 {collection.count}</Badge>
                    </div>
                    <p className="mt-4 text-sm font-semibold text-[var(--color-accent)]">查看集合 →</p>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
