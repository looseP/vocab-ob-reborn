import { useState, useCallback, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Search, Filter, Upload, BookOpen, History, X } from "lucide-react";
import { Input } from "@/frontend/components/ui/Input";
import { Button } from "@/frontend/components/ui/Button";
import { WordList } from "@/frontend/components/words/WordList";
import { useWords } from "@/frontend/hooks/useWords";
import { useRecentSearches } from "@/frontend/hooks/useRecentSearches";
import { useWordSuggest } from "@/frontend/hooks/useWordSuggest";

const CEFR_LEVELS = ["", "A1", "A2", "B1", "B2", "C1", "C2"] as const;

export function WordsPage() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [cefr, setCefr] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const navigate = useNavigate();
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { recent, add, remove, clear } = useRecentSearches();
  // L1-2：输入联想——跟随实时输入（非防抖查询词），在输入框下方即时展示建议
  const { suggestions } = useWordSuggest(query);

  const debouncedSetQuery = useCallback((value: string) => {
    setQuery(value);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(value), 300);
  }, []);

  // A2：每次防抖提交的非空搜索记录进最近搜索（去重、最近优先）
  useEffect(() => {
    if (debouncedQuery.trim()) add(debouncedQuery.trim());
  }, [debouncedQuery, add]);

  // 点击最近搜索：立即生效，跳过防抖
  const applySearch = useCallback((value: string) => {
    setQuery(value);
    setDebouncedQuery(value);
  }, []);

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
          {/* L1-2：输入联想下拉——点击建议立即触发完整搜索 */}
          {query.trim() !== "" && suggestions.length > 0 && (
            <ul className="absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-strong)] shadow-[var(--shadow-panel)]">
              {suggestions.map((s) => (
                <li key={s.id} className="border-b border-[var(--color-border)] last:border-b-0">
                  <button
                    type="button"
                    onClick={() => applySearch(s.lemma)}
                    className="flex w-full items-baseline justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-muted)]"
                  >
                    <span className="text-sm font-semibold text-[var(--color-ink)]">{s.lemma}</span>
                    <span className="truncate text-xs text-[var(--color-ink-soft)]">
                      {s.short_definition}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
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
                onClick={() => remove(term)}
                className="rounded-full p-0.5 opacity-60 transition-opacity hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={clear}
            className="text-xs text-[var(--color-ink-soft)] hover:underline"
          >
            清空
          </button>
        </div>
      )}

      <WordList
        words={words}
        loading={loading}
        error={error}
        highlight={debouncedQuery}
        selectable={selecting}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelect}
      />
    </div>
  );
}
