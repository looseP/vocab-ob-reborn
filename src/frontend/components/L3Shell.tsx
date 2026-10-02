import { useCallback, useEffect, useState, type ReactNode } from "react";
import { L3_SHELL_SECTIONS, L3_SHELL_CORE_SECTIONS, type L3ShellSection } from "../viewModels/l3ShellViewModel";

export type { L3ShellSection };

interface L3ShellProps {
  activeSection: L3ShellSection;
  onNavigate(section: L3ShellSection): void;
  children: ReactNode;
}

/** 收折偏好落 localStorage：做题是 15~60 分钟的连续会话，刷新不该把目录弹回来。 */
const COLLAPSED_STORAGE_KEY = "vocab-l3-sidebar-collapsed";

function readCollapsed(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    // 隐私模式 / 配额异常：读不到就当展开（默认更安全：导航不会「莫名消失」）。
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // 写不进去不是错误：偏好只是体验加速，不该因此让导航交互报错。
  }
}

/**
 * L3 外壳（侧栏 + 主区）。
 *
 * ## 为什么要能收折（2026-10-02）
 *
 * 侧栏在桌面端固定占 200px。做题是 15~60 分钟的**连续**会话，期间「空间首页 /
 * 来源书架 / 作文」这些低频入口一直占着宽度 —— 卷面是左文右题双栏，200px 直接
 * 从两栏里各抠掉一部分。收起后只剩 48px 图标条，正文与题卡同时变宽。
 *
 * ## 收起 ≠ 丢掉导航
 *
 * 收起态不是把导航藏起来，而是换成 **mini rail**：每个核心面一个首字方块，
 * 带 `title` / `aria-label`，点了照样切面。如果收起后导航不可达，用户就得先
 * 展开再收起，等于白做。
 *
 * 快捷键 Ctrl/⌘+B（与「收起目录」按钮同一动作）。输入控件内不抢键——
 * 浏览器在 `input` / `contenteditable` 里对 Ctrl+B 有自己的语义（加粗）。
 */
export function L3Shell({ activeSection, onNavigate, children }: L3ShellProps) {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const core = L3_SHELL_SECTIONS.filter((s) => (L3_SHELL_CORE_SECTIONS as readonly L3ShellSection[]).includes(s.id));
  const tools = L3_SHELL_SECTIONS.filter((s) => !(L3_SHELL_CORE_SECTIONS as readonly L3ShellSection[]).includes(s.id));

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      writeCollapsed(!prev);
      return !prev;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "b" && event.key !== "B") return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof Element
        && target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      toggle();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toggle]);

  return (
    <div className={`l3-shell${collapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="l3-sidebar" aria-label="L3 sections">
        <div className="l3-sidebar-head">
          <div className="l3-sidebar-wide">
            <p className="eyebrow">Vocab Observatory</p>
            <h1>L3 Context Space</h1>
          </div>
          <button
            type="button"
            data-testid="l3-sidebar-toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开目录" : "收起目录"}
            title={`${collapsed ? "展开目录" : "收起目录"}（Ctrl+B）`}
            onClick={toggle}
            className="l3-sidebar-toggle"
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>

        {collapsed ? (
          <nav className="l3-nav l3-sidebar-rail" aria-label="核心入口（图标）">
            {core.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`l3-rail-btn${section.id === activeSection ? " active" : ""}`}
                aria-label={section.label}
                title={section.label}
                onClick={() => onNavigate(section.id)}
              >
                {section.label.slice(0, 1)}
              </button>
            ))}
          </nav>
        ) : (
          <>
            <nav className="l3-nav" aria-label="核心入口">
              {core.map((section) => (
                <button
                  className={section.id === activeSection ? "active" : ""}
                  key={section.id}
                  onClick={() => onNavigate(section.id)}
                  type="button"
                >
                  {section.label}
                </button>
              ))}
            </nav>
            <details className="l3-nav-tools">
              <summary>工程工具</summary>
              <nav className="l3-nav l3-nav-tools-list" aria-label="工程工具">
                {tools.map((section) => (
                  <button
                    className={section.id === activeSection ? "active" : ""}
                    key={section.id}
                    onClick={() => onNavigate(section.id)}
                    type="button"
                  >
                    {section.label}
                  </button>
                ))}
              </nav>
            </details>
          </>
        )}
      </aside>
      <main className="l3-main">{children}</main>
    </div>
  );
}
