/**
 * 仪表盘（批次 2，2026-10-09 四段式重排）。
 *
 * 结构规矩：**行动 → 洞察 → 进度 → 档案**，首屏只说「今天该做什么」。
 *  - 行动区：今日待复习 / 今日已复习 两卡 + 开始复习（队列文案）+ 复习活动卡；
 *  - 洞察区：L1 速刷统计（含 L2 条件块）+ 漏词管理；
 *  - 进度区：掌握进度条 + 一行 badges（已掌握/在学/总数/近 7·30 天；连续打卡在头部）；
 *  - 档案区：最近笔记 + 一键遗忘（低显著入口置底）。
 *
 * 与批次 2 同时删掉的重复陈列（每个数字此前出现 2–4 次）：
 *  - 「连续打卡」「在学词数」顶卡 → 进度区 badge；
 *  - 「近期到期」预测卡 → 复习活动卡未来侧（今天/7 天/30 天同源口径）；
 *  - 「更多统计」4 卡（已掌握/总数/近 7·30 天）→ 进度区 badges；
 *  - L2 三卡 → L1 速刷统计卡内的条件块（数字不重复，块不重复）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Repeat, CheckCircle2, Notebook, TrendingUp, Flame, RotateCcw,
} from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { ReviewStatsPanel } from "@/frontend/components/review/ReviewStatsPanel";
import { LeechPanel } from "@/frontend/components/review/LeechPanel";
import { ReviewCalendar } from "@/frontend/components/review/ReviewCalendar";
import { Badge } from "@/frontend/components/ui/Badge";
import { Skeleton } from "@/frontend/components/ui/Skeleton";
import { apiFetch } from "@/frontend/api/client";
import { OneClickForgettingCard } from "@/frontend/components/forgetting/OneClickForgettingCard";

/** 队列条目只需 `queueLabel` 用来分桶计数（见 `queueHeadline`）。 */
interface QueueItem {
  queueLabel: string;
}
interface QueueData {
  stats: { total: number; remaining: number };
  session: { cardsSeen: number };
  items: QueueItem[];
}
interface NoteItem {
  id: string;
  wordLemma: string;
  contentMd: string;
  createdAt: string;
  updatedAt: string | null;
}
interface NotesData {
  items: NoteItem[];
  total: number;
}
/** GET /api/review/stats/dashboard —— 接线原项目 StatsService（Asia/Shanghai 时区）。 */
interface DashboardStats {
  totalWords: number;
  trackedWords: number;
  /**
   * 「已掌握」= `state = 'review'` 的词数（服务端给的真口径）。
   * **不要**再在本地用 `totalWords - dueToday` 推 —— 那等于把「今天没到期」当「已掌握」
   * （2026-10-07 实测：本地推出来的 6754 vs 真值 14）。
   */
  masteredWords: number;
  dueToday: number;
  reviewedToday: number;
  reviewed7d: number;
  reviewed30d: number;
  streakDays: number;
  notesCount: number;
  forecast: { dueNow: number; due7d: number; due14d: number };
  /** Phase E：L2 轨统计（已晋升 / 到期待练 / 弱信号 / 今日 L2 作答）。 */
  l2?: { promoted: number; dueNow: number; weakSignal: number; reviewedToday: number };
}

function StatCard({ icon: Icon, label, value, color, loading, suffix, hint }: {
  icon: typeof Repeat;
  label: string;
  value: number | string;
  color: string;
  loading?: boolean;
  suffix?: string;
  /** 口径说明（悬停提示）—— 数字的口径差异靠它讲清，不占版面。 */
  hint?: string;
}) {
  return (
    <Card className="flex items-center gap-4" title={hint}>
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-surface-muted)]">
        <Icon className="h-6 w-6" style={{ color }} />
      </div>
      <div>
        <p className="text-xs text-[var(--color-ink-soft)]">{label}</p>
        {loading ? (
          <Skeleton className="mt-1 h-7 w-12" />
        ) : (
          <p className="text-2xl font-bold" style={{ color }}>
            {value}{suffix && <span className="ml-1 text-sm font-normal text-[var(--color-ink-soft)]">{suffix}</span>}
          </p>
        )}
      </div>
    </Card>
  );
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay} 天前`;
  return d.toLocaleDateString("zh-CN");
}

/**
 * 「开始复习」的文案口径 —— 必须是**会被你看见的那个数**。
 *
 * 复习队列 = 优先级分桶 + 新卡配额之后的批次，与「今天到期数」**不是同一个量**
 * （`复习日历-执行计划` §四 验收项 2 已更正）。此前卡片写「{dueToday} 张卡片待复习」，
 * 而你点进去看到的是队列总数 ⇒ 文案与事实不符（2026-10-07 实测 14 说成 22）。
 *
 * 分桶只在**拿全了**这一页条目时才算（`items.length === total`），否则只报总数 ——
 * 宁可少说，不编拆分。
 */
export function queueHeadline(stats: { total: number } | null, items: QueueItem[] | null): string {
  const total = stats?.total ?? 0;
  if (total === 0) return "暂无待复习卡片";
  const complete = items !== null && items.length === total;
  if (!complete) return `共 ${total} 张待复习`;
  const newCards = items.filter((i) => i.queueLabel === "新卡片").length;
  const due = Math.max(0, total - newCards);
  if (newCards === 0) return `${due} 张到期卡片待复习`;
  if (due === 0) return `${newCards} 张新卡片待复习`;
  return `${due} 张到期 + ${newCards} 张新卡待复习`;
}

export function DashboardPage() {
  const [queue, setQueue] = useState<QueueData | null>(null);
  const [dashboard, setDashboard] = useState<DashboardStats | null>(null);
  const [notes, setNotes] = useState<NotesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 竞态防护：重试会中止上一轮请求；组件卸载时中止，避免在已卸载组件上 setState。
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    setLoading(true);
    setError(null);
    // 三个数据源：队列（行动面）/ 汇总统计（含 totalWords，故不再单独请求 /words）/ 最近笔记。
    return Promise.all([
      apiFetch<QueueData>("/review/queue?limit=100", { signal }).catch(() => null),
      apiFetch<DashboardStats>("/review/stats/dashboard", { signal }).catch(() => null),
      apiFetch<NotesData>("/notes?limit=3", { signal }).catch(() => null),
    ]).then(([q, dash, noteList]) => {
      if (signal.aborted) return;
      if (q) setQueue(q);
      setDashboard(dash);
      if (noteList) setNotes(noteList);
      // 三个数据源全部失败 → 明确错误态并提供重试；部分失败则保留已有数据继续展示
      if (!q && !dash && !noteList) {
        setError("加载统计失败，请检查网络后重试");
      }
    }).finally(() => {
      if (!signal.aborted) setLoading(false);
    });
  }, []);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const totalWords = dashboard?.totalWords ?? 0;
  const trackedWords = dashboard?.trackedWords ?? 0;
  const mastered = dashboard?.masteredWords ?? 0;
  const dueToday = dashboard?.dueToday ?? 0;
  const reviewedToday = dashboard?.reviewedToday ?? 0;
  const masteredPct = trackedWords > 0 ? Math.round((mastered / trackedWords) * 100) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">仪表盘</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">学习进度和统计</p>
      </div>

      {/* 加载失败：明确错误态 + 重试 */}
      {error && (
        <Card>
          <EmptyState
            title="无法加载统计"
            description={error}
            action={
              <Button onClick={() => void load()}>
                <RotateCcw className="h-4 w-4" />重试
              </Button>
            }
          />
        </Card>
      )}

      {/* ① 行动区：今天该做什么（首屏只留两个决定行动的数 + 队列入口） */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard
          icon={Repeat}
          label="今日待复习（到期）"
          value={dueToday}
          color="var(--color-accent)"
          loading={loading}
          hint="今天（上海日历日）内到期且未挂起的卡片：含更早的积压与今天稍后到点的。与「复习活动」的「今天待做」同口径；「现在能复习的」以复习队列为准。"
        />
        <StatCard
          icon={CheckCircle2}
          label="今日已复习"
          value={reviewedToday}
          color="var(--color-accent)"
          loading={loading}
          hint="今天（上海日历日）的评分次数，L1+L2 全轨；skip/挂起等非评分动作不计。与「复习活动」的「今天已复习」同口径。"
        />
      </div>

      <Card className="cursor-pointer transition-colors hover:border-[var(--color-border-strong)]">
        <Link to="/review" className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-surface-muted)]">
            <Repeat className="h-7 w-7 text-[var(--color-accent)]" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-[var(--color-ink)]">开始复习</h3>
            <p className="text-sm text-[var(--color-ink-soft)]">
              {queueHeadline(queue?.stats ?? null, queue?.items ?? null)}
            </p>
          </div>
          <Button size="sm">前往</Button>
        </Link>
      </Card>

      {/* 复习活动：过去条带 / 12 周格网 / 未来条带 / 最近会话（批次 2 三合一） */}
      <ReviewCalendar />

      {/* ② 洞察区：节奏与分布（L2 数字由 ReviewStatsPanel 内部的条件块承载） */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <ReviewStatsPanel l2={dashboard?.l2 ?? null} />
        <LeechPanel />
      </div>

      {/* ③ 进度区：长期指标（原「更多统计」整组下沉为一行 badges，数字只出现一次） */}
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="section-title flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
            <TrendingUp className="h-5 w-5 text-[var(--color-accent)]" />
            学习进度
          </h2>
          {dashboard && (
            <Badge tone="warm">
              <Flame className="mr-1 h-3 w-3" />连续打卡 {dashboard.streakDays} 天
            </Badge>
          )}
        </div>
        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : totalWords > 0 ? (
          <div className="space-y-4">
            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-[var(--color-ink-soft)]">掌握进度（已掌握 / 在学）</span>
                <span className="font-medium text-[var(--color-ink)]">
                  {mastered}/{trackedWords}（{masteredPct}%）
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                <div
                  className="h-full rounded-full bg-[var(--color-accent)] transition-all duration-500"
                  style={{ width: `${masteredPct}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                「已掌握」= 晋升到复习态（`state = 'review'`）的词数；分母是**已开始学**的词，
                不是全库词数。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="accent">已掌握 {mastered}</Badge>
              <Badge>在学 {trackedWords}</Badge>
              <Badge>词条总数 {totalWords}</Badge>
              <Badge tone="accent">近 7 天复习 {dashboard?.reviewed7d ?? 0}</Badge>
              <Badge>近 30 天复习 {dashboard?.reviewed30d ?? 0}</Badge>
            </div>
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center text-[var(--color-ink-soft)]">
            <p className="text-sm">暂无数据</p>
          </div>
        )}
      </Card>

      {/* ④ 档案区：最近笔记（接真数据；此前是硬编码「暂无笔记」） */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="section-title flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
            <Notebook className="h-5 w-5 text-[var(--color-accent)]" />
            最近笔记
          </h2>
          <Link to="/notes">
            <Button size="sm" variant="ghost">查看全部</Button>
          </Link>
        </div>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : notes && notes.items.length > 0 ? (
          <ul className="space-y-3">
            {notes.items.map((note) => (
              <li key={note.id} className="border-b border-[var(--color-border)] pb-3 last:border-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium text-[var(--color-ink)]">{note.wordLemma}</span>
                  <span className="shrink-0 text-xs text-[var(--color-ink-soft)]">
                    {relativeTime(note.updatedAt ?? note.createdAt)}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-[var(--color-ink-soft)]">{note.contentMd}</p>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex h-32 items-center justify-center text-[var(--color-ink-soft)]">
            <p className="text-sm">暂无笔记</p>
          </div>
        )}
      </Card>

      {/* 一键遗忘（ADR-0020 / T12）：低显著性入口，置于页面最底部 */}
      <OneClickForgettingCard />
    </div>
  );
}
