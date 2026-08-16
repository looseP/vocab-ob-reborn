export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={`inline-block h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-accent)] ${className ?? ""}`}
      role="status"
      aria-label="加载中"
    />
  );
}
