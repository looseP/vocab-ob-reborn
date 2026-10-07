import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Repeat, BookOpen, Notebook, TrendingUp, Flame, Target, CheckCircle2,
  CalendarRange, GraduationCap, RotateCcw, Users, Layers, Zap,
} from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { ReviewStatsPanel } from "@/frontend/components/review/ReviewStatsPanel";
import { LeechPanel } from "@/frontend/components/review/LeechPanel";
import { WordReviewTimeline } from "@/frontend/components/review/WordReviewTimeline";
import { MasteryHeatmap } from "@/frontend/components/review/MasteryHeatmap";
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

function StatCard({ icon: Icon, label, value, color, loading, suffix }: {
  icon: typeof Repeat;
  label: string;
  value: number | string;
  color: string;
  loading?: boolean;
  suffix?: string;
}) {
  return (
    <Card className="flex items-center gap-4">
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
  const l2 = dashboard?.l2;
  const l2Active = !!l2 && (l2.promoted + l2.dueNow + l2.weakSignal + l2.reviewedToday) > 0;
  const masteredPct = trackedWords > 0 ? Math.round((mastered / trackedWords) * 100) : 0;
  const forecast = dashboard?.forecast;

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

      {/* 1 · 今天该做什么（首屏只留四个决定行动的数） */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Repeat} label="今日待复习（到期）" value={dueToday} color="var(--color-accent)" loading={loading} />
        <StatCard icon={CheckCircle2} label="今日已复习" value={reviewedToday} color="var(--color-accent)" loading={loading} />
        <StatCard icon={Flame} label="连续打卡" value={dashboard?.streakDays ?? 0} color="var(--color-accent-2)" loading={loading} suffix="天" />
        <StatCard icon={Target} label="在学词数" value={trackedWords} color="var(--color-accent-2)" loading={loading} />
      </div>

      {/* 快速入口 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

        <Card className="cursor-pointer transition-colors hover:border-[var(--color-border-strong)]">
          <Link to="/words" className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-surface-muted-warm)]">
              <BookOpen className="h-7 w-7 text-[var(--color-accent-2)]" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-[var(--color-ink)]">浏览词条</h3>
              <p className="text-sm text-[var(--color-ink-soft)]">查看和管理词汇库</p>
            </div>
            <Button size="sm" variant="secondary">前往</Button>
          </Link>
        </Card>

        <Card className="cursor-pointer transition-colors hover:border-[var(--color-border-strong)]">
          <Link to="/plaza" className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-surface-muted)]">
              <Users className="h-7 w-7 text-[var(--color-accent)]" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-[var(--color-ink)]">浏览广场</h3>
              <p className="text-sm text-[var(--color-ink-soft)]">按语义场主题浏览整组词汇</p>
            </div>
            <Button size="sm" variant="secondary">前往</Button>
          </Link>
        </Card>
      </div>

      {/* 2 · 近期到期（三档真预测；M1 起不再是 dueToday × 1.5 / × 2 的推算） */}
      <Card>
        <h2 className="section-title mb-4 flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
          <CalendarRange className="h-5 w-5 text-[var(--color-accent)]" />
          近期到期
        </h2>
        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "今天", value: forecast?.dueNow ?? 0 },
                { label: "7 天内", value: forecast?.due7d ?? 0 },
                { label: "14 天内", value: forecast?.due14d ?? 0 },
              ].map((bucket) => (
                <div key={bucket.label} className="rounded-xl bg-[var(--color-surface-muted)] px-3 py-3 text-center">
                  <p className="text-xs text-[var(--color-ink-soft)]">{bucket.label}</p>
                  <p className="text-2xl font-bold text-[var(--color-ink)]">{bucket.value}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
              口径：按 `due_at` 的日历日累计（Asia/Shanghai），不含已挂起词；「今天」即到期总数。
            </p>
          </>
        )}
      </Card>

      {/* 3 · 学习进度（分母用「在学词数」；此前是 总数−今天到期 的假进度） */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
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
          <Skeleton className="h-48 w-full" />
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
              <Badge tone="accent">到期 {dueToday}</Badge>
              <Badge tone="warm">今日已复习 {reviewedToday}</Badge>
              <Badge>在学 {trackedWords}</Badge>
              <Badge>总计 {totalWords}</Badge>
            </div>
          </div>
        ) : (
          <div className="flex h-48 items-center justify-center text-[var(--color-ink-soft)]">
            <p className="text-sm">暂无数据</p>
          </div>
        )}
      </Card>

      {/* 4 · 更多统计（低频指标下沉；L2 轨未启用时整组不渲染） */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={GraduationCap} label="已掌握" value={mastered} color="var(--color-accent)" loading={loading} />
        <StatCard icon={Layers} label="词条总数" value={totalWords} color="var(--color-accent-2)" loading={loading} />
        <StatCard icon={CalendarRange} label="近 7 天复习" value={dashboard?.reviewed7d ?? 0} color="var(--color-accent)" loading={loading} />
        <StatCard icon={TrendingUp} label="近 30 天复习" value={dashboard?.reviewed30d ?? 0} color="var(--color-accent)" loading={loading} />
        {l2Active && (
          <>
            <StatCard icon={Layers} label="L2 已晋升" value={l2?.promoted ?? 0} color="var(--color-accent)" loading={loading} />
            <StatCard icon={Zap} label="L2 待辨析" value={l2?.dueNow ?? 0} color="var(--color-accent-2)" loading={loading} />
            <StatCard icon={Zap} label="今日 L2 复习" value={l2?.reviewedToday ?? 0} color="var(--color-accent-2)" loading={loading} />
          </>
        )}
      </div>

      {/* 复习统计 + 漏词管理 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ReviewStatsPanel />
        <LeechPanel />
      </div>

      {/* 热力图 + 时间线 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MasteryHeatmap />
        <WordReviewTimeline />
      </div>

      {/* 最近笔记 —— 接真数据（此前是硬编码「暂无笔记」，即使库里已有笔记也不显示） */}
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
