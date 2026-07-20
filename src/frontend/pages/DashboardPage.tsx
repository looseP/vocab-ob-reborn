import { Link } from "react-router-dom";
import { Repeat, BookOpen, Notebook, TrendingUp, Flame, Target, Brain } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";

function StatCard({ icon: Icon, label, value, color }: { icon: typeof Repeat; label: string; value: string; color: string }) {
  return (
    <Card className="flex items-center gap-4">
      <div
        className="flex h-12 w-12 items-center justify-center rounded-xl"
        style={{ backgroundColor: `var(--color-surface-muted)` }}
      >
        <Icon className="h-6 w-6" style={{ color }} />
      </div>
      <div>
        <p className="text-xs text-[var(--color-ink-soft)]">{label}</p>
        <p className="text-2xl font-bold" style={{ color }}>{value}</p>
      </div>
    </Card>
  );
}

export function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">仪表盘</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">学习进度和统计</p>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Repeat} label="今日待复习" value="—" color="var(--color-accent)" />
        <StatCard icon={Target} label="已掌握" value="—" color="var(--color-accent)" />
        <StatCard icon={Brain} label="学习中" value="—" color="var(--color-accent-2)" />
        <StatCard icon={Flame} label="连续天数" value="—" color="var(--color-accent-2)" />
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
              <p className="text-sm text-[var(--color-ink-soft)]">间隔重复训练，巩固记忆</p>
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

      {/* 学习进度（占位） */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="section-title flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
            <TrendingUp className="h-5 w-5 text-[var(--color-accent)]" />
            学习进度
          </h2>
        </div>
        <div className="flex h-48 items-center justify-center text-[var(--color-ink-soft)]">
          <p className="text-sm">统计数据即将上线</p>
        </div>
      </Card>

      {/* 最近笔记（占位） */}
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
