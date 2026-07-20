import { Link } from "react-router-dom";
import { BookOpen, Repeat, LayoutGrid, Notebook, Sparkles } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";

const features = [
  { href: "/review", icon: Repeat, title: "复习", desc: "间隔重复训练，巩固记忆" },
  { href: "/words", icon: BookOpen, title: "词条库", desc: "浏览和管理词汇" },
  { href: "/dashboard", icon: LayoutGrid, title: "仪表盘", desc: "学习进度和统计" },
  { href: "/notes", icon: Notebook, title: "笔记", desc: "词汇笔记和标注" },
  { href: "/l3", icon: Sparkles, title: "L3 进阶研究", desc: "知识图谱、提案、推荐" },
] as const;

export function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <div className="mb-8 text-center">
        <h1 className="section-title mb-3 text-4xl font-bold text-[var(--color-ink)]">
          Vocab Observatory
        </h1>
        <p className="text-lg text-[var(--color-ink-soft)]">
          Obsidian 主库 / Web 复习前台
        </p>
      </div>
      <div className="grid w-full max-w-4xl grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((f) => {
          const Icon = f.icon;
          return (
            <Link key={f.href} to={f.href}>
              <Card className="h-full transition-transform hover:scale-[1.02]">
                <Icon className="mb-3 h-6 w-6 text-[var(--color-accent)]" />
                <h3 className="mb-1 text-lg font-semibold text-[var(--color-ink)]">
                  {f.title}
                </h3>
                <p className="text-sm text-[var(--color-ink-soft)]">{f.desc}</p>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
