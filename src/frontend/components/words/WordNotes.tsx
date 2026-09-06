import { useCallback, useEffect, useState } from "react";
import {
  Notebook,
  BookOpen,
  ChevronDown,
  ChevronRight,
  TriangleAlert,
  Plus,
  Pencil,
  EyeOff,
  RotateCcw,
  Trash2,
  X,
  Check,
} from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { Markdown } from "@/frontend/components/ui/Markdown";
import { useToast } from "@/frontend/components/ui/Toast";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";

interface WordNotesProps {
  slug: string;
  /** 教材笔记（L1 收藏集 body_md，只读渲染）——与用户批注并排，双体系统一呈现。 */
  textbookMd?: string | null;
}

/** 条目制笔记(2026-09-06):1 行/条,追加式写入;hidden_at 非空 = 已隐藏(非破坏)。 */
interface NoteEntry {
  id: string;
  content_md: string;
  hidden_at: string | null;
  created_at: string;
  updated_at: string;
}

const TA_CLASS =
  "min-h-[72px] w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-input)] p-3 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-soft)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]";

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof BrowserApiError ? err.message : err instanceof Error ? err.message : fallback;
}

/**
 * 词条详情页 · 我的批注(条目管理)。
 *
 * 与教材笔记(body_md 只读)双体系统一呈现。批注为条目制:
 * 快记一条 = POST 插入;编辑就地保存;隐藏/恢复非破坏;删除为硬删(确认保护)。
 */
export function WordNotes({ slug, textbookMd }: WordNotesProps) {
  // null = 加载中;[] = 已加载且无条目
  const [entries, setEntries] = useState<NoteEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const { addToast } = useToast();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await apiFetch<{ entries: NoteEntry[] }>(`/words/${encodeURIComponent(slug)}/notes`, {
        timeoutMs: 20_000,
      });
      setEntries(data.entries ?? []);
    } catch (err) {
      setLoadError(errorMessage(err, "加载笔记失败"));
    }
  }, [slug]);

  useEffect(() => {
    setEntries(null);
    setEditingId(null);
    setAddDraft("");
    void load();
  }, [load]);

  const all = entries ?? [];
  const visible = all.filter((entry) => entry.hidden_at === null);
  const hidden = all.filter((entry) => entry.hidden_at !== null);
  const disabled = entries === null || loadError !== null;

  const addEntry = async () => {
    const content = addDraft.trim();
    if (!content || adding || disabled) return;
    setAdding(true);
    try {
      const res = await apiFetch<{ entry: NoteEntry }>(`/words/${encodeURIComponent(slug)}/notes/entries`, {
        method: "POST",
        body: JSON.stringify({ content_md: content }),
        timeoutMs: 20_000,
      });
      setEntries((prev) => [...(prev ?? []), res.entry]);
      setAddDraft("");
      addToast("success", "已添加一条笔记");
    } catch (err) {
      addToast("error", errorMessage(err, "添加失败，请重试"));
    } finally {
      setAdding(false);
    }
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const content = editDraft.trim();
    if (!content) return;
    setBusyId(editingId);
    try {
      const res = await apiFetch<{ entry: NoteEntry }>(
        `/words/${encodeURIComponent(slug)}/notes/entries/${encodeURIComponent(editingId)}`,
        { method: "PUT", body: JSON.stringify({ content_md: content }), timeoutMs: 20_000 },
      );
      setEntries((prev) => (prev ?? []).map((entry) => (entry.id === editingId ? res.entry : entry)));
      setEditingId(null);
      setEditDraft("");
      addToast("success", "已保存");
    } catch (err) {
      addToast("error", errorMessage(err, "保存失败，请重试"));
    } finally {
      setBusyId(null);
    }
  };

  const hideEntry = async (entry: NoteEntry) => {
    setBusyId(entry.id);
    try {
      const res = await apiFetch<{ entry: NoteEntry }>(
        `/words/${encodeURIComponent(slug)}/notes/entries/${encodeURIComponent(entry.id)}/hide`,
        { method: "POST", timeoutMs: 20_000 },
      );
      setEntries((prev) => (prev ?? []).map((item) => (item.id === entry.id ? res.entry : item)));
      addToast("success", "已隐藏——可随时恢复");
    } catch (err) {
      addToast("error", errorMessage(err, "隐藏失败"));
    } finally {
      setBusyId(null);
    }
  };

  const restoreEntry = async (entry: NoteEntry) => {
    setBusyId(entry.id);
    try {
      const res = await apiFetch<{ entry: NoteEntry }>(
        `/words/${encodeURIComponent(slug)}/notes/entries/${encodeURIComponent(entry.id)}/restore`,
        { method: "POST", timeoutMs: 20_000 },
      );
      setEntries((prev) => (prev ?? []).map((item) => (item.id === entry.id ? res.entry : item)));
      addToast("success", "已恢复");
    } catch (err) {
      addToast("error", errorMessage(err, "恢复失败"));
    } finally {
      setBusyId(null);
    }
  };

  const deleteEntry = async (entry: NoteEntry) => {
    if (!window.confirm("彻底删除这条笔记？此操作不可恢复。")) return;
    setBusyId(entry.id);
    try {
      await apiFetch(`/words/${encodeURIComponent(slug)}/notes/entries/${encodeURIComponent(entry.id)}`, {
        method: "DELETE",
        timeoutMs: 20_000,
      });
      setEntries((prev) => (prev ?? []).filter((item) => item.id !== entry.id));
      if (editingId === entry.id) {
        setEditingId(null);
        setEditDraft("");
      }
      addToast("success", "已删除");
    } catch (err) {
      addToast("error", errorMessage(err, "删除失败"));
    } finally {
      setBusyId(null);
    }
  };

  const hasTextbook = typeof textbookMd === "string" && textbookMd.trim().length > 0;

  const entryActions = (entry: NoteEntry, isHidden: boolean) => (
    <div className="flex items-center gap-1">
      {isHidden ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void restoreEntry(entry)}
          disabled={busyId !== null}
          title="恢复显示"
        >
          {busyId === entry.id ? <Spinner className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
          恢复
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setEditingId(entry.id);
            setEditDraft(entry.content_md);
          }}
          disabled={busyId !== null}
          title="编辑此条"
        >
          <Pencil className="h-3.5 w-3.5" />
          编辑
        </Button>
      )}
      {!isHidden && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void hideEntry(entry)}
          disabled={busyId !== null}
          title="隐藏（非破坏，可恢复）"
        >
          <EyeOff className="h-3.5 w-3.5" />
          隐藏
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void deleteEntry(entry)}
        disabled={busyId !== null}
        title="彻底删除（不可恢复）"
        className="text-[var(--color-accent-2)]"
      >
        <Trash2 className="h-3.5 w-3.5" />
        删除
      </Button>
    </div>
  );

  const renderEntryBody = (entry: NoteEntry) => {
    if (editingId === entry.id) {
      return (
        <div onClick={(e) => e.stopPropagation()}>
          <textarea
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            className={TA_CLASS}
            placeholder="编辑这条笔记..."
          />
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={() => void saveEdit()} disabled={busyId !== null || !editDraft.trim()}>
              {busyId === entry.id ? <Spinner className="h-3 w-3" /> : <Check className="h-3 w-3" />}
              保存
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditingId(null);
                setEditDraft("");
              }}
              disabled={busyId !== null}
            >
              <X className="h-3 w-3" />
              取消
            </Button>
          </div>
        </div>
      );
    }
    return <Markdown content={entry.content_md} />;
  };

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="section-title flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
          <Notebook className="h-5 w-5 text-[var(--color-accent)]" />
          我的批注
          {entries !== null && (
            <span className="text-xs font-normal text-[var(--color-ink-soft)]">
              {visible.length} 条{hidden.length > 0 ? ` · 已隐藏 ${hidden.length}` : ""}
            </span>
          )}
        </h2>
      </div>

      {/* 教材笔记（L1 收藏集，只读）——与我的批注并排呈现 */}
      {hasTextbook && (
        <details className="group mb-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-medium text-[var(--color-ink-soft)] transition-colors group-open:text-[var(--color-ink)]">
            <BookOpen className="h-4 w-4" />
            教材笔记（L1 收藏集 · 只读）
            <ChevronRight className="ml-auto h-4 w-4 transition-transform group-open:rotate-90" />
          </summary>
          <div className="border-t border-[var(--color-border)] px-3 py-3">
            <Markdown content={textbookMd} />
          </div>
        </details>
      )}

      {entries === null && !loadError ? (
        <div className="flex items-center gap-2 py-4 text-[var(--color-ink-soft)]">
          <Spinner className="h-4 w-4" />
          加载笔记...
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-[var(--color-accent-2)] p-3">
          <p className="flex items-center gap-2 text-sm text-[var(--color-accent-2)]">
            <TriangleAlert className="h-4 w-4" />
            笔记加载失败：{loadError}。已禁用编辑。
          </p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            重试
          </Button>
        </div>
      ) : (
        <>
          {/* 快记一条:追加式写入,无覆盖冲突 */}
          <div className="mb-3">
            <textarea
              value={addDraft}
              onChange={(e) => setAddDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  void addEntry();
                }
              }}
              placeholder="记一条批注...（一条记一个点，Ctrl+Enter 快速添加）"
              className={TA_CLASS}
            />
            <div className="mt-2 flex justify-end">
              <Button size="sm" onClick={() => void addEntry()} disabled={adding || !addDraft.trim()}>
                {adding ? <Spinner className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                添加条目
              </Button>
            </div>
          </div>

          {visible.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-xs text-[var(--color-ink-soft)]">
              还没有批注——一条短笔记记一个点，比长文更容易在复习时想起。
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map((entry, index) => (
                <li key={entry.id} className="rounded-xl border border-[var(--color-border)] px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 text-sm text-[var(--color-ink)]">
                      {renderEntryBody(entry)}
                    </div>
                    {editingId !== entry.id && entryActions(entry, false)}
                  </div>
                  {editingId !== entry.id && (
                    <p className="mt-1 text-[11px] text-[var(--color-ink-soft)]">
                      第 {index + 1} 条 · {formatTime(entry.created_at)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {hidden.length > 0 && (
            <details className="group mt-3 rounded-xl border border-dashed border-[var(--color-border)]">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-[var(--color-ink-soft)] transition-colors group-open:text-[var(--color-ink)]">
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                已隐藏 {hidden.length} 条（隐藏 ≠ 删除，可恢复或彻底删除）
              </summary>
              <ul className="space-y-1.5 border-t border-[var(--color-border)] px-3 py-2">
                {hidden.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex items-start justify-between gap-3 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-[var(--color-ink-soft)]">
                        {entry.content_md.slice(0, 80)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-[var(--color-ink-soft)] opacity-75">
                        {formatTime(entry.created_at)}
                      </p>
                    </div>
                    {entryActions(entry, true)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Card>
  );
}
