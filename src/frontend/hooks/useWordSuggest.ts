import { useEffect, useState } from "react";
import { apiFetch } from "@/frontend/api/client";
import type { WordListItem } from "@/frontend/hooks/useWords";

interface SuggestResponse {
  items: WordListItem[];
}

/**
 * 词条库输入联想（L1-2）：按 lemma / 拼音前缀请求 top-N 建议。
 * 内部自带 150ms 防抖 + AbortController 竞态防护（连续输入只保留最新响应）。
 */
export function useWordSuggest(q: string, enabled = true) {
  const [suggestions, setSuggestions] = useState<WordListItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !q.trim()) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      apiFetch<SuggestResponse>(
        `/words/suggest?q=${encodeURIComponent(q.trim())}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) setSuggestions(result.items ?? []);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSuggestions([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, enabled]);

  return { suggestions, loading };
}
