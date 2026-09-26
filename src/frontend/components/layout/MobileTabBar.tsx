import { Link, useLocation } from "react-router-dom";
import { isNavEntryActive, navEntriesFor } from "@/frontend/viewModels/navigationRegistry";
import { NAV_ICON, type NavIconName } from "@/frontend/components/layout/navIcons";

/**
 * 移动端底部固定导航（桌面端隐藏）。补齐 md 断点以下顶栏被隐藏后的导航断层。
 * 条目同样来自导航登记表（2026-09-26）—— 与顶栏同源，不再各写一份。
 * 底栏只有 6 格是刻意的：移动端底栏是"最高频 6 个"，其余走命令面板与首页卡片。
 */
const tabs = navEntriesFor("mobile");

/** 移动端主导航（移动端主导航）。 */
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
          const Icon = NAV_ICON[t.icon as NavIconName] ?? NAV_ICON.repeat;
          const active = isNavEntryActive(t, pathname);
          return (
            <Link
              key={t.id}
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
