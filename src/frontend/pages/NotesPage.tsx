import { Card } from "@/frontend/components/ui/Card";
import { Notebook } from "lucide-react";

export function NotesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">笔记</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">词汇笔记和标注</p>
      </div>
      <Card className="flex flex-col items-center justify-center py-12">
        <Notebook className="mb-3 h-8 w-8 text-[var(--color-ink-soft)]" />
        <p className="text-[var(--color-ink-soft)]">暂无笔记</p>
      </Card>
    </div>
  );
}
