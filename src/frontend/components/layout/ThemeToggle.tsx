import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/frontend/hooks/useTheme";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
      className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-glass)] text-[var(--color-ink-soft)] transition-colors duration-150 hover:bg-[var(--color-surface-glass-hover)] hover:text-[var(--color-ink)]"
    >
      {theme === "dark" ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </button>
  );
}
