import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Repeat, BookOpen, Notebook, TrendingUp, Flame, Target, Brain, CheckCircle2 } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { ReviewStatsPanel } from "@/frontend/components/review/ReviewStatsPanel";
import { LeechPanel } from "@/frontend/components/review/LeechPanel";
import { Badge } from "@/frontend/components/ui/Badge";
import { Skeleton } from "@/frontend/components/ui/Skeleton";
import { apiFetch } from "@/frontend/api/client";

interface QueueData {
  stats: { total: number; remaining: number };
  session: { cardsSeen: number };
}
interface WordsData {
  total: number;
}

function StatCard({ icon: Icon, label, value, color, loading }: {
  icon: typeof Repeat;
  label: string;
  value: number | string;
  color: string;
  loading?: boolean;
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
          <p className="text-2xl font-bold" style={{ color }}>{value}</p>
        )}
      </div>
    </Card>
  );
}

export function DashboardPage() {
  const [dueCount, setDueCount] = useState(0);
  const [reviewedToday, setReviewedToday] = useState(0);
  const [totalWords, setTotalWords] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch<QueueData>("/review/queue?limit=100").catch(() => null),
      apiFetch<WordsData>("/words?limit=1").catch(() => null),
    ]).then(([queue, words]) => {
      if (queue) {
        setDueCount(queue.stats.total);
        setReviewedToday(queue.session.cardsSeen);
      }
      if (words) setTotalWords(words.total);
      setLoading(false);
    });
  }, []);

  const mastered = Math.max(0, totalWords - dueCount);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">仪表盘</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">学习进度和统计</p>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Repeat} label="今日待复习" value={dueCount} color="var(--color-accent)" loading={loading} />
        <StatCard icon={CheckCircle2} label="今日已复习" value={reviewedToday} color="var(--color-accent)" loading={loading} />
        <StatCard icon={BookOpen} label="词条总数" value={totalWords} color="var(--color-accent-2)" loading={loading} />
        <StatCard icon={Target} label="已掌握" value={mastered} color="var(--color-accent)" loading={loading} />
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
                {dueCount > 0 ? `${dueCount} 张卡片待复习` : "暂无待复习卡片"}
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
      </div>

      {/* 学习进度 */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="section-title flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
            <TrendingUp className="h-5 w-5 text-[var(--color-accent)]" />
            学习进度
          </h2>
        </div>
        {loading ? (
          <Skeleton className="h-48 w-full" />
        ) : totalWords > 0 ? (
          <div className="space-y-4">
            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-[var(--color-ink-soft)]">掌握进度</span>
                <span className="font-medium text-[var(--color-ink)]">
                  {mastered}/{totalWords}
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                <div
                  className="h-full rounded-full bg-[var(--color-accent)] transition-all duration-500"
                  style={{ width: `${(mastered / totalWords) * 100}%` }}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="accent">待复习 {dueCount}</Badge>
              <Badge tone="warm">已复习 {reviewedToday}</Badge>
              <Badge>总计 {totalWords}</Badge>
            </div>
          </div>
        ) : (
          <div className="flex h-48 items-center justify-center text-[var(--color-ink-soft)]">
            <p className="text-sm">暂无数据</p>
          </div>
        )}
      </Card>

      {/* 复习统计 + 漏词管理 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ReviewStatsPanel />
        <LeechPanel />
      </div>

      {/* 最近笔记 */}
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
        <div className="flex h-32 items-center justify-center text-[var(--color-ink-soft)]">
          <p className="text-sm">暂无笔记</p>
        </div>
      </Card>
    </div>
  );
}
