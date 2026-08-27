import { Link, useLocation } from "react-router-dom";
import { Repeat, BookOpen, LayoutGrid, Notebook, Settings } from "lucide-react";

const tabs = [
  { href: "/review", label: "复习", icon: Repeat },
  { href: "/words", label: "词条库", icon: BookOpen },
  { href: "/dashboard", label: "仪表盘", icon: LayoutGrid },
  { href: "/notes", label: "笔记", icon: Notebook },
  { href: "/settings", label: "设置", icon: Settings },
] as const;

/** 移动端底部固定导航栏（桌面端隐藏）。补齐 md 断点以下顶栏导航被隐藏后的导航断层。 */
export function MobileTabBar() {
  const { pathname } = useLocation();
  return (
    <nav
      aria-label="移动端主导航"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-header-border-b)] bg-[var(--color-header-bg)]/95 backdrop-blur-xl md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex items-stretch">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <Link
              key={t.href}
              to={t.href}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors ${
                active ? "text-[var(--color-accent)]" : "text-[var(--color-ink-soft)]"
              }`}
            >
              <Icon className="h-5 w-5" />
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
