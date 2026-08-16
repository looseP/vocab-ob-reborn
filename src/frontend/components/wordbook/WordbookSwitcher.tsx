import { useEffect, useState } from "react";
import { BookMarked, ChevronDown, Check } from "lucide-react";
import { apiFetch } from "@/frontend/api/client";

interface Wordbook {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
}

interface WordbooksResponse {
  items: Wordbook[];
  total: number;
}

export function WordbookSwitcher() {
  const [wordbooks, setWordbooks] = useState<Wordbook[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<WordbooksResponse>("/wordbooks")
      .then((result) => {
        setWordbooks(result.items ?? []);
        const saved = localStorage.getItem("activeWordbookId");
        const defaultWb = result.items.find((wb) => wb.isDefault);
        setActiveId(saved ?? defaultWb?.id ?? result.items[0]?.id ?? null);
      })
      .catch(() => setWordbooks([]))
      .finally(() => setLoading(false));
  }, []);

  const activeWordbook = wordbooks.find((wb) => wb.id === activeId);

  const selectWordbook = (id: string) => {
    setActiveId(id);
    localStorage.setItem("activeWordbookId", id);
    setOpen(false);
  };

  if (loading || wordbooks.length === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-glass)] px-3 py-1.5 text-sm font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface-glass-hover)]"
      >
        <BookMarked className="h-3.5 w-3.5 text-[var(--color-accent)]" />
        <span className="max-w-[120px] truncate">{activeWordbook?.name ?? "词本"}</span>
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-56 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-strong)] p-1.5 shadow-[var(--shadow-panel-strong)] backdrop-blur-xl">
            {wordbooks.map((wb) => (
              <button
                key={wb.id}
                onClick={() => selectWordbook(wb.id)}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm text-[var(--color-ink)] transition-colors hover:bg-[var(--color-surface-glass-hover)]"
              >
                <div className="flex flex-col items-start">
                  <span className="font-medium">{wb.name}</span>
                  {wb.isDefault && (
                    <span className="text-xs text-[var(--color-ink-soft)]">默认</span>
                  )}
                </div>
                {wb.id === activeId && <Check className="h-4 w-4 text-[var(--color-accent)]" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
