import { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X, ArrowRight } from "lucide-react";
import { apiFetch } from "@/frontend/api/client";

interface SearchResult {
  id: string;
  slug: string;
  lemma: string;
  title: string;
  short_definition: string | null;
  cefr: string | null;
  pos: string | null;
}

interface SearchResponse {
  items: SearchResult[];
  total: number;
}

export function OmniPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Cmd+K / Ctrl+K to open
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open]);

  // Debounced search
  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch<SearchResponse>(`/words?q=${encodeURIComponent(q)}&limit=10`);
      setResults(res.items ?? []);
      setSelectedIndex(0);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => doSearch(query), 200);
    return () => clearTimeout(timer);
  }, [query, doSearch]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
      setResults([]);
    }
  }, [open]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[selectedIndex]) {
      e.preventDefault();
      navigate(`/words/${results[selectedIndex].slug}`);
      setOpen(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />

      {/* Search panel */}
      <div className="relative w-full max-w-2xl mx-4">
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-strong)] shadow-[var(--shadow-panel-strong)] backdrop-blur-2xl">
          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <Search className="h-5 w-5 text-[var(--color-ink-soft)]" />
            <input
              ref={inputRef}
              type="text"
              placeholder="搜索单词..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent text-lg text-[var(--color-ink)] placeholder:text-[var(--color-ink-soft)] focus:outline-none"
            />
            <button
              onClick={() => setOpen(false)}
              className="rounded-lg p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-glass-hover)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Results */}
          <div className="max-h-[50vh] overflow-y-auto p-2">
            {loading && (
              <div className="py-6 text-center text-sm text-[var(--color-ink-soft)]">
                搜索中...
              </div>
            )}

            {!loading && query && results.length === 0 && (
              <div className="py-6 text-center text-sm text-[var(--color-ink-soft)]">
                没有找到 "{query}" 相关的单词
              </div>
            )}

            {!loading && !query && (
              <div className="py-6 text-center text-sm text-[var(--color-ink-soft)]">
                输入单词开始搜索
              </div>
            )}

            {!loading && results.length > 0 && (
              <div className="space-y-1">
                {results.map((item, i) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      navigate(`/words/${item.slug}`);
                      setOpen(false);
                    }}
                    onMouseEnter={() => setSelectedIndex(i)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                      i === selectedIndex
                        ? "bg-[var(--color-surface-muted)]"
                        : "hover:bg-[var(--color-surface-glass-hover)]"
                    }`}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[var(--color-ink)]">{item.lemma}</span>
                        {item.pos && (
                          <span className="text-xs text-[var(--color-ink-soft)]">{item.pos}</span>
                        )}
                        {item.cefr && (
                          <span className="rounded-full bg-[var(--color-surface-muted)] px-1.5 py-0 text-[10px] font-medium text-[var(--color-ink-soft)]">
                            {item.cefr}
                          </span>
                        )}
                      </div>
                      {item.short_definition && (
                        <p className="text-sm text-[var(--color-ink-soft)]">{item.short_definition}</p>
                      )}
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-[var(--color-ink-soft)]" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-[var(--color-border)] px-4 py-2">
            <div className="flex items-center justify-between text-xs text-[var(--color-ink-soft)]">
              <span>↑↓ 导航 · Enter 选择 · ESC 关闭</span>
              <span>⌘K 快捷搜索</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
