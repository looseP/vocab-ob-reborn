import { useCallback, useEffect, useState } from "react";
import { Settings2, Trash2, Power, EyeOff, Eye } from "lucide-react";
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
  /** 条目化管理：已隐藏（保留可恢复）的生成单元。旧响应可能缺失。 */
  hiddenItems?: Array<Record<string, unknown>>;
  hiddenCount?: number;
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

/** 条目完整详情：标题行 + 详情行 + 附加元信息（管理视图据此判断保留哪些）。 */
function itemDetail(item: Record<string, unknown>): { title: string; detail: string | null; meta: string[] } {
  const title = itemPreview(item);
  const str = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  if (typeof item.phrase === "string") {
    // 搭配：释义 + 例句（含译文）
    const gloss = str(item.gloss);
    const example = str(item.example);
    const translation = str(item.exampleTranslation);
    const detail = [gloss, example ? (translation ? `${example}（${translation}）` : example) : null]
      .filter((v): v is string => v !== null)
      .join(" — ");
    return { title, detail: detail || null, meta: [] };
  }
  if (typeof item.text === "string") {
    // 例句：翻译
    return { title, detail: str(item.translation), meta: [] };
  }
  // 同义/反义辨析：结论 + 用法/区别/对象
  const meta = [
    ["用法", str(item.usage)],
    ["区别", str(item.delta)],
    ["对象", str(item.object)],
  ]
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}：${v}`);
  return { title, detail: str(item.semanticDiff), meta };
}

function errorMessage(err: unknown): string {
  return err instanceof BrowserApiError ? err.message : err instanceof Error ? err.message : "未知错误";
}

/**
 * L2 扩展内容管理面板（Phase G 管理套件）：
 * 行级列出生效/退休内容，支持停用（转存档）与硬删；所有写操作触发缓存重算。
 * 可嵌入 Composer 的 Agent 候选 tab（defaultOpen + fieldFilter 跟随字段 tab），
 * refreshKey 变化时重新拉取（保存候选后同步生效内容列表）。
 */
export function WordL2Manager({
  slug,
  onChanged,
  fieldFilter,
  defaultOpen = false,
  refreshKey = 0,
}: {
  slug: string;
  onChanged: () => void;
  /** 提供时按字段筛选行（跟随 Composer 的字段 tab）；缺省显示全部。 */
  fieldFilter?: string;
  defaultOpen?: boolean;
  refreshKey?: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
  }, [open, load, refreshKey]);

  const visibleActive = rows ? rows.active.filter((r) => !fieldFilter || r.field === fieldFilter) : [];
  const visibleRetired = rows ? rows.retired.filter((r) => !fieldFilter || r.field === fieldFilter) : [];
  const totalActive = rows?.active.length ?? 0;
  const totalRetired = rows?.retired.length ?? 0;

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

  // 条目化管理：隐藏行内单个生成单元（数据保留在行内，可随时恢复）。
  // 隐藏后条目退出展示与出题，用于"精简保留"而不删数据。
  const hideItem = async (row: ContentRow, index: number) => {
    setBusy(`${row.id}:hide:${index}`);
    try {
      await apiFetch(
        `/l2/${encodedSlug}/l2-rows/${encodeURIComponent(row.id)}/items/${index}/hide`,
        { method: "POST", timeoutMs: 60_000 },
      );
      onChanged(); // 内容变化 → 父级刷新词条详情（缓存已重算）
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  // 条目化管理：恢复一个已隐藏的生成单元。
  const restoreItem = async (row: ContentRow, hiddenIndex: number) => {
    setBusy(`${row.id}:restore:${hiddenIndex}`);
    try {
      await apiFetch(
        `/l2/${encodedSlug}/l2-rows/${encodeURIComponent(row.id)}/hidden/${hiddenIndex}/restore`,
        { method: "POST", timeoutMs: 60_000 },
      );
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
              （生效 {visibleActive.length} 条 · 存档 {visibleRetired.length} 条{fieldFilter && (totalActive !== visibleActive.length || totalRetired !== visibleRetired.length) ? ` · 全部生效 ${totalActive}` : ""}）
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
          {rows !== null && visibleActive.length === 0 && (
            <p className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-4 text-center text-sm text-[var(--color-ink-soft)]">
              {fieldFilter
                ? `「${FIELD_LABELS[fieldFilter] ?? fieldFilter}」暂无生效内容行${totalActive > 0 ? `（其他字段共 ${totalActive} 条，切换字段查看）` : ""}。`
                : "暂无生效内容行——保存候选或草稿后会出现在这里。"}
            </p>
          )}
          {visibleActive.map((row) => (
            <div key={row.id} className="space-y-1.5 rounded-lg border border-[var(--color-border)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-[var(--color-pill-bg)] px-2 py-0.5 text-[11px] text-[var(--color-pill-text)]">
                    {rowLabel(row.field)}
                  </span>
                  <span className="text-xs text-[var(--color-ink-soft)]">
                    {row.itemCount} 条 · 保存于 {row.approvedAt ? new Date(row.approvedAt).toLocaleString() : "—"}
                  </span>
                  <ProvenanceBadge item={row.items[0] ?? {}} />
                  <span className="text-[11px] text-[var(--color-ink-soft)]">来源 {row.source}</span>
                  {row.sourceRef && (
                    <span className="font-mono text-[11px] text-[var(--color-ink-soft)]">{row.sourceRef}</span>
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
              {/* 条目化管理：完整详情展示，逐条隐藏/恢复以精简保留，不删数据 */}
              <ul className="space-y-1">
                {row.items.map((item, i) => {
                  const d = itemDetail(item);
                  return (
                    <li
                      key={i}
                      className="rounded-lg border border-[var(--color-border)] px-2.5 py-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-mono text-sm font-semibold text-[var(--color-ink)]">{d.title}</p>
                          {d.detail && (
                            <p className="mt-0.5 text-xs text-[var(--color-ink)]">{d.detail}</p>
                          )}
                          {d.meta.map((m) => (
                            <p key={m} className="mt-0.5 text-[11px] text-[var(--color-ink-soft)]">{m}</p>
                          ))}
                          <div className="mt-1">
                            <ProvenanceBadge item={item} />
                          </div>
                        </div>
                        <button
                          type="button"
                          data-testid={`hide-item-${i}`}
                          aria-label={`隐藏「${d.title}」`}
                          title="隐藏此条（数据保留，随时可恢复；不出现在展示与出题中）"
                          disabled={busy !== null}
                          onClick={() => hideItem(row, i)}
                          className="shrink-0 rounded p-1 text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-accent-2)] disabled:opacity-50"
                        >
                          {busy === `${row.id}:hide:${i}` ? <Spinner /> : <EyeOff className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {(row.hiddenItems?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-dashed border-[var(--color-border)] p-2">
                  <p className="px-1 text-[11px] text-[var(--color-ink-soft)]">
                    已隐藏 {row.hiddenItems?.length} 条（不出现在展示与出题，可恢复）
                  </p>
                  <ul className="mt-1 space-y-1">
                    {(row.hiddenItems ?? []).map((item, i) => {
                      const d = itemDetail(item);
                      return (
                        <li
                          key={i}
                          className="flex items-start justify-between gap-2 rounded-lg bg-[var(--color-surface-muted)] px-2.5 py-1.5 opacity-80"
                        >
                          <div className="min-w-0">
                            <p className="font-mono text-xs text-[var(--color-ink-soft)] line-through">{d.title}</p>
                            {d.detail && (
                              <p className="mt-0.5 text-[11px] text-[var(--color-ink-soft)]">{d.detail}</p>
                            )}
                          </div>
                          <button
                            type="button"
                            data-testid={`restore-item-${i}`}
                            aria-label={`恢复「${d.title}」`}
                            title="恢复此条到生效内容"
                            disabled={busy !== null}
                            onClick={() => restoreItem(row, i)}
                            className="shrink-0 rounded p-1 text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-accent)] disabled:opacity-50"
                          >
                            {busy === `${row.id}:restore:${i}` ? <Spinner /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          ))}
          {visibleRetired.length > 0 && (
            <div className="space-y-2">
              <button
                type="button"
                className="text-xs text-[var(--color-ink-soft)] underline transition-colors hover:text-[var(--color-ink)]"
                onClick={() => setShowRetired((v) => !v)}
              >
                {showRetired ? "收起存档" : `展开存档（${visibleRetired.length} 条已被替换/停用的内容）`}
              </button>
              {showRetired &&
                visibleRetired.map((row) => (
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
