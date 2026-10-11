import { useCallback, useEffect, useRef, useState } from "react";
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

/** 词条内容维度（2026-10-11 生词本）：正式词条 / 生词条目 / 两者都要。 */
export type WordListScope = "content" | "stub" | "all";

type WordsQueryParams = {
  pageSize?: number;
  q?: string;
  cefr?: string;
  review?: string;
  scope?: WordListScope;
};

/**
 * 组装 /words 查询串。首屏（offset=0）与 loadMore 共用，避免两处条件漂移
 * —— 历史上「筛选条件只加在首屏、加载更多漏带」正是分页串味的根因。
 * `content`（默认）不下发 scope，既有 URL 形状不变。
 */
function buildWordsQuery(params: WordsQueryParams | undefined, offset: number): string {
  const searchParams = new URLSearchParams();
  searchParams.set("limit", String(params?.pageSize ?? 50));
  searchParams.set("offset", String(offset));
  if (params?.q) searchParams.set("q", params.q);
  if (params?.cefr) searchParams.set("cefr", params.cefr);
  if (params?.review && params.review !== "all") searchParams.set("review", params.review);
  if (params?.scope && params.scope !== "content") searchParams.set("scope", params.scope);
  return searchParams.toString();
}

/**
 * 词条库列表（P2-8）：支持 q / cefr / review / scope 筛选与「加载更多」分页。
 * 参数变化时重置列表并中止旧请求（竞态防护）；loadMore 追加下一页，同样带中止。
 *
 * `scope` 默认 `content`（服务端既有口径，排除生词条目），因此默认情况下不发
 * 这个参数——既有调用方的请求 URL 与行为完全不变；只有生词本视图才会显式带上。
 */
export function useWords(params?: {
  pageSize?: number;
  q?: string;
  cefr?: string;
  review?: string;
  scope?: WordListScope;
}) {
  const [words, setWords] = useState<WordListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const moreController = useRef<AbortController | null>(null);

  useEffect(() => {
    // 竞态防护：参数变化（切筛选/搜索）时中止上一个请求，
    // 避免"后发先回"导致旧结果覆盖新结果（列表错乱）。
    const controller = new AbortController();
    const query = buildWordsQuery(params, 0);
    setLoading(true);
    setError(null);
    // 切筛选/搜索时清空旧列表：避免切换瞬间仍显示上一步筛选的旧数据
    // （WordList 仅在 loading && words.length === 0 时展示加载态）。
    setWords([]);
    apiFetch<WordListResponse>(`/words${query ? `?${query}` : ""}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setWords(result.items ?? []);
        setTotal(result.total ?? 0);
        setHasMore(result.hasMore ?? false);
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
  }, [params?.pageSize, params?.q, params?.cefr, params?.review, params?.scope]);

  /** 追加下一页（P2-7）。offset 用当前已加载条数，筛选条件与首屏同源。 */
  const loadMore = useCallback(() => {
    if (loadingMore || loading || !hasMore) return;
    const query = buildWordsQuery(params, words.length);

    moreController.current?.abort();
    const controller = new AbortController();
    moreController.current = controller;
    setLoadingMore(true);
    apiFetch<WordListResponse>(`/words${query ? `?${query}` : ""}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setWords((prev) => [...prev, ...(result.items ?? [])]);
        setTotal(result.total ?? 0);
        setHasMore(result.hasMore ?? false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError("加载更多失败");
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoadingMore(false);
      });
  }, [
    loadingMore,
    loading,
    hasMore,
    words.length,
    params?.pageSize,
    params?.q,
    params?.cefr,
    params?.review,
    params?.scope,
  ]);

  // 卸载时中止挂起的 loadMore
  useEffect(() => () => moreController.current?.abort(), []);

  return { words, loading, loadingMore, error, total, hasMore, loadMore };
}
