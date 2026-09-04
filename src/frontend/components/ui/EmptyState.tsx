import type { ReactNode } from "react";
import { Inbox } from "lucide-react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 text-[var(--color-ink-soft)]">
        {icon ?? <Inbox className="h-10 w-10" />}
      </div>
      <h3 className="text-lg font-semibold text-[var(--color-ink)]">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-[var(--color-ink-soft)]">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
