import { Link, useLocation } from "react-router-dom";
import { BookOpen, LayoutGrid, Repeat, Notebook } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";

const navItems = [
  { href: "/words", label: "词条库", icon: BookOpen },
  { href: "/review", label: "复习", icon: Repeat },
  { href: "/dashboard", label: "仪表盘", icon: LayoutGrid },
  { href: "/notes", label: "笔记", icon: Notebook },
] as const;

export function SiteHeader() {
  const location = useLocation();

  return (
    <header
      className="sticky top-0 z-40 border-b border-[var(--color-header-border-b)] bg-[var(--color-header-bg)] backdrop-blur-xl transition-colors duration-300"
      style={{ "--header-height": "5rem" } as React.CSSProperties}
    >
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-4">
          <Link to="/" className="group flex items-center gap-3">
            <div className="soft-grid flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-glass)] transition-colors group-hover:border-[var(--color-border-strong)]">
              <span className="section-title text-lg font-semibold text-[var(--color-accent)]">
                词
              </span>
            </div>
            <div className="hidden sm:block">
              <p className="section-title text-xl font-semibold">Vocab Observatory</p>
              <p className="text-xs text-[var(--color-ink-soft)]">
                Obsidian 主库 / Web 复习前台
              </p>
            </div>
          </Link>
        </div>

        <nav className="hidden items-center gap-1 md:flex">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location.pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                to={item.href}
                className={`group flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium transition-colors duration-150 ${
                  isActive
                    ? "bg-[var(--color-surface-muted)] text-[var(--color-accent)]"
                    : "text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-glass-hover)] hover:text-[var(--color-ink)]"
                }`}
              >
                <Icon className="h-[15px] w-[15px]" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
