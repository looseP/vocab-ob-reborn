import { useState, useCallback } from "react";
import { Search } from "lucide-react";
import { Input } from "@/frontend/components/ui/Input";
import { WordList } from "@/frontend/components/words/WordList";
import { useWords } from "@/frontend/hooks/useWords";

export function WordsPage() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const debouncedSetQuery = useCallback(
    (value: string) => {
      setQuery(value);
      const timer = setTimeout(() => setDebouncedQuery(value), 300);
      return () => clearTimeout(timer);
    },
    [],
  );

  const { words, loading, error } = useWords({ q: debouncedQuery || undefined, pageSize: 50 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">词条库</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">浏览和管理词汇</p>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-soft)]" />
        <Input
          type="search"
          placeholder="搜索单词..."
          value={query}
          onChange={(e) => debouncedSetQuery(e.target.value)}
          className="w-full pl-11"
        />
      </div>
      <WordList words={words} loading={loading} error={error} />
    </div>
  );
}
