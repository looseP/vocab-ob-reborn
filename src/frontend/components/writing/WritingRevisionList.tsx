/**
 * 稿次列表（W7，S§2/§6）：sealed/discarded 历史 + 反馈状态派生 + 对照入口 + 清理入口。
 * 只显示当前任务；反馈状态按稿独立（不跨稿混合）；草稿不进入对照。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WritingRevisionSummary, WritingTaskDto } from "@/domain";
import { writingClient } from "@/frontend/api/writingClient";
import { Button } from "@/frontend/components/ui/Button";
import { revisionLabel } from "@/frontend/viewModels/writingNavigation";

const FEEDBACK_STATE_LABELS: Record<WritingRevisionSummary["feedbackState"], string> = {
  pending: "待评",
  ready: "已有反馈",
  unavailable: "正文已清理",
};

export interface WritingRevisionListProps {
  task: WritingTaskDto;
  /** 当前查看的稿（用于对照入口与高亮）。 */
  currentSheetId: string | null;
  currentSheetSealed: boolean;
  onOpenSheet: (sheetId: string) => void;
  onCompareWith: (sheetId: string) => void;
  /** 清理成功后回调（上层刷新详情）。 */
  onCleared: () => Promise<void> | void;
}

export function WritingRevisionList(props: WritingRevisionListProps) {
  const { task, currentSheetId, currentSheetSealed, onOpenSheet, onCompareWith, onCleared } = props;
  const [items, setItems] = useState<WritingRevisionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [actionError, setActionError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    const ticket = ++seq.current;
    setState("loading");
    try {
      const page = await writingClient.listRevisions(task.id, cursor ? { limit: 20, cursor } : { limit: 20 });
      if (ticket !== seq.current) return;
      setItems((prev) => (append ? [...prev, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setState("ready");
    } catch {
      if (ticket !== seq.current) return;
      setState("error");
    }
  }, [task.id]);

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const clearContent = async (sheetId: string) => {
    const confirmed = window.confirm("清理后将删除该稿正文与其评语（不可恢复）。确定清理？");
    if (!confirmed) return;
    setActionError(null);
    try {
      await writingClient.clearSheetContent(task.id, sheetId);
      await load(null, false);
      await onCleared();
    } catch {
      setActionError("清理失败，请重试。");
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">稿次</h3>
        <Button size="sm" variant="ghost" onClick={() => void load(null, false)}>刷新</Button>
      </div>

      {state === "loading" && items.length === 0 && <p className="text-xs text-[var(--color-ink-soft)]">加载中…</p>}
      {state === "error" && (
        <p className="text-xs text-[var(--color-accent-2)]" role="alert">
          稿次读取失败。<Button size="sm" variant="ghost" onClick={() => void load(null, false)}>重试</Button>
        </p>
      )}
      {actionError && <p className="text-xs text-[var(--color-accent-2)]" role="alert">{actionError}</p>}
      {state === "ready" && items.length === 0 && (
        <p className="text-xs text-[var(--color-ink-soft)]">还没有提交稿；本稿提交后会出现在这里。</p>
      )}

      <ul className="space-y-1.5">
        {items.map((item) => {
          const active = item.sheet.id === currentSheetId;
          return (
            <li
              key={item.sheet.id}
              className={`rounded-lg border p-2 text-xs ${active ? "border-[var(--color-accent)] bg-[var(--color-surface-glass)]" : "border-[var(--color-border)] bg-[var(--color-surface)]"}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-1">
                <div className="flex items-center gap-2 text-[var(--color-ink)]">
                  <span className="font-medium">{revisionLabel(item.sheet)}</span>
                  <span className="text-[var(--color-ink-soft)]">{item.sheet.sealedAt?.slice(0, 10) ?? item.sheet.updatedAt.slice(0, 10)}</span>
                  <span className={item.contentStatus === "cleared" ? "text-[var(--color-accent-2)]" : "text-[var(--color-ink-soft)]"}>
                    {FEEDBACK_STATE_LABELS[item.feedbackState]}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => onOpenSheet(item.sheet.id)}>查看</Button>
                  {item.contentStatus === "available" && currentSheetSealed && item.sheet.id !== currentSheetId && (
                    <Button size="sm" variant="ghost" onClick={() => onCompareWith(item.sheet.id)}>与当前稿对照</Button>
                  )}
                  {item.contentStatus === "available" && (
                    <Button size="sm" variant="ghost" onClick={() => void clearContent(item.sheet.id)}>清理正文</Button>
                  )}
                </div>
              </div>
              {item.contentStatus === "cleared" && (
                <p className="mt-1 text-[11px] text-[var(--color-ink-soft)]">本稿正文已清理（不展示残留评语）。</p>
              )}
            </li>
          );
        })}
      </ul>

      {state === "ready" && nextCursor && (
        <Button size="sm" variant="secondary" onClick={() => void load(nextCursor, true)}>加载更多稿次</Button>
      )}
    </div>
  );
}
