import type { ReactNode } from "react";
import { L3_SHELL_SECTIONS, L3_SHELL_CORE_SECTIONS, type L3ShellSection } from "../viewModels/l3ShellViewModel";

export type { L3ShellSection };

interface L3ShellProps {
  activeSection: L3ShellSection;
  onNavigate(section: L3ShellSection): void;
  children: ReactNode;
}

export function L3Shell({ activeSection, onNavigate, children }: L3ShellProps) {
  const core = L3_SHELL_SECTIONS.filter((s) => (L3_SHELL_CORE_SECTIONS as readonly L3ShellSection[]).includes(s.id));
  const tools = L3_SHELL_SECTIONS.filter((s) => !(L3_SHELL_CORE_SECTIONS as readonly L3ShellSection[]).includes(s.id));
  return (
    <div className="l3-shell">
      <aside className="l3-sidebar" aria-label="L3 sections">
        <div>
          <p className="eyebrow">Vocab Observatory</p>
          <h1>L3 Context Space</h1>
        </div>
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
      </aside>
      <main className="l3-main">{children}</main>
    </div>
  );
}
