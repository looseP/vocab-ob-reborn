import clsx from "clsx";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        "animate-pulse rounded-lg bg-[var(--color-surface-soft)]",
        className,
      )}
    />
  );
}

export function SkeletonCard() {
  return (
    <div className="space-y-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-6">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
