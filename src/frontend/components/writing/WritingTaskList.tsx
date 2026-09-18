/**
 * 我的写作列表（W7，S§2 首屏）：分页 20/页（加载更多）、标题/题面搜索、按最近更新排序；
 * 行信息只含标题/形式/方向/稿态/时间（不含正文）。「继续写作」直达最近草稿。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WritingTaskSummary } from "@/domain";
import { writingClient, type WritingTaskListQuery } from "@/frontend/api/writingClient";
import { Button } from "@/frontend/components/ui/Button";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { Skeleton } from "@/frontend/components/ui/Skeleton";
import { writingKindLabel } from "@/frontend/viewModels/writingNavigation";

export interface WritingTaskListProps {
  /** 打开任务（sheetId 为该任务草稿稿纸；无草稿时 undefined）。 */
  onOpenTask: (taskId: string, sheetId?: string) => void;
  /** 列表加载完成回调（续写入口用）。 */
  onLoaded?: (items: WritingTaskSummary[]) => void;
}

export function WritingTaskList({ onOpenTask, onLoaded }: WritingTaskListProps) {
  const [items, setItems] = useState<WritingTaskSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const requestSeq = useRef(0);

  const load = useCallback(async (query: WritingTaskListQuery, append: boolean) => {
    const seq = ++requestSeq.current;
    setState("loading");
    try {
      const page = await writingClient.listTasks(query);
      if (seq !== requestSeq.current) return; // 旧响应不覆盖新查询
      setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setTotal(page.total);
      setState("ready");
      onLoaded?.(append ? [] : page.items);
    } catch {
      if (seq !== requestSeq.current) return;
      setState("error");
    }
  }, [onLoaded]);

  useEffect(() => {
    void load({ limit: 20, status }, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const search = () => {
    void load({ limit: 20, status, ...(q.trim() ? { q: q.trim() } : {}) }, false);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          aria-label="搜索写作"
          className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
          placeholder="搜索标题或题面…"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") search(); }}
        />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={search}>搜索</Button>
          <Button
            size="sm"
            variant={status === "archived" ? "primary" : "ghost"}
            onClick={() => setStatus((prev) => (prev === "active" ? "archived" : "active"))}
          >
            {status === "active" ? "显示已归档" : "显示进行中"}
          </Button>
        </div>
      </div>

      {state === "loading" && items.length === 0 && (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}

      {state === "error" && (
        <div className="rounded-lg border border-[var(--color-accent-2)] p-3 text-sm text-[var(--color-accent-2)]" role="alert">
          列表读取失败。
          <Button size="sm" variant="ghost" className="ml-2" onClick={() => void load({ limit: 20, status }, false)}>重试</Button>
        </div>
      )}

      {state === "ready" && items.length === 0 && (
        <EmptyState
          title="从一段你想表达的话开始"
          description="还没有写作任务；点击「开始写作」创建第一篇。"
        />
      )}

      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.task.id}
            className="flex flex-col gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-[var(--color-ink)]">{item.task.title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-ink-soft)]">
                <span>{writingKindLabel(item.task.kind)}</span>
                <span>· {item.task.direction}</span>
                <span>· {item.draftSheetId ? "有草稿可继续" : item.latestRevisionNo != null ? `已提交 ${item.latestRevisionNo} 稿` : "尚无稿件"}</span>
                <span>· {item.task.updatedAt.slice(0, 10)}</span>
                {item.task.status === "archived" && <span className="text-[var(--color-accent-2)]">已归档</span>}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {item.draftSheetId && (
                <Button size="sm" onClick={() => onOpenTask(item.task.id, item.draftSheetId!)}>继续写作</Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => onOpenTask(item.task.id, item.draftSheetId ?? undefined)}>
                {item.draftSheetId ? "查看" : "打开"}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {state === "ready" && nextCursor && (
        <div className="flex justify-center">
          <Button size="sm" variant="secondary" onClick={() => void load({ limit: 20, status, cursor: nextCursor }, true)}>
            加载更多（{items.length}/{total}）
          </Button>
        </div>
      )}
    </div>
  );
}
