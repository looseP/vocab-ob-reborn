import { useCallback, useEffect, useState } from "react";
import { Settings2, Trash2, Power } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { ProvenanceBadge } from "@/frontend/components/words/WordL2Content";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";

interface ContentRow {
  id: string;
  field: string;
  itemCount: number;
  items: Array<Record<string, unknown>>;
  source: string;
  sourceRef: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

const FIELD_LABELS: Record<string, string> = {
  collocation: "搭配",
  corpus: "例句",
  synonym: "同义辨析",
  antonym: "反义",
};

function rowLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

function itemPreview(item: Record<string, unknown>): string {
  const value = item.phrase ?? item.text ?? item.word;
  return typeof value === "string" && value.length > 0 ? value : "(条目)";
}

function errorMessage(err: unknown): string {
  return err instanceof BrowserApiError ? err.message : err instanceof Error ? err.message : "未知错误";
}

/**
 * L2 扩展内容管理面板（Phase G 管理套件）：
 * 行级列出生效/退休内容，支持停用（转存档）与硬删；所有写操作触发缓存重算。
 */
export function WordL2Manager({ slug, onChanged }: { slug: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ active: ContentRow[]; retired: ContentRow[] } | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const encodedSlug = encodeURIComponent(slug);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ active: ContentRow[]; retired: ContentRow[] }>(
        `/l2/${encodedSlug}/l2-rows`,
        { timeoutMs: 30_000 },
      );
      setRows({ active: data.active ?? [], retired: data.retired ?? [] });
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [encodedSlug]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const deactivate = async (row: ContentRow) => {
    setBusy(row.id);
    try {
      await apiFetch(`/l2/${encodedSlug}/l2-rows/${encodeURIComponent(row.id)}/deactivate`, {
        method: "POST",
        timeoutMs: 60_000,
      });
      onChanged(); // 内容变化 → 父级刷新词条详情（缓存已重算）
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: ContentRow) => {
    if (!window.confirm(`彻底删除这条「${rowLabel(row.field)}」内容？此操作不可恢复。`)) return;
    setBusy(row.id);
    try {
      await apiFetch(`/l2/${encodedSlug}/l2-rows/${encodeURIComponent(row.id)}`, {
        method: "DELETE",
        timeoutMs: 60_000,
      });
      onChanged();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2 text-sm font-medium text-[var(--color-ink)]">
          <Settings2 className="h-4 w-4 text-[var(--color-ink-soft)]" />
          管理生效内容
          {rows && (
            <span className="text-xs text-[var(--color-ink-soft)]">
              （生效 {rows.active.length} 条{rows.retired.length > 0 ? ` · 存档 ${rows.retired.length} 条` : ""}）
            </span>
          )}
        </span>
        <span className="text-xs text-[var(--color-ink-soft)]">{open ? "收起" : "展开"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {error && (
            <p className="rounded-lg border border-[var(--color-accent-2)] bg-[var(--color-surface-muted)] px-3 py-2 text-sm text-[var(--color-accent-2)]">
              {error}
            </p>
          )}
          {rows === null && (
            <div className="flex items-center justify-center py-4">
              <Spinner />
            </div>
          )}
          {rows !== null && rows.active.length === 0 && (
            <p className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-sm text-[var(--color-ink-soft)]">
              暂无生效内容行——采纳候选或确认草稿后会出现在这里。
            </p>
          )}
          {rows?.active.map((row) => (
            <div key={row.id} className="space-y-1.5 rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-[var(--color-pill-bg)] px-2 py-0.5 text-[11px] text-[var(--color-pill-text)]">
                    {rowLabel(row.field)}
                  </span>
                  <span className="text-xs text-[var(--color-ink-soft)]">
                    {row.itemCount} 条 · 采纳于 {row.approvedAt ? new Date(row.approvedAt).toLocaleString() : "—"}
                  </span>
                  {row.items.slice(0, 3).map((item, i) => (
                    <span key={i} className="font-mono text-xs text-[var(--color-ink)]">
                      {itemPreview(item)}
                    </span>
                  ))}
                  {row.itemCount > 3 && (
                    <span className="text-xs text-[var(--color-ink-soft)]">…共 {row.itemCount} 条</span>
                  )}
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="secondary" onClick={() => deactivate(row)} disabled={busy !== null}>
                    {busy === row.id ? <Spinner /> : <Power className="h-3.5 w-3.5" />}
                    停用
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(row)} disabled={busy !== null}>
                    <Trash2 className="h-3.5 w-3.5" />
                    删除
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {row.items
                  .flatMap((item) => [item])
                  .map((item, i) => (
                    <ProvenanceBadge key={i} item={item} />
                  ))
                  .slice(0, 2)}
                <span className="text-[11px] text-[var(--color-ink-soft)]">来源 {row.source}</span>
                {row.sourceRef && (
                  <span className="font-mono text-[11px] text-[var(--color-ink-soft)]">{row.sourceRef}</span>
                )}
              </div>
            </div>
          ))}
          {rows !== null && rows.retired.length > 0 && (
            <div className="space-y-2">
              <button
                type="button"
                className="text-xs text-[var(--color-ink-soft)] underline transition-colors hover:text-[var(--color-ink)]"
                onClick={() => setShowRetired((v) => !v)}
              >
                {showRetired ? "收起存档" : `展开存档（${rows.retired.length} 条已被替换/停用的内容）`}
              </button>
              {showRetired &&
                rows.retired.map((row) => (
                  <div
                    key={row.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-[var(--color-border)] p-2.5 opacity-75"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[var(--color-ink-soft)]">
                        {rowLabel(row.field)}
                      </span>
                      {row.items.slice(0, 3).map((item, i) => (
                        <span key={i} className="font-mono text-[var(--color-ink-soft)]">
                          {itemPreview(item)}
                        </span>
                      ))}
                      <span className="text-[var(--color-ink-soft)]">
                        停用于 {row.approvedAt ? new Date(row.approvedAt).toLocaleString() : "—"}
                      </span>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => remove(row)} disabled={busy !== null}>
                      <Trash2 className="h-3.5 w-3.5" />
                      彻底删除
                    </Button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
