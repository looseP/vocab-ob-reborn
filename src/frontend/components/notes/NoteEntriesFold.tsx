import { useState, type ReactNode } from "react";
import { Check, EyeOff, Pencil, Plus, StickyNote, X } from "lucide-react";

import { Button } from "@/frontend/components/ui/Button";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { useToast } from "@/frontend/components/ui/Toast";
import {
  NoteEntryContent,
  NoteKindChips,
  NOTE_ENTRY_TA_CLASS,
  noteKindMeta,
} from "@/frontend/components/notes/noteEntryUi";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import type { ReviewNoteEntry } from "@/frontend/hooks/useReview";

/** 键盘提示小胶囊（与 ReviewCardView 的同名辅助同款样式）。 */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="ml-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink-soft)]">
      {children}
    </kbd>
  );
}

/**
 * 卡面笔记折叠（F1-F4，2026-10-10 设计《ux-notes-redesign》）：
 *  F1 Markdown + 单换行渲染（NoteEntryContent）；F2 条目区块化 + 输入区默认收起 28px；
 *  F3 kind 标签（chip 内联正文首行，general 不显示）；F4 悬停就地编辑/隐藏（非破坏）。
 * 所有交互 stopPropagation —— 在复习卡背上「卡片容器点击 = 翻回词形」，不能被冒泡触发。
 *
 * 现由两个卡面共用：复习卡背（ReviewCardView）与首学卡面（EncodeCardView，无翻卡，
 * stopPropagation 在那边无害）。折叠/输入区/编辑态的开关留在组件内部；只有条目列表
 * 与草稿由调用方持有 —— 因为调用方要在切卡时重置、并在评分前兜底提交草稿。
 */
export function NoteEntriesFold({
  slug,
  entries,
  draft,
  onDraftChange,
  onInsert,
  onUpdate,
  onHide,
}: {
  slug: string;
  entries: ReviewNoteEntry[];
  draft: string;
  onDraftChange: (value: string) => void;
  onInsert: (entry: ReviewNoteEntry) => void;
  onUpdate: (entry: ReviewNoteEntry) => void;
  onHide: (entryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [pickKind, setPickKind] = useState("general");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const { addToast } = useToast();

  const add = async () => {
    const content = draft.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ entry: ReviewNoteEntry }>(
        `/words/${encodeURIComponent(slug)}/notes/entries`,
        {
          method: "POST",
          body: JSON.stringify({ content_md: content, kind: pickKind }),
          timeoutMs: 20_000,
        },
      );
      onInsert(res.entry);
      onDraftChange("");
      setAddOpen(false);
      addToast("success", "已添加一条笔记");
    } catch (err) {
      addToast("error", err instanceof BrowserApiError ? err.message : "添加失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (!editingId || editBusy) return;
    const content = editDraft.trim();
    if (!content) return;
    setEditBusy(true);
    try {
      const res = await apiFetch<{ entry: ReviewNoteEntry }>(
        `/words/${encodeURIComponent(slug)}/notes/entries/${encodeURIComponent(editingId)}`,
        { method: "PUT", body: JSON.stringify({ content_md: content }), timeoutMs: 20_000 },
      );
      onUpdate(res.entry);
      setEditingId(null);
      setEditDraft("");
      addToast("success", "已更新这条笔记");
    } catch (err) {
      addToast("error", err instanceof BrowserApiError ? err.message : "保存失败，请重试");
    } finally {
      setEditBusy(false);
    }
  };

  const hide = async (entry: ReviewNoteEntry) => {
    try {
      await apiFetch(
        `/words/${encodeURIComponent(slug)}/notes/entries/${encodeURIComponent(entry.id)}/hide`,
        { method: "POST", timeoutMs: 20_000 },
      );
      onHide(entry.id);
      addToast("success", "已隐藏 —— 评分时不再出现，详情页可恢复");
    } catch (err) {
      addToast("error", err instanceof BrowserApiError ? err.message : "隐藏失败");
    }
  };

  const iconBtn =
    "flex h-[22px] w-[22px] items-center justify-center rounded-md text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]";

  return (
    <div className="mt-3 w-full text-left" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[var(--color-border-strong)] px-3 py-1 text-xs text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        <StickyNote className="h-3 w-3" />
        {entries.length > 0
          ? `${entries.length} 条笔记${open ? " —— 点击收起" : " —— 点击展开"}`
          : "记一条笔记"}
        {!open && entries.length > 0 && " · ✏️"}
      </button>
      {open && (
        <div className="mt-2 w-full rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3">
          {entries.length === 0 && (
            <p className="mb-1 text-[11.5px] text-[var(--color-ink-soft)]">
              还没有笔记。点下面记一条，一条只记一个点。
            </p>
          )}
          <div className="flex flex-col gap-2">
            {entries.map((entry) => {
              const meta = noteKindMeta(entry.kind);
              return (
                <div
                  key={entry.id}
                  className="group relative rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] py-1.5 pl-2.5 pr-[30px] transition-colors hover:border-[var(--color-border-strong)]"
                  onClick={(e) => e.stopPropagation()}
                >
                  {editingId === entry.id ? (
                    <div>
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                            e.preventDefault();
                            void saveEdit();
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className={NOTE_ENTRY_TA_CLASS}
                        style={{ minHeight: 52 }}
                      />
                      <div className="mt-1.5 flex items-center gap-2">
                        {meta && (
                          <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${meta.chipClass}`}>
                            {meta.label}
                          </span>
                        )}
                        <Button size="sm" onClick={() => void saveEdit()} disabled={editBusy || !editDraft.trim()}>
                          {editBusy ? <Spinner className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                          保存
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingId(null);
                            setEditDraft("");
                          }}
                        >
                          <X className="h-3 w-3" />
                          取消
                        </Button>
                        <span className="ml-auto text-[11px] text-[var(--color-ink-soft)]">
                          <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd>
                        </span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          type="button"
                          aria-label="编辑此条"
                          title="编辑此条"
                          className={iconBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(entry.id);
                            setEditDraft(entry.content_md);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label="隐藏此条"
                          title="隐藏（非破坏，详情页可恢复）"
                          className={iconBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            void hide(entry);
                          }}
                        >
                          <EyeOff className="h-3.5 w-3.5" />
                        </button>
                      </span>
                      <NoteEntryContent content={entry.content_md} kind={entry.kind} />
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {!addOpen ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setAddOpen(true);
              }}
              className="mt-2 flex h-7 w-full items-center gap-1.5 rounded-lg border border-dashed border-[var(--color-border-strong)] px-2.5 text-xs text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              <Plus className="h-3 w-3" />
              {entries.length > 0 ? "再记一条…" : "记一条笔记…"}
            </button>
          ) : (
            <div className="mt-2" onClick={(e) => e.stopPropagation()}>
              <textarea
                autoFocus
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                    e.preventDefault();
                    void add();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                placeholder="一条笔记记一个点…"
                className={NOTE_ENTRY_TA_CLASS}
              />
              <div className="mt-1.5">
                <NoteKindChips value={pickKind} onChange={setPickKind} />
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" onClick={() => void add()} disabled={busy || !draft.trim()}>
                  {busy ? <Spinner className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                  添加条目
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)} disabled={busy}>
                  取消
                </Button>
                <span className="ml-auto text-[11px] text-[var(--color-ink-soft)]">
                  <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> 提交
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
