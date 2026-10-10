/**
 * 每日捕获子空间（M2，2026-10-10 §14 定稿）—— /l3?section=daily-capture 宿主。
 *
 * 布局（交互式预设《每日捕获-M2-子空间预设》为视觉基准）：
 *   左栏 日期流（近 30 天聚合，徽标 = 条目数 + 未回顾数；空日显示 —）
 *   右栏 当日文件视图（按 §6 投影格式渲染；条目悬停浮现
 *        [回顾✓][置要][吸收…（M3 灰置）][归档]；筛选 全部/未回顾/置要/已吸收；
 *        已归档沉底部弱区——§14 拍板②）
 *   顶栏 今晚回顾（横幅 + 聚焦未回顾；§14 拍板③：窗口固定 30 天）
 *
 * 动作点击即 PATCH 保存（§14 拍板①：置要落 meta.important），无草稿 → 无离页屏障。
 * 「＋ 类型管理」= 自定义扩展类型（6 内置 + 用户自定义；上限 ≤10）。
 */

import { useCallback, useEffect, useState } from "react";
import { Archive, Check, ChevronDown, ChevronUp, Copy, Download, Inbox, Moon, Plus, Settings2, Star, X } from "lucide-react";
import { Button } from "@/frontend/components/ui/Button";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { useToast } from "@/frontend/components/ui/Toast";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import * as client from "@/frontend/api/dailyCaptureClient";
import type {
  DailyCaptureAbsorbAction,
  DailyCaptureDay,
  DailyCaptureDaySummary,
  DailyCaptureEntry,
  DailyCaptureType,
} from "@/frontend/api/dailyCaptureClient";

/** 与服务端显示时区同口径（src/db/timezone.ts = Asia/Shanghai）——日文件按它投影。 */
const DISPLAY_TZ = "Asia/Shanghai";
const DAY_WINDOW = 30;
/** M1 seed 六类（内置标记用；自定义可改名/隐藏，内置不可删）。 */
const SEED_TYPE_KEYS = new Set(["phrase", "sentence", "method", "question", "idea", "note"]);

function todayKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return y && m && d ? `${y}-${m}-${d}` : new Date().toISOString().slice(0, 10);
}

/** 近 N 天日历日（显示时区，倒序：今天在前）。用 Intl 日键而非 UTC 截断——
 *  上海零点减整日后再按上海时区取日期，UTC 截断会把「今天」错成昨天。 */
function lastNDays(n: number): string[] {
  const out: string[] = [];
  const baseMs = Date.parse(`${todayKey()}T00:00:00+08:00`);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  for (let i = 0; i < n; i += 1) {
    out.push(fmt.format(new Date(baseMs - i * 86_400_000)));
  }
  return out;
}

function clockOf(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: DISPLAY_TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}

function apiMessage(error: unknown, fallback: string): string {
  if (error instanceof BrowserApiError) return error.message || fallback;
  return error instanceof Error ? error.message : fallback;
}

type Filter = "all" | "raw" | "important" | "absorbed";
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "raw", label: "未回顾" },
  { id: "important", label: "置要" },
  { id: "absorbed", label: "已吸收" },
];

/** 回执徽章文案（M3）：action → 展示名。 */
const ABSORB_ACTION_LABELS: Record<DailyCaptureAbsorbAction, string> = {
  bind_l3: "绑 L3",
  add_word: "入本",
  enqueue_review: "复习卡",
  file_method: "留档",
  rewrite: "改写",
  none: "归档",
};

/** 吸收队列里的一条提案（外派 agent 返回的结构化 JSON 元素）。 */
interface QueueProposal {
  entry: number;
  action: DailyCaptureAbsorbAction;
  wordSlug?: string;
  payload?: { contextText?: string; translation?: string; sourceUrl?: string };
  reason?: string;
}

/** 解析粘贴提案时的动作白名单（与服务端 DAILY_CAPTURE_ABSORB_ACTIONS 同值）。 */
const QUEUE_VALID_ACTIONS: ReadonlySet<string> = new Set([
  "bind_l3", "add_word", "enqueue_review", "file_method", "rewrite", "none",
]);

export function DailyCapturePage() {
  const { addToast } = useToast();
  const [summaries, setSummaries] = useState<DailyCaptureDaySummary[]>([]);
  const [types, setTypes] = useState<DailyCaptureType[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayKey());
  const [day, setDay] = useState<DailyCaptureDay | null>(null);
  const [dayLoading, setDayLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [tonight, setTonight] = useState(false);
  const [busyEntry, setBusyEntry] = useState<string | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueRaw, setQueueRaw] = useState("");
  const [queue, setQueue] = useState<QueueProposal[]>([]);
  const [queueBusy, setQueueBusy] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const [typesBusy, setTypesBusy] = useState(false);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");

  const summaryByDate = new Map(summaries.map((s) => [s.date, s]));
  const totalUnreviewed = summaries.reduce((sum, s) => sum + s.raw, 0);

  const refreshDays = useCallback(async (): Promise<DailyCaptureDaySummary[]> => {
    const days = await client.listDays(DAY_WINDOW);
    setSummaries(days);
    return days;
  }, []);

  const refreshTypes = useCallback(async (): Promise<DailyCaptureType[]> => {
    const rows = await client.listTypes();
    setTypes(rows);
    return rows;
  }, []);

  const loadDay = useCallback(async (date: string): Promise<DailyCaptureDay> => {
    setDayLoading(true);
    try {
      const loaded = await client.getDay(date);
      setDay(loaded);
      return loaded;
    } finally {
      setDayLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [, loadedTypes, loadedDay] = await Promise.all([refreshDays(), refreshTypes(), client.getDay(todayKey())]);
        if (cancelled) return;
        setTypes(loadedTypes);
        setDay(loadedDay);
      } catch (error) {
        if (!cancelled) addToast("error", apiMessage(error, "加载失败"));
      } finally {
        if (!cancelled) setDayLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初次装载一次性拉取
  }, []);

  const pickDay = (date: string) => {
    setSelectedDate(date);
    setDay(null);
    void loadDay(date);
  };

  /** 本地重算当前日聚合（PATCH 后即时反映到日期流，不再多拉一次）。 */
  const recomputeSelectedSummary = (entries: DailyCaptureEntry[]) => {
    const raw = entries.filter((e) => e.status === "raw").length;
    const reviewed = entries.filter((e) => e.status === "reviewed").length;
    const absorbed = entries.filter((e) => e.status === "absorbed").length;
    setSummaries((prev) => {
      const others = prev.filter((s) => s.date !== selectedDate);
      if (!prev.some((s) => s.date === selectedDate) && entries.length === 0) return others;
      const mine: DailyCaptureDaySummary = { date: selectedDate, total: entries.length, raw, reviewed, absorbed };
      return [...others, mine].sort((a, b) => (a.date < b.date ? 1 : -1));
    });
  };

  const replaceEntry = (updated: DailyCaptureEntry) => {
    setDay((prev) => {
      if (!prev || prev.date !== selectedDate) return prev;
      const entries = prev.entries.map((e) => (e.id === updated.id ? updated : e));
      recomputeSelectedSummary(entries);
      return { ...prev, entries };
    });
  };

  const actOn = async (entry: DailyCaptureEntry, input: { status?: client.DailyCaptureEntryStatus; important?: boolean }) => {
    setBusyEntry(entry.id);
    try {
      const updated = await client.patchEntry(entry.id, input);
      replaceEntry(updated);
      return updated;
    } catch (error) {
      addToast(error instanceof BrowserApiError && error.status === 401 ? "warning" : "error", apiMessage(error, "操作失败"));
      return null;
    } finally {
      setBusyEntry(null);
    }
  };

  const actReview = async (entry: DailyCaptureEntry) => {
    if (entry.status !== "raw") return;
    const updated = await actOn(entry, { status: "reviewed" });
    if (updated && tonight) {
      const left = (summaryByDate.get(selectedDate)?.raw ?? 1) - 1 + summaries.filter((s) => s.date !== selectedDate).reduce((s, x) => s + x.raw, 0);
      toastMsg(`已回顾 [#${entry.seq}] —— 今晚回顾剩 ${left} 条`);
    } else if (updated) {
      toastMsg(`已回顾 [#${entry.seq}]`);
    }
  };

  const actStar = async (entry: DailyCaptureEntry) => {
    const next = !(entry.meta?.important === true);
    const updated = await actOn(entry, { important: next });
    if (updated) toastMsg(next ? `[#${entry.seq}] 已置要 —— agent 编排时优先看它` : `[#${entry.seq}] 已取消置要`);
  };

  const actArchive = async (entry: DailyCaptureEntry) => {
    const updated = await actOn(entry, { status: "archived" });
    if (updated) toastMsg(`[#${entry.seq}] 已归档`);
  };

  const toastMsg = (msg: string) => addToast("success", msg);

  const toggleTonight = () => {
    const next = !tonight;
    setTonight(next);
    if (next) {
      setSelectedDate(todayKey());
      void loadDay(todayKey());
      setFilter("raw");
      addToast("info", "回顾模式 —— 看完一条点一个 回顾✓；重要的点 置要，明天 agent 只看置要的");
    } else {
      setFilter("all");
    }
  };

  const copyFile = async () => {
    setCopyBusy(true);
    try {
      const markdown = await client.copyFileText(selectedDate);
      await navigator.clipboard.writeText(markdown);
      addToast("success", "当日文件已复制（纯文本，可直接粘贴进笔记）");
    } catch (error) {
      addToast("error", apiMessage(error, "复制失败"));
    } finally {
      setCopyBusy(false);
    }
  };

  // ── M3 吸收侧：证据包导出 + 吸收队列 ─────────────────────────────────────

  /** 导出证据包：JSON 整包复制——贴给外部 LLM 产提案（外派模式）。 */
  const exportPack = async () => {
    setExportBusy(true);
    try {
      const pack = await client.getEvidencePack(selectedDate);
      await navigator.clipboard.writeText(JSON.stringify(pack, null, 2));
      addToast("success", `证据包已复制（${pack.entries.length} 条 + 关联词语境）——贴给 agent 产提案`);
    } catch (error) {
      addToast("error", apiMessage(error, "导出失败"));
    } finally {
      setExportBusy(false);
    }
  };

  /** 解析粘贴的提案 JSON：数组或 {proposals:[…]}；只收本日存在、动作合法的条目。 */
  const parseQueue = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(queueRaw);
    } catch {
      addToast("warning", "不是合法 JSON——粘贴 agent 返回的提案数组");
      return;
    }
    const list = Array.isArray(parsed) ? parsed : (parsed as { proposals?: unknown[] })?.proposals;
    if (!Array.isArray(list)) {
      addToast("warning", "提案应为数组（或 {proposals:[…]}）");
      return;
    }
    const bySeq = new Map(entries.map((e) => [e.seq, e] as const));
    const valid: QueueProposal[] = [];
    let skipped = 0;
    for (const item of list) {
      const p = item as QueueProposal;
      const target = bySeq.get(p?.entry);
      if (!target || typeof p?.action !== "string" || !QUEUE_VALID_ACTIONS.has(p.action)) {
        skipped += 1;
        continue;
      }
      if (target.status === "absorbed" || target.status === "archived") {
        skipped += 1;
        continue;
      }
      valid.push({ entry: p.entry, action: p.action, wordSlug: p.wordSlug, payload: p.payload, reason: p.reason });
    }
    setQueue(valid);
    addToast(valid.length > 0 ? "success" : "warning", `解析出 ${valid.length} 条可采纳提案${skipped > 0 ? `，跳过 ${skipped} 条（序号不存在/已终态）` : ""}`);
  };

  const dismissProposal = (proposal: QueueProposal) => {
    setQueue((prev) => prev.filter((q) => q !== proposal));
    addToast("info", "已驳回 —— 条目保持原状，随时可重新解析");
  };

  const adoptProposal = async (proposal: QueueProposal) => {
    const target = entries.find((e) => e.seq === proposal.entry);
    if (!target) return;
    setQueueBusy(true);
    try {
      const result = await client.absorbEntry(target.id, {
        action: proposal.action,
        wordSlug: proposal.wordSlug,
        payload: proposal.payload,
        reason: proposal.reason,
      });
      replaceEntry(result.entry);
      setQueue((prev) => prev.filter((q) => q !== proposal));
      const label = ABSORB_ACTION_LABELS[proposal.action];
      addToast(
        "success",
        result.receipt.deduped
          ? `[#${proposal.entry}] ${label}——目标已存在，幂等收尾`
          : `[#${proposal.entry}] 已${label}${result.receipt.target ? `（${result.receipt.target}）` : ""}`,
      );
    } catch (error) {
      addToast("error", apiMessage(error, "吸收失败"));
    } finally {
      setQueueBusy(false);
    }
  };

  // ── 类型管理 ──────────────────────────────────────────────────────────────
  const visibleCount = types.filter((t) => !t.hidden).length;

  const submitNewType = async () => {
    setTypesBusy(true);
    try {
      await client.createType({ typeKey: newKey.trim(), label: newLabel.trim() });
      await refreshTypes();
      setNewKey("");
      setNewLabel("");
      addToast("success", "类型已创建 —— 捕获窗条目模式立即出现该 chip");
    } catch (error) {
      addToast("error", apiMessage(error, "创建失败"));
    } finally {
      setTypesBusy(false);
    }
  };

  const mutateType = async (key: string, input: Parameters<typeof client.patchType>[1], okMsg: string) => {
    setTypesBusy(true);
    try {
      await client.patchType(key, input);
      await refreshTypes();
      void loadDay(selectedDate); // label 变化要同步到当日分节标题
      addToast("success", okMsg);
    } catch (error) {
      addToast("error", apiMessage(error, "操作失败"));
    } finally {
      setTypesBusy(false);
    }
  };

  const moveType = async (key: string, dir: -1 | 1) => {
    const sorted = [...types].sort((a, b) => a.sort - b.sort || a.type_key.localeCompare(b.type_key));
    const idx = sorted.findIndex((t) => t.type_key === key);
    const neighbor = sorted[idx + dir];
    if (!neighbor) return;
    setTypesBusy(true);
    try {
      await client.patchType(key, { sort: neighbor.sort });
      await client.patchType(neighbor.type_key, { sort: sorted[idx].sort });
      await refreshTypes();
      void loadDay(selectedDate);
    } catch (error) {
      addToast("error", apiMessage(error, "排序失败"));
    } finally {
      setTypesBusy(false);
    }
  };

  const saveRename = async (key: string) => {
    const label = renameLabel.trim();
    setRenamingKey(null);
    if (!label) return;
    await mutateType(key, { label }, "类型已改名");
  };

  // ── 渲染数据 ──────────────────────────────────────────────────────────────
  const labelByType = new Map(types.filter((t) => !t.hidden).map((t) => [t.type_key, t.label] as const));
  const entries = day?.entries ?? [];
  const visible = entries.filter((e) => {
    if (filter === "raw") return e.status === "raw";
    if (filter === "important") return e.meta?.important === true && e.status !== "archived";
    if (filter === "absorbed") return e.status === "absorbed";
    return e.status !== "archived";
  });
  const archivedEntries = filter === "all" ? entries.filter((e) => e.status === "archived") : [];
  const groups: Array<{ label: string; items: DailyCaptureEntry[] }> = [];
  for (const type of types.filter((t) => !t.hidden)) {
    const items = visible.filter((e) => e.entry_type === type.type_key);
    if (items.length > 0) groups.push({ label: type.label, items });
  }
  const known = new Set(types.map((t) => t.type_key));
  const orphans = visible.filter((e) => !known.has(e.entry_type));
  if (orphans.length > 0) groups.push({ label: "其他", items: orphans });
  const rawCount = entries.filter((e) => e.status === "raw").length;
  const reviewedCount = entries.filter((e) => e.status === "reviewed").length;
  const absorbedCount = entries.filter((e) => e.status === "absorbed").length;

  return (
    <div className="space-y-4">
      {/* 页头 */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-[var(--color-ink)]">每日捕获</h1>
          <p className="text-xs text-[var(--color-ink-soft)]">
            一天一页流水 · 学到用到先记，回顾复盘放晚上，吸收交给 agent（M3）
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant={tonight ? "secondary" : "primary"} onClick={() => void toggleTonight()}>
            <Moon className="h-4 w-4" />
            {tonight ? "关闭回顾模式" : `今晚回顾（${totalUnreviewed}）`}
          </Button>
        </div>
      </div>

      {tonight && (
        <div className="rounded-xl border border-[rgba(var(--color-accent-rgb),0.25)] bg-[var(--color-surface-muted)] px-4 py-2.5 text-[12.5px] text-[var(--color-pill-text)]">
          回顾模式 —— 从上往下通读，看完一条点一个 <b>回顾✓</b>；重要的点 <b>置要</b>，明天 agent 只看置要的。
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[224px_minmax(0,1fr)]">
        {/* 左：日期流 */}
        <section className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[var(--shadow-panel)]">
          <header className="flex items-baseline gap-2 border-b border-[var(--color-border)] px-4 pb-2.5 pt-3">
            <span className="text-[13px] font-extrabold">日期流</span>
            <span className="ml-auto text-[11px] text-[var(--color-ink-soft)]">近 {DAY_WINDOW} 天</span>
          </header>
          <div className="max-h-[560px] overflow-auto p-2">
            {lastNDays(DAY_WINDOW).map((date) => {
              const s = summaryByDate.get(date);
              const active = date === selectedDate;
              return (
                <button
                  key={date}
                  type="button"
                  onClick={() => pickDay(date)}
                  className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-[13px] ${
                    active
                      ? "bg-[var(--color-accent-soft)] font-bold text-[var(--color-accent)] shadow-[inset_0_0_0_1px_rgba(var(--color-accent-rgb),0.2)]"
                      : "text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-glass)] hover:text-[var(--color-ink)]"
                  }`}
                >
                  <span className="tabular-nums">{date.slice(5)}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {s ? (
                      <>
                        <span className={`text-[11px] font-bold ${active ? "" : "text-[var(--color-ink-soft)]"}`}>{s.total} 条</span>
                        {s.raw > 0 && (
                          <span className="rounded-full border border-[var(--color-pill-warm-border)] bg-[var(--color-pill-warm-bg)] px-1.5 text-[10px] font-bold text-[var(--color-pill-warm-text)]">
                            {s.raw} 未回顾
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-[11px] opacity-45">—</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          <footer className="flex items-center gap-1.5 border-t border-[var(--color-border)] px-3.5 py-2.5 text-[11px] text-[var(--color-ink-soft)]">
            <button
              type="button"
              onClick={() => void exportPack()}
              disabled={exportBusy}
              className="flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 py-1 font-semibold hover:border-[var(--color-border-strong)] hover:text-[var(--color-accent)] disabled:opacity-60"
            >
              {exportBusy ? <Spinner className="h-3 w-3" /> : <Download className="h-3 w-3" />}
              导出证据包
            </button>
            <button
              type="button"
              onClick={() => setQueueOpen(true)}
              className="flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 py-1 font-semibold hover:border-[var(--color-border-strong)] hover:text-[var(--color-accent)]"
            >
              <Inbox className="h-3 w-3" />
              吸收队列{queue.length > 0 ? `（${queue.length}）` : ""}
            </button>
            <span className="ml-auto text-[10px]">M3：导出 → agent 提案 → 回队列采纳</span>
          </footer>
        </section>

        {/* 右：当日文件视图 */}
        <section className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[var(--shadow-panel)]">
          <header className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 pb-2.5 pt-3">
            <span className="text-[15px] font-extrabold text-[var(--color-ink)]">
              每日捕获 · {selectedDate}
              <small className="ml-2 text-[11px] font-semibold text-[var(--color-ink-soft)]">确定性投影 · 与复制内容逐字一致</small>
            </span>
            <div className="ml-auto flex items-center gap-2">
              <div className="flex rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-glass)] p-0.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => setFilter(f.id)}
                    className={`rounded-lg px-2.5 py-1 text-[11.5px] font-semibold ${
                      filter === f.id
                        ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast)]"
                        : "text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setTypesOpen(true)}
                className="flex items-center gap-1 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-glass)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--color-ink-soft)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-accent)]"
              >
                <Settings2 className="h-3.5 w-3.5" />
                类型管理
              </button>
              <button
                type="button"
                onClick={() => void copyFile()}
                disabled={copyBusy}
                className="flex items-center gap-1 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface-glass)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--color-ink-soft)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-accent)] disabled:opacity-60"
              >
                {copyBusy ? <Spinner className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                复制当日文件
              </button>
            </div>
          </header>

          <div className="px-4.5 py-3.5" style={{ padding: "14px 18px 16px" }}>
            {dayLoading && !day ? (
              <p className="py-10 text-center text-sm text-[var(--color-ink-soft)]">加载中…</p>
            ) : entries.length === 0 ? (
              <p className="py-10 text-center text-sm text-[var(--color-ink-soft)]">
                今日暂无条目 —— 悬浮窗「条目」模式记一条？
              </p>
            ) : (
              <>
                <div className="mb-2.5 text-[17px] font-extrabold"># 每日捕获 · {selectedDate}</div>
                {groups.map((group) => (
                  <div key={group.label}>
                    <div className="mb-1.5 mt-3.5 text-[13.5px] font-extrabold">
                      {group.label} <span className="text-xs font-semibold text-[var(--color-ink-soft)]">({group.items.length})</span>
                    </div>
                    {group.items.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        busy={busyEntry === entry.id}
                        onReview={() => void actReview(entry)}
                        onStar={() => void actStar(entry)}
                        onArchive={() => void actArchive(entry)}
                      />
                    ))}
                  </div>
                ))}
                {archivedEntries.length > 0 && (
                  <div className="mt-2.5">
                    <div className="mb-1 mt-3 text-[13px] font-extrabold opacity-60">
                      已归档 <span className="text-xs font-semibold text-[var(--color-ink-soft)]">({archivedEntries.length})</span>
                    </div>
                    {archivedEntries.map((entry) => (
                      <div key={entry.id} className="px-2.5 py-0.5 text-xs text-[var(--color-ink-soft)] opacity-60 line-through">
                        已归档 [#{entry.seq}] {labelByType.get(entry.entry_type) ?? entry.entry_type} · {entry.content}
                      </div>
                    ))}
                  </div>
                )}
                <footer className="mt-4 flex flex-wrap items-center gap-3.5 border-t border-dashed border-[var(--color-border)] pt-2.5 text-xs text-[var(--color-ink-soft)]">
                  <span>共 <b className="text-[var(--color-ink)] tabular-nums">{entries.length}</b> 条</span>
                  <span>未回顾 <b className="text-[var(--color-ink)] tabular-nums">{rawCount}</b></span>
                  <span>已回顾 <b className="text-[var(--color-ink)] tabular-nums">{reviewedCount}</b></span>
                  <span>已吸收 <b className="text-[var(--color-ink)] tabular-nums">{absorbedCount}</b></span>
                  <span className="ml-auto opacity-70">页脚口径与 markdown 投影一致</span>
                </footer>
              </>
            )}
          </div>
        </section>
      </div>

      {/* 吸收队列弹层（M3）：粘贴 agent 提案 JSON → 逐条采纳/驳回 */}
      {queueOpen && (
        <div
          className="fixed inset-0 z-40 grid place-items-center bg-[rgba(var(--color-shadow-warm),0.35)] p-4"
          onClick={() => setQueueOpen(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-[560px] flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-panel)]"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center border-b border-[var(--color-border)] px-4 py-3">
              <span className="text-sm font-extrabold">吸收队列</span>
              <span className="ml-2 text-[11px] text-[var(--color-ink-soft)]">
                粘贴 agent 返回的提案 JSON（元素需含 entry 序号 + action）
              </span>
              <button type="button" className="ml-auto text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]" onClick={() => setQueueOpen(false)}>
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="space-y-2 overflow-auto p-3">
              {queue.length === 0 ? (
                <textarea
                  value={queueRaw}
                  onChange={(e) => setQueueRaw(e.target.value)}
                  placeholder={'[\n  { "entry": 2, "action": "bind_l3", "wordSlug": "harness",\n    "payload": { "contextText": "She harnessed…" },\n    "reason": "例句含词汇义" }\n]'}
                  rows={8}
                  className="w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-input)] p-3 font-mono text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-soft)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                />
              ) : (
                queue.map((proposal, index) => {
                  const target = entries.find((e) => e.seq === proposal.entry);
                  return (
                    <div key={`${proposal.entry}-${index}`} className="rounded-xl border border-[var(--color-border)] p-2.5">
                      <div className="flex items-center gap-2 text-[12.5px]">
                        <span className="rounded-md border border-[var(--color-pill-border)] bg-[var(--color-pill-bg)] px-1.5 py-0.5 font-mono text-[11px] font-bold text-[var(--color-pill-text)]">
                          #{proposal.entry}
                        </span>
                        <span className="font-bold text-[var(--color-ink)]">{ABSORB_ACTION_LABELS[proposal.action]}</span>
                        {proposal.wordSlug && <span className="text-[var(--color-accent)]">⤳ {proposal.wordSlug}</span>}
                        <span className="ml-auto flex items-center gap-1.5">
                          <Button size="sm" disabled={queueBusy} onClick={() => void adoptProposal(proposal)}>
                            {queueBusy ? <Spinner className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
                            采纳
                          </Button>
                          <Button size="sm" variant="ghost" disabled={queueBusy} onClick={() => dismissProposal(proposal)}>
                            驳回
                          </Button>
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11.5px] text-[var(--color-ink-soft)]">
                        {target?.content}
                        {proposal.reason ? ` —— ${proposal.reason}` : ""}
                      </p>
                    </div>
                  );
                })
              )}
            </div>
            {queue.length === 0 && (
              <footer className="flex items-center gap-2 border-t border-[var(--color-border)] p-3">
                <Button size="sm" disabled={!queueRaw.trim()} onClick={parseQueue}>
                  解析提案
                </Button>
                <span className="text-[11px] text-[var(--color-ink-soft)]">
                  采纳 = 执行动作 + 回执落库 + 条目置已吸收；驳回 = 保持原状。agent 永不直写。
                </span>
              </footer>
            )}
          </div>
        </div>
      )}

      {/* 类型管理弹层 */}
      {typesOpen && (
        <div
          className="fixed inset-0 z-40 grid place-items-center bg-[rgba(var(--color-shadow-warm),0.35)] p-4"
          onClick={() => setTypesOpen(false)}
        >
          <div
            className="w-full max-w-[520px] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-panel)]"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center border-b border-[var(--color-border)] px-4 py-3">
              <span className="text-sm font-extrabold">类型管理</span>
              <span className="ml-2 text-[11px] text-[var(--color-ink-soft)]">
                {visibleCount}/{10} 可见 · 内置可改名/隐藏，不可删除
              </span>
              <button type="button" className="ml-auto text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]" onClick={() => setTypesOpen(false)}>
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="max-h-[380px] overflow-auto p-3">
              {[...types]
                .sort((a, b) => a.sort - b.sort || a.type_key.localeCompare(b.type_key))
                .map((type) => (
                  <div key={type.type_key} className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-[var(--color-surface-glass)]">
                    <span className="flex flex-col">
                      <button type="button" aria-label={`上移 ${type.label}`} disabled={typesBusy} onClick={() => void moveType(type.type_key, -1)} className="text-[var(--color-ink-soft)] hover:text-[var(--color-accent)] disabled:opacity-40">
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" aria-label={`下移 ${type.label}`} disabled={typesBusy} onClick={() => void moveType(type.type_key, 1)} className="text-[var(--color-ink-soft)] hover:text-[var(--color-accent)] disabled:opacity-40">
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </span>
                    {renamingKey === type.type_key ? (
                      <input
                        autoFocus
                        value={renameLabel}
                        onChange={(e) => setRenameLabel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void saveRename(type.type_key); if (e.key === "Escape") setRenamingKey(null); }}
                        className="h-7 w-28 rounded-lg border border-[var(--color-accent)] bg-[var(--color-surface-input)] px-2 text-[13px]"
                      />
                    ) : (
                      <span className={`text-[13px] font-semibold ${type.hidden ? "text-[var(--color-ink-soft)] line-through opacity-60" : "text-[var(--color-ink)]"}`}>
                        {type.label}
                      </span>
                    )}
                    <code className="rounded bg-[var(--color-surface-muted)] px-1.5 text-[10px] text-[var(--color-pill-text)]">{type.type_key}</code>
                    {SEED_TYPE_KEYS.has(type.type_key) && (
                      <span className="rounded-full border border-[var(--color-pill-border)] bg-[var(--color-pill-bg)] px-1.5 text-[10px] font-bold text-[var(--color-pill-text)]">内置</span>
                    )}
                    {type.hidden && <span className="text-[10px] text-[var(--color-ink-soft)]">已隐藏</span>}
                    <span className="ml-auto flex items-center gap-1.5">
                      {renamingKey === type.type_key ? (
                        <>
                          <Button size="sm" disabled={typesBusy} onClick={() => void saveRename(type.type_key)}>保存</Button>
                          <Button size="sm" variant="ghost" onClick={() => setRenamingKey(null)}>取消</Button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={typesBusy}
                            onClick={() => { setRenamingKey(type.type_key); setRenameLabel(type.label); }}
                            className="rounded-lg border border-[var(--color-border)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-ink-soft)] hover:text-[var(--color-accent)] disabled:opacity-50"
                          >
                            改名
                          </button>
                          <button
                            type="button"
                            disabled={typesBusy}
                            onClick={() => void mutateType(type.type_key, { hidden: !type.hidden }, type.hidden ? "类型已显示" : "类型已隐藏")}
                            className="rounded-lg border border-[var(--color-border)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-ink-soft)] hover:text-[var(--color-accent)] disabled:opacity-50"
                          >
                            {type.hidden ? "显示" : "隐藏"}
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                ))}
            </div>
            <footer className="space-y-2 border-t border-[var(--color-border)] p-3">
              <div className="flex items-center gap-2">
                <input
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder="key（拉丁 slug，如 collocation）"
                  className="h-8 w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-input)] px-2.5 text-xs"
                />
                <input
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="名称（≤12 字，如 搭配）"
                  className="h-8 w-36 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-input)] px-2.5 text-xs"
                />
                <Button size="sm" className="ml-auto" disabled={typesBusy || !newKey.trim() || !newLabel.trim()} onClick={() => void submitNewType()}>
                  {typesBusy ? <Spinner className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                  新建类型
                </Button>
              </div>
              <p className="text-[11px] text-[var(--color-ink-soft)]">
                新建后捕获窗条目模式立即出现该 chip；隐藏只拦截新追加，历史条目照常渲染。
              </p>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

/** 条目行（§6 投影格式 + 悬停动作；与 mockup 同构）。 */
function EntryRow(props: {
  entry: DailyCaptureEntry;
  busy: boolean;
  onReview: () => void;
  onStar: () => void;
  onArchive: () => void;
}) {
  const { entry, busy } = props;
  const meta = entry.meta ?? {};
  const important = meta.important === true;
  const bits: string[] = [];
  if (meta.meaning) bits.push(`— ${meta.meaning}`);
  for (const w of meta.wordSlugs ?? []) bits.push(`⤳ [[${w}]]`);
  if (meta.sourceUrl) bits.push(`（来源: ${meta.sourceUrl}）`);
  return (
    <div
      className={`group relative rounded-xl border-l-2 py-1.5 pl-3 pr-2 hover:bg-[var(--color-surface-glass)] ${
        important
          ? "border-l-[rgba(178,87,47,0.45)] bg-[var(--color-surface-muted-warm)]"
          : entry.status === "reviewed"
            ? "border-l-[rgba(var(--color-accent-rgb),0.4)] bg-[var(--color-surface-muted)]"
            : "border-l-transparent"
      }`}
    >
      <div className="text-[13.5px] leading-relaxed">
        <span className="mr-1.5 rounded-md border border-[var(--color-pill-border)] bg-[var(--color-pill-bg)] px-1.5 py-0.5 font-mono text-[11px] font-bold text-[var(--color-pill-text)]">
          #{entry.seq}
        </span>
        <span className="mr-1.5 text-xs tabular-nums text-[var(--color-ink-soft)]">{clockOf(entry.created_at)}</span>
        {important && <Star className="mb-0.5 inline h-3.5 w-3.5 fill-amber-500 text-amber-500" />}
        <span className="text-[var(--color-ink)]">{entry.content}</span>
        {bits.length > 0 && <span> {bits.join(" ")}</span>}
        {entry.status === "reviewed" && (
          <span className="ml-2 rounded-full border border-[var(--color-pill-border)] bg-[var(--color-pill-bg)] px-1.5 align-[1px] text-[10px] font-bold text-[var(--color-pill-text)]">已回顾</span>
        )}
        {entry.status === "absorbed" && (
          <span className="ml-2 rounded-full bg-[var(--color-accent)] px-1.5 align-[1px] text-[10px] font-bold text-[var(--color-accent-contrast)]">已吸收</span>
        )}
        {(entry.absorption ?? []).map((receipt, i) => (
          <span
            key={`${receipt.at}-${i}`}
            className="ml-1 rounded-full border border-[var(--color-pill-border)] bg-[var(--color-pill-bg)] px-1.5 align-[1px] text-[10px] font-semibold text-[var(--color-pill-text)]"
            title={`${receipt.action}${receipt.word_slug ? ` · ${receipt.word_slug}` : ""}${receipt.deduped ? " · 幂等收尾" : ""}`}
          >
            ⇒ {ABSORB_ACTION_LABELS[receipt.action]}
          </span>
        ))}
      </div>
      {meta.translation && <div className="mt-0.5 pl-[34px] text-xs text-[var(--color-ink-soft)]">译：{meta.translation}</div>}
      <div className="absolute right-2 top-1.5 hidden items-center gap-1 group-hover:flex">
        {busy && <Spinner className="h-3.5 w-3.5" />}
        {entry.status === "raw" && (
          <ActButton onClick={props.onReview} done>
            <Check className="h-3 w-3" /> 回顾✓
          </ActButton>
        )}
        <ActButton warm onClick={props.onStar} active={important}>
          <Star className={`h-3 w-3 ${important ? "fill-amber-500 text-amber-500" : ""}`} /> 置要
        </ActButton>
        <ActButton locked title="M3 提案面开放：证据包 → agent 提案 → 采纳执行">
          吸收…
        </ActButton>
        <ActButton warm onClick={props.onArchive}>
          <Archive className="h-3 w-3" /> 归档
        </ActButton>
      </div>
    </div>
  );
}

function ActButton(props: {
  children: React.ReactNode;
  onClick?: () => void;
  warm?: boolean;
  done?: boolean;
  active?: boolean;
  locked?: boolean;
  title?: string;
}) {
  const cls = props.locked
    ? "cursor-not-allowed opacity-50"
    : props.done || props.active
      ? "border-[rgba(var(--color-accent-rgb),0.3)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
      : props.warm
        ? "hover:border-[var(--color-pill-warm-border)] hover:text-[var(--color-pill-warm-text)]"
        : "hover:border-[rgba(var(--color-accent-rgb),0.4)] hover:text-[var(--color-accent)]";
  return (
    <button
      type="button"
      title={props.title}
      disabled={props.locked}
      onClick={props.locked ? undefined : props.onClick}
      className={`inline-flex items-center gap-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-ink-soft)] ${cls}`}
    >
      {props.children}
    </button>
  );
}
