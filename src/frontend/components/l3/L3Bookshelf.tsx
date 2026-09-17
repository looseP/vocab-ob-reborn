/**
 * 书架（grill 定案 c 完整版，2026-09-07）：空间前门。重度使用（2-3 篇/天）
 * → 类型筛选 + 标题/正文搜索 + 排序是核心。导入表单零摩擦：标题默认取首行。
 * 来源删除出口（2026-09-08 评估）：语境删除后来源壳会残留，书架提供逐条删除；
 * 409 阻塞（还有语境/引用/导入任务）翻译成可读提示引导先清理。
 */
import { useCallback, useEffect, useState } from "react";
import { Trash2, Tags } from "lucide-react";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { useToast } from "@/frontend/components/ui/Toast";

export interface L3SourceListItem {
  id: string; title: string; source_type: string; url: string | null; created_at: string; context_count: number;
  spaces?: string[];
}

/** 能力域固定枚举（与后端 l3_source_spaces CHECK / L3_SUB_SPACES 同值，ADR-0019 §4）。 */
export const SUB_SPACES = ["语法", "阅读", "作文", "翻译", "通用"] as const;
type SubSpace = (typeof SUB_SPACES)[number];

/** 来源类型标签（单一真源）：书架行与素材宇宙的「最近导入」共用。 */
export const TYPE_LABELS: Record<string, string> = {
  web: "公众号/网页", article: "文章/真题", manual: "手动/作文",
  book: "书", video: "视频", audio: "音频", chat: "对话", other: "其他",
};
const FILTERABLE = ["web", "article", "manual", "book", "other"];

/** 来源删除 409 阻塞详情 → 可读文案（blockers 计数字段 → 中文标签）。 */
export function sourceDeleteBlockerMessage(details: unknown): string {
  const blockers = (details as { blockers?: Record<string, unknown> } | undefined)?.blockers;
  if (!blockers) return "该来源存在关联数据，暂不能删除";
  const parts: string[] = [];
  if (typeof blockers.contextCount === "number" && blockers.contextCount > 0) parts.push(`${blockers.contextCount} 条语境`);
  if (typeof blockers.inboundContextLinkCount === "number" && blockers.inboundContextLinkCount > 0) parts.push(`${blockers.inboundContextLinkCount} 条语境链接引用`);
  if (typeof blockers.importJobCount === "number" && blockers.importJobCount > 0) parts.push(`${blockers.importJobCount} 个导入任务`);
  return parts.length > 0 ? `先清理该来源的 ${parts.join("和 ")}，再删除来源` : "该来源存在关联数据，暂不能删除";
}

export function L3Bookshelf({ onOpen }: { onOpen: (sourceId: string) => void }) {
  const [items, setItems] = useState<L3SourceListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [sourceType, setSourceType] = useState<string | undefined>(undefined);
  const [space, setSpace] = useState<SubSpace | undefined>(undefined);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "captures">("recent");
  const [importing, setImporting] = useState(false);
  const [importTitle, setImportTitle] = useState("");
  const [importText, setImportText] = useState("");
  const [importType, setImportType] = useState("article");
  const [importSpaces, setImportSpaces] = useState<string[]>(["通用"]);
  const [saving, setSaving] = useState(false);
  // 卡片就地打标（V0）：编辑中的来源 id + 草稿标签。
  const [editingSpacesId, setEditingSpacesId] = useState<string | null>(null);
  const [spacesDraft, setSpacesDraft] = useState<string[]>([]);
  const [savingSpaces, setSavingSpaces] = useState(false);
  const { addToast } = useToast();

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ sort });
      if (sourceType) params.set("sourceType", sourceType);
      if (space) params.set("space", space);
      if (q.trim()) params.set("q", q.trim());
      const res = await apiFetch<{ items: L3SourceListItem[]; total: number }>(`/l3/sources?${params}`, { timeoutMs: 20_000 });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      addToast("error", err instanceof BrowserApiError ? err.message : "书架加载失败");
      setItems([]);
    }
  }, [sourceType, space, q, sort, addToast]);

  useEffect(() => { void load(); }, [load]);

  // 来源删除（2026-09-08）：confirm 后走既有 DELETE /l3/sources/:id；
  // 服务端 blockers 409 保护（语境/入站引用/导入任务），occurrences 随 FK cascade。
  const deleteSource = async (item: L3SourceListItem) => {
    if (!window.confirm(`删除来源「${item.title.slice(0, 40)}」？对应高亮将一并移除，此操作不可恢复。`)) return;
    try {
      await apiFetch(`/l3/sources/${encodeURIComponent(item.id)}`, { method: "DELETE", timeoutMs: 20_000 });
      addToast("success", "已删除该来源");
      await load();
    } catch (err) {
      if (err instanceof BrowserApiError && err.status === 409) {
        addToast("error", sourceDeleteBlockerMessage(err.details));
      } else {
        addToast("error", err instanceof BrowserApiError ? err.message : "删除失败，请重试");
      }
    }
  };

  // V0 就地打标：PUT /l3/sources/:id/spaces 全量替换；至少保留一个能力域。
  const startEditSpaces = (item: L3SourceListItem) => {
    setEditingSpacesId(item.id);
    setSpacesDraft(item.spaces && item.spaces.length > 0 ? [...item.spaces] : ["通用"]);
  };

  const saveSpaces = async (item: L3SourceListItem) => {
    if (savingSpaces) return;
    if (spacesDraft.length === 0) {
      addToast("error", "至少保留一个能力域标签");
      return;
    }
    setSavingSpaces(true);
    try {
      await apiFetch(`/l3/sources/${encodeURIComponent(item.id)}/spaces`, {
        method: "PUT",
        body: JSON.stringify({ spaces: spacesDraft }),
        timeoutMs: 20_000,
      });
      addToast("success", "能力域标签已更新");
      setEditingSpacesId(null);
      await load();
    } catch (err) {
      addToast("error", err instanceof BrowserApiError ? err.message : "标签保存失败，请重试");
    } finally {
      setSavingSpaces(false);
    }
  };

  const toggleIn = (list: string[], v: string): string[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const submitImport = async () => {
    const text = importText.trim();
    if (!text || saving) return;
    setSaving(true);
    try {
      const res = await apiFetch<{ source: { id: string } }>("/l3/sources", {
        method: "POST",
        body: JSON.stringify({
          sourceType: importType,
          title: importTitle.trim() || text.split("\n")[0].slice(0, 80),
          contentText: text,
          spaces: importSpaces.length > 0 ? importSpaces : ["通用"],
        }),
        timeoutMs: 20_000,
      });
      addToast("success", "已导入书架");
      setImporting(false); setImportText(""); setImportTitle(""); setImportSpaces(["通用"]);
      await load();
      onOpen(res.source.id);
    } catch (err) {
      if (err instanceof BrowserApiError && err.status === 409) {
        addToast("error", "书架中已存在相同内容的文章，未重复导入");
      } else {
        addToast("error", err instanceof BrowserApiError ? err.message : "导入失败，请重试");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setImporting((v) => !v)}
          className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs text-[var(--color-accent-contrast,var(--color-surface))]">导入文章</button>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题/正文…"
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs" />
        <button type="button" onClick={() => setSort(sort === "recent" ? "captures" : "recent")}
          className="rounded border border-[var(--color-border)] px-2 py-1 text-xs">{sort === "recent" ? "最新" : "圈记最多"}</button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setSourceType(undefined)}
          className={`rounded-full px-3 py-1 text-xs ${sourceType === undefined ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]" : "border border-[var(--color-border)] text-[var(--color-ink-soft)]"}`}>全部 ({total})</button>
        {FILTERABLE.map((t) => (
          <button key={t} type="button" onClick={() => setSourceType(sourceType === t ? undefined : t)}
            className={`rounded-full px-3 py-1 text-xs ${sourceType === t ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]" : "border border-[var(--color-border)] text-[var(--color-ink-soft)]"}`}>{TYPE_LABELS[t]}</button>
        ))}
      </div>
      {/* 能力域筛选（V0 接通子空间轴）：与类型/搜索叠加；单值切换，再点取消 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-[var(--color-ink-soft)]">能力域</span>
        {SUB_SPACES.map((sp) => (
          <button key={sp} type="button" onClick={() => setSpace(space === sp ? undefined : sp)}
            className={`rounded-full px-2.5 py-0.5 text-[11px] ${space === sp ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]" : "border border-[var(--color-border)] text-[var(--color-ink-soft)]"}`}>{sp}</button>
        ))}
      </div>
      {importing && (
        <div className="space-y-2 rounded-xl border border-[var(--color-accent)] p-3">
          <input value={importTitle} onChange={(e) => setImportTitle(e.target.value)} placeholder="标题（留空自动取正文首行）"
            className="w-full rounded border border-[var(--color-border)] px-2 py-1 text-sm" />
          <textarea value={importText} onChange={(e) => setImportText(e.target.value)}
            onBlur={() => { if (!importTitle.trim() && importText.trim()) setImportTitle(importText.trim().split("\n")[0].slice(0, 80)); }}
            placeholder="粘贴正文（公众号文章 / 真题阅读 / 作文）"
            rows={8} className="w-full rounded border border-[var(--color-border)] px-2 py-1 text-[13px]" />
          <div className="flex flex-wrap items-center gap-2">
            <select value={importType} onChange={(e) => setImportType(e.target.value)} className="rounded border border-[var(--color-border)] px-2 py-1 text-xs">
              {Object.entries(TYPE_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            {/* 能力域多选：真题阅读勾「阅读」、作文勾「作文」；不勾提交时后端归一「通用」 */}
            <div className="flex flex-wrap items-center gap-1">
              {SUB_SPACES.map((sp) => (
                <label key={sp} className="flex cursor-pointer items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px]">
                  <input type="checkbox" className="h-3 w-3" checked={importSpaces.includes(sp)}
                    onChange={() => setImportSpaces((cur) => toggleIn(cur, sp))} />
                  {sp}
                </label>
              ))}
            </div>
            <button type="button" disabled={saving || !importText.trim()} onClick={() => void submitImport()}
              className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50">导入</button>
          </div>
        </div>
      )}
      <ul className="space-y-2">
        {(items ?? []).map((item) => (
          <li key={item.id} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => onOpen(item.id)}
                className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--color-ink)]">{item.title}</span>
                  {(item.spaces ?? []).map((sp) => (
                    <span key={sp} className="shrink-0 rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[10px] text-[var(--color-accent)]">{sp}</span>
                  ))}
                  <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-ink-soft)]">{TYPE_LABELS[item.source_type] ?? item.source_type}</span>
                  <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-ink-soft)]">{item.context_count} 语境</span>
                </div>
              </button>
              {/* 打标与删除均为卡片兄弟节点（button 不可嵌套），不触发 onOpen */}
              <button type="button" aria-label={`编辑能力域标签 ${item.title}`} title="编辑能力域标签"
                onClick={() => { startEditSpaces(item); }}
                className="shrink-0 rounded-lg border border-[var(--color-border)] p-2 text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
                <Tags className="h-3.5 w-3.5" />
              </button>
              <button type="button" aria-label={`删除来源 ${item.title}`} title="删除来源"
                onClick={() => void deleteSource(item)}
                className="shrink-0 rounded-lg border border-[var(--color-border)] p-2 text-[var(--color-ink-soft)] transition-colors hover:border-red-400 hover:text-red-500">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {editingSpacesId === item.id && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--color-accent)] bg-[var(--color-surface)] px-2.5 py-2"
                // 阻止冒泡是防御性：编辑器不在卡片内，但避免未来嵌套调整误触导航
                onClick={(e) => e.stopPropagation()}>
                <span className="text-[11px] text-[var(--color-ink-soft)]">能力域（至少一个）</span>
                {SUB_SPACES.map((sp) => (
                  <label key={sp} className="flex cursor-pointer items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px]">
                    <input type="checkbox" className="h-3 w-3" checked={spacesDraft.includes(sp)}
                      onChange={() => setSpacesDraft((cur) => toggleIn(cur, sp))} />
                    {sp}
                  </label>
                ))}
                <button type="button" disabled={savingSpaces} onClick={() => void saveSpaces(item)}
                  className="ml-auto rounded bg-[var(--color-accent)] px-2.5 py-1 text-[11px] text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50">保存</button>
                <button type="button" onClick={() => setEditingSpacesId(null)}
                  className="rounded border border-[var(--color-border)] px-2.5 py-1 text-[11px] text-[var(--color-ink-soft)]">取消</button>
              </div>
            )}
          </li>
        ))}
        {items !== null && items.length === 0 && <li className="text-sm text-[var(--color-ink-soft)]">书架空空如也——导入第一篇文章吧</li>}
      </ul>
    </div>
  );
}
