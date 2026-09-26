import { useCallback, useEffect, useMemo, useState, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X, ArrowRight, CornerDownLeft } from "lucide-react";
import { apiFetch } from "@/frontend/api/client";
import { navCommandGroups, type NavEntry } from "@/frontend/viewModels/navigationRegistry";
import { NAV_ICON, type NavIconName } from "@/frontend/components/layout/navIcons";

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

/** 一行结果：命令面板的两种条目（导航命令 / 词条搜索）压平成一个可键盘走查的列表。 */
type Row =
  | { kind: "group"; id: string; label: string }
  | { kind: "command"; id: string; entry: NavEntry }
  | { kind: "word"; id: string; word: SearchResult };

/**
 * 命令面板（2026-09-26 升级：词搜索 → 命令面板）。
 *
 * 此前它只搜单词（`GET /words?q=`），是"搜索框"不是"命令面板"：没有任何一条
 * 入口命令，用户想从键盘直达某个做题面做不到。加上导航命令后：
 *  - 空查询即列出全部入口（按族分组），面板本身成为**完整地图**；
 *  - 输入即先过滤命令（本地、零延迟），再补词条搜索（网络）。
 * 两条来源同属一个列表：↑↓ 一次走完，Enter 直达。
 */
export function OmniPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
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
      setSelectedIndex(0);
    }
  }, [open]);

  const trimmed = query.trim();

  /**
   * 行列表：命令组（族标题 + 命令）+ 词条搜索结果。
   * 空查询时只列命令（面板即地图）；有查询时命令按 label/description 过滤。
   * 分组标题不是可选行（`selectable` 判定），故 ↑↓ 只会停在真实条目上。
   */
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    for (const group of navCommandGroups()) {
      const matched = group.entries.filter((entry) => {
        if (trimmed.length === 0) return true;
        const haystack = `${entry.label} ${entry.description} ${group.label}`.toLowerCase();
        return haystack.includes(trimmed.toLowerCase());
      });
      if (matched.length === 0) continue;
      out.push({ kind: "group", id: `group:${group.family}`, label: group.label });
      for (const entry of matched) out.push({ kind: "command", id: `cmd:${entry.id}`, entry });
    }
    if (results.length > 0) {
      out.push({ kind: "group", id: "group:words", label: "词条" });
      for (const word of results) out.push({ kind: "word", id: `word:${word.id}`, word });
    }
    return out;
  }, [trimmed, results]);

  const selectable = rows.filter((row) => row.kind !== "group");

  const activate = (row: Row) => {
    if (row.kind === "command") {
      navigate(row.entry.href);
      setOpen(false);
      return;
    }
    if (row.kind === "word") {
      navigate(`/words/${row.word.slug}`);
      setOpen(false);
    }
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, selectable.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const target = selectable[selectedIndex];
      if (target) {
        e.preventDefault();
        activate(target);
      }
    }
  };

  // 查询变化后选中项可能越界（过滤掉的命令消失）→ 夹回范围内。
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, selectable.length - 1)));
  }, [selectable.length]);

  if (!open) return null;

  const renderRow = (row: Row): ReactNode => {
    if (row.kind === "group") {
      return (
        <div key={row.id} className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]">
          {row.label}
        </div>
      );
    }
    const index = selectable.indexOf(row);
    const active = index === selectedIndex;
    if (row.kind === "command") {
      const Icon = NAV_ICON[row.entry.icon as NavIconName] ?? NAV_ICON.repeat;
      return (
        <button
          key={row.id}
          data-testid="palette-command"
          onClick={() => activate(row)}
          onMouseEnter={() => setSelectedIndex(index)}
          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
            active ? "bg-[var(--color-surface-muted)]" : "hover:bg-[var(--color-surface-glass-hover)]"
          }`}
        >
          <Icon className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
          <div className="flex-1">
            <div className="text-sm font-medium text-[var(--color-ink)]">{row.entry.label}</div>
            <div className="text-xs text-[var(--color-ink-soft)]">{row.entry.description}</div>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-[var(--color-ink-soft)]" />
        </button>
      );
    }
    const item = row.word;
    return (
      <button
        key={row.id}
        data-testid="palette-word"
        onClick={() => activate(row)}
        onMouseEnter={() => setSelectedIndex(index)}
        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
          active ? "bg-[var(--color-surface-muted)]" : "hover:bg-[var(--color-surface-glass-hover)]"
        }`}
      >
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[var(--color-ink)]">{item.lemma}</span>
            {item.pos && <span className="text-xs text-[var(--color-ink-soft)]">{item.pos}</span>}
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
    );
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />

      {/* Palette panel */}
      <div className="relative w-full max-w-2xl mx-4">
        <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-strong)] shadow-[var(--shadow-panel-strong)] backdrop-blur-2xl">
          <div className="flex items-center gap-3 border-b border-[var(--color-border)] px-4 py-3">
            <Search className="h-5 w-5 text-[var(--color-ink-soft)]" />
            <input
              ref={inputRef}
              type="text"
              placeholder="输入以搜索：页面名 / 动作，或单词…"
              aria-label="命令面板"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent text-lg text-[var(--color-ink)] placeholder:text-[var(--color-ink-soft)] focus:outline-none"
            />
            <button
              onClick={() => setOpen(false)}
              aria-label="关闭命令面板"
              className="rounded-lg p-1 text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-glass-hover)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div ref={listRef} className="max-h-[55vh] overflow-y-auto p-2">
            {rows.length === 0 && (
              <div className="py-6 text-center text-sm text-[var(--color-ink-soft)]">
                {loading ? "搜索中…" : `没有匹配「${query}」的页面或词条`}
              </div>
            )}
            {rows.map(renderRow)}
          </div>

          <div className="border-t border-[var(--color-border)] px-4 py-2">
            <div className="flex items-center justify-between text-xs text-[var(--color-ink-soft)]">
              <span>↑↓ 导航 · Enter 选择 · ESC 关闭</span>
              <span className="flex items-center gap-1">
                <CornerDownLeft className="h-3 w-3" />
                ⌘K 命令面板
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
