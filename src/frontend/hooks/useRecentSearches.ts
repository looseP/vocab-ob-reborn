import { useCallback, useState } from "react";

const STORAGE_KEY = "vocab.recentSearches";
const MAX_ENTRIES = 8;

function readRecent(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string").slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function writeRecent(entries: string[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 存储不可用时静默降级（如隐私模式）
  }
}

/**
 * 词条库最近搜索（A2）：localStorage 持久化，去重、最多保留 8 条、最近优先。
 */
export function useRecentSearches() {
  const [recent, setRecent] = useState<string[]>(readRecent);

  const add = useCallback((query: string) => {
    const value = query.trim();
    if (!value) return;
    setRecent((prev) => {
      const next = [value, ...prev.filter((s) => s !== value)].slice(0, MAX_ENTRIES);
      writeRecent(next);
      return next;
    });
  }, []);

  const remove = useCallback((query: string) => {
    setRecent((prev) => {
      const next = prev.filter((s) => s !== query);
      writeRecent(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setRecent([]);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // 忽略
      }
    }
  }, []);

  return { recent, add, remove, clear };
}
