import { useEffect, useState } from "react";
import { apiFetch } from "@/frontend/api/client";

export interface WordListItem {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  short_definition: string | null;
  is_published: boolean;
}

interface WordListResponse {
  items: WordListItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function useWords(params?: { page?: number; pageSize?: number; q?: string; cefr?: string }) {
  const [words, setWords] = useState<WordListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    // 竞态防护：参数变化（切筛选/搜索/翻页）时中止上一个请求，
    // 避免"后发先回"导致旧结果覆盖新结果（列表错乱）。
    const controller = new AbortController();
    const searchParams = new URLSearchParams();
    if (params?.pageSize) searchParams.set("limit", String(params.pageSize));
    if (params?.q) searchParams.set("q", params.q);
    if (params?.cefr) searchParams.set("cefr", params.cefr);

    const query = searchParams.toString();
    setLoading(true);
    apiFetch<WordListResponse>(`/words${query ? `?${query}` : ""}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setWords(result.items ?? []);
        setTotal(result.total ?? 0);
        setError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "加载词条失败");
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
      });
    return () => controller.abort();
  }, [params?.page, params?.pageSize, params?.q, params?.cefr]);

  return { words, loading, error, total };
}
