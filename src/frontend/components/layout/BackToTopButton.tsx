import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";

export function BackToTopButton() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleScroll = () => setVisible(window.scrollY > 400);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="返回顶部"
      className="fixed bottom-20 right-6 z-30 flex h-10 w-10 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-panel-strong)] text-[var(--color-ink-soft)] shadow-[var(--shadow-panel)] backdrop-blur-xl transition-all duration-200 hover:border-[var(--color-border-strong)] hover:text-[var(--color-ink)] md:bottom-6"
    >
      <ArrowUp className="h-4 w-4" />
    </button>
  );
}
