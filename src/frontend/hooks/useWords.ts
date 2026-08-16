import { useEffect, useState } from "react";
import { apiFetch } from "@/frontend/api/client";

export interface WordListItem {
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
    const searchParams = new URLSearchParams();
    if (params?.pageSize) searchParams.set("limit", String(params.pageSize));
    if (params?.q) searchParams.set("q", params.q);
    if (params?.cefr) searchParams.set("cefr", params.cefr);

    const query = searchParams.toString();
    setLoading(true);
    apiFetch<WordListResponse>(`/words${query ? `?${query}` : ""}`)
      .then((result) => {
        setWords(result.items ?? []);
        setTotal(result.total ?? 0);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [params?.page, params?.pageSize, params?.q, params?.cefr]);

  return { words, loading, error, total };
}
