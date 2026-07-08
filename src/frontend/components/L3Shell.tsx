import type { ReactNode } from "react";

export type L3ShellSection = "home" | "import" | "proposals" | "recommendations" | "graph";

const sections: Array<{ id: L3ShellSection; label: string }> = [
  { id: "home", label: "L3 Home" },
  { id: "import", label: "Import" },
  { id: "proposals", label: "Proposals" },
  { id: "recommendations", label: "Recommendations" },
  { id: "graph", label: "Graph" },
];

interface L3ShellProps {
  activeSection: L3ShellSection;
  onNavigate(section: L3ShellSection): void;
  children: ReactNode;
}

export function L3Shell({ activeSection, onNavigate, children }: L3ShellProps) {
  return (
    <div className="l3-shell">
      <aside className="l3-sidebar" aria-label="L3 sections">
        <div>
          <p className="eyebrow">Vocab Observatory</p>
          <h1>L3 Context Space</h1>
        </div>
        <nav className="l3-nav">
          {sections.map((section) => (
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
      </aside>
      <main className="l3-main">{children}</main>
    </div>
  );
}
