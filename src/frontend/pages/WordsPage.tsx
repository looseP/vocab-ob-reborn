import { useState, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Search, Filter, Upload, BookOpen } from "lucide-react";
import { Input } from "@/frontend/components/ui/Input";
import { Button } from "@/frontend/components/ui/Button";
import { WordList } from "@/frontend/components/words/WordList";
import { useWords } from "@/frontend/hooks/useWords";

const CEFR_LEVELS = ["", "A1", "A2", "B1", "B2", "C1", "C2"] as const;

export function WordsPage() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [cefr, setCefr] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  const debouncedSetQuery = useCallback(
    (value: string) => {
      setQuery(value);
      const timer = setTimeout(() => setDebouncedQuery(value), 300);
      return () => clearTimeout(timer);
    },
    [],
  );

  const { words, loading, error } = useWords({
    q: debouncedQuery || undefined,
    cefr: cefr || undefined,
    pageSize: 50,
  });

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const enterSelecting = useCallback(() => {
    setSelecting((v) => {
      if (v) setSelectedIds(new Set());
      return !v;
    });
  }, []);

  const startFreeReview = useCallback(() => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    navigate(`/review?wordIds=${ids.join(",")}`);
  }, [selectedIds, navigate]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">词条库</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">浏览和管理词汇</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-soft)]" />
          <Input
            type="search"
            placeholder="搜索单词..."
            value={query}
            onChange={(e) => debouncedSetQuery(e.target.value)}
            className="w-full pl-11"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Filter className="h-4 w-4 text-[var(--color-ink-soft)]" />
          <select
            value={cefr}
            onChange={(e) => setCefr(e.target.value)}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-input)] px-3 py-2 text-sm text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none"
          >
            {CEFR_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level || "全部等级"}
              </option>
            ))}
          </select>
          <Button size="sm" variant={selecting ? "primary" : "secondary"} onClick={enterSelecting}>
            <BookOpen className="h-4 w-4" /> 自由复习
          </Button>
          {selecting && (
            <Button size="sm" variant="primary" disabled={selectedIds.size === 0} onClick={startFreeReview}>
              复习已选 ({selectedIds.size})
            </Button>
          )}
          <Link to="/import">
            <Button size="sm" variant="secondary">
              <Upload className="h-4 w-4" /> 批量导入
            </Button>
          </Link>
        </div>
      </div>

      {selecting && (
        <p className="text-sm text-[var(--color-ink-soft)]">
          勾选要复习的单词，然后点击「复习已选」进入自由复习（不评分、不写入复习数据）。
        </p>
      )}

      <WordList
        words={words}
        loading={loading}
        error={error}
        selectable={selecting}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
      />
    </div>
  );
}
