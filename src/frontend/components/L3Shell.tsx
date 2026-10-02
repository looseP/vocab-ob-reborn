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
 * ## 为什么要上下折叠（2026-10-02）
 *
 * 侧栏在桌面端固定占 200px。做题是 15~60 分钟的连续会话，期间「空间首页 / 来源书架 / 作文」
 * 等低频入口一直占据着纵向空间。用户需要的是**上下折叠**（垂直手风琴收拢），而不是左右挤压成细条：
 * 侧栏宽度保持 200px 稳定卡片，低频导航项垂直收起，仅保留当前活动项（如「试卷台」），
 * 并留出下方固定交互区域（选区上下文停靠区）。
 *
 * 快捷键 Ctrl/⌘+B（与折叠/展开按钮同一动作）。输入控件内不抢键——
 * 浏览器在 input / contenteditable 里对 Ctrl+B 有自己的语义（加粗）。
 */
export function L3Shell({ activeSection, onNavigate, children }: L3ShellProps) {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const core = L3_SHELL_SECTIONS.filter((s) => (L3_SHELL_CORE_SECTIONS as readonly L3ShellSection[]).includes(s.id));
  const tools = L3_SHELL_SECTIONS.filter((s) => !(L3_SHELL_CORE_SECTIONS as readonly L3ShellSection[]).includes(s.id));

  const activeMeta = L3_SHELL_SECTIONS.find((s) => s.id === activeSection) ?? {
    id: activeSection,
    label: "当前入口",
  };

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
            aria-label={collapsed ? "展开导航" : "折叠导航"}
            title={`${collapsed ? "展开导航" : "折叠导航"}（Ctrl+B）`}
            onClick={toggle}
            className="l3-sidebar-toggle"
          >
            {collapsed ? "▾" : "▴"}
          </button>
        </div>

        {collapsed ? (
          <>
            <nav className="l3-nav l3-nav-collapsed" aria-label="当前入口（已折叠其他项）">
              <button
                className="active"
                key={activeMeta.id}
                onClick={() => onNavigate(activeMeta.id)}
                type="button"
                title={activeMeta.label}
              >
                {activeMeta.label}
              </button>
            </nav>
            <div className="l3-nav-collapsed-hint">
              <button
                type="button"
                onClick={toggle}
                className="l3-nav-unfold-trigger"
                aria-label="展开全部目录"
                title="展开全部目录（Ctrl+B）"
              >
                <span>展开全部目录</span>
                <span aria-hidden>▾</span>
              </button>
            </div>
          </>
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
