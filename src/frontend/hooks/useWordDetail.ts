import { useEffect, useState } from "react";
import { apiFetch } from "@/frontend/api/client";

export interface WordDetail {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  short_definition: string | null;
  definition_md: string;
  body_md: string;
  examples: Array<{ text: string; translation?: string }>;
  prototype_text?: string | null;
  aliases: string[];
  metadata?: {
    morphology_prefix?: string;
    morphology_root?: string;
    morphology_suffix?: string;
    morphology_family?: string[];
    etymology_narrative?: string;
    mnemonic_type?: string;
    mnemonic_text?: string;
    semantic_chain?: string;
    [key: string]: unknown;
  } | null;
}

// ── 词条详情内存缓存（LRU + TTL）─────────────────────────────────────────
// 词条内容基本不可变，同一词从列表/搜索/复习/笔记多处进入时复用缓存，避免重复请求。
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;

interface CacheEntry {
  data: WordDetail;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function getCache(slug: string): WordDetail | null {
  const entry = cache.get(slug);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(slug);
    return null;
  }
  // LRU：命中后移到末尾（最近使用）
  cache.delete(slug);
  cache.set(slug, entry);
  return entry.data;
}

function setCache(slug: string, data: WordDetail): void {
  cache.delete(slug);
  cache.set(slug, { data, fetchedAt: Date.now() });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/**
 * 加载单词详情：优先命中内存缓存（命中时 loading=false 直接渲染，不闪烁）；
 * 未命中才请求 /words/{slug}，成功后写缓存。
 * 附带 AbortController 竞态防护：快速在词族链接间切换时，旧响应不会覆盖新词。
 */
export function useWordDetail(slug?: string) {
  const [word, setWord] = useState<WordDetail | null>(() => (slug ? getCache(slug) : null));
  const [loading, setLoading] = useState(() => !word);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    const cached = getCache(slug);
    if (cached) {
      setWord(cached);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    apiFetch<WordDetail>(`/words/${slug}`, { signal: controller.signal })
      .then((data) => {
        setCache(slug, data);
        setWord(data);
        setError(null);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "加载单词详情失败");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [slug]);

  return { word, loading, error };
}
