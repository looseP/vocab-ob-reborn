import { Link } from "react-router-dom";
import { Card } from "@/frontend/components/ui/Card";
import { navEntriesFor } from "@/frontend/viewModels/navigationRegistry";
import { NAV_FAMILY_LABELS, type NavFamily } from "@/frontend/viewModels/navigationRegistry";
import { NAV_ICON, type NavIconName } from "@/frontend/components/layout/navIcons";

/**
 * 首页入口卡（2026-09-26）—— 卡片来自导航登记表，不再在本文件手写 href/标签。
 *
 * 顺序即优先级：**做题族排在最前**。此前复习在深度 1、而做题在深度 2–3，体感上
 * "复习是主功能、做题是附录"；现在做题的四个正门（做题 / 错题库 / 作文 / 素材宇宙）
 * 与复习同样是一次点击，且排在上面 —— 入口顺序会塑造用户对"这个产品是干什么的"的
 * 判断，这属于信息设计而非装饰。
 *
 * 卡片只放**正门**（每个族 1–3 个），细面（练习 / 会话 / 学习笔记 / 来源书架…）
 * 走命令面板（⌘K，0 击）与 L3 首页 chips —— 首页不是目录页。
 */
const cards = navEntriesFor("home");

const FAMILY_ORDER: NavFamily[] = ["practice", "review", "vocab", "material", "system"];

export function HomePage() {
  const grouped = FAMILY_ORDER
    .map((family) => ({ family, entries: cards.filter((entry) => entry.family === family) }))
    .filter((group) => group.entries.length > 0);

  return (
    <div className="flex flex-col items-center py-16">
      <div className="mb-8 text-center">
        <h1 className="section-title mb-3 text-4xl font-bold text-[var(--color-ink)]">
          Vocab Observatory
        </h1>
        <p className="text-lg text-[var(--color-ink-soft)]">
          Obsidian 主库 / Web 复习前台
        </p>
        <p className="mt-3 text-sm text-[var(--color-ink-soft)]">
          按 <kbd className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-xs">⌘K</kbd>
          {" "}／{" "}
          <kbd className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-xs">Ctrl K</kbd>
          {" "}打开命令面板，可直达任意页面与动作。
        </p>
      </div>
      <div className="w-full max-w-4xl space-y-8">
        {grouped.map((group) => (
          <section key={group.family} aria-label={NAV_FAMILY_LABELS[group.family]}>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-soft)]">
              {NAV_FAMILY_LABELS[group.family]}
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.entries.map((f) => {
                const Icon = NAV_ICON[f.icon as NavIconName] ?? NAV_ICON.repeat;
                return (
                  <Link key={f.id} to={f.href}>
                    <Card className="h-full transition-transform hover:scale-[1.02]">
                      <Icon className="mb-3 h-6 w-6 text-[var(--color-accent)]" />
                      <h3 className="mb-1 text-lg font-semibold text-[var(--color-ink)]">
                        {f.label}
                      </h3>
                      <p className="text-sm text-[var(--color-ink-soft)]">{f.description}</p>
                    </Card>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
