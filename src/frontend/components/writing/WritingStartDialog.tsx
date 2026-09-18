/**
 * 直接开始写作弹层（W7，S§2）：形式默认自由写作；题目说明可空（空时服务端生成
 * 「自由写作」）；标题可空；方向默认通用。无来源/卷面/题型必填。
 * requestId 为一次创建意图：结果未知（网络失败）时沿用、成功/取消后更换（幂等保护）。
 */
import { useEffect, useRef, useState } from "react";
import type { CreateWritingTaskResult } from "@/domain";
import type { WritingDirection, WritingKind } from "@/domain/l3-writing";
import { writingClient } from "@/frontend/api/writingClient";
import { Button } from "@/frontend/components/ui/Button";
import { Modal } from "@/frontend/components/ui/Modal";

export interface WritingStartDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (result: CreateWritingTaskResult) => void;
}

function newRequestId(): string {
  return crypto.randomUUID();
}

export function WritingStartDialog({ open, onClose, onCreated }: WritingStartDialogProps) {
  const [kind, setKind] = useState<WritingKind>("free");
  const [direction, setDirection] = useState<WritingDirection>("通用");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string>(newRequestId());

  // 弹层每次打开 = 一次新创建意图（成功后轮换；失败沿用同一 requestId）。
  useEffect(() => {
    if (open) {
      requestIdRef.current = newRequestId();
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await writingClient.createTask({
        requestId: requestIdRef.current,
        kind,
        direction,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      requestIdRef.current = newRequestId(); // 成功后更换（下一次创建是新意图）
      onCreated(result);
    } catch (err) {
      // 结果未知/失败：保留同一 requestId 供重试（幂等）；展示错误但不清空输入。
      setError(err instanceof Error ? err.message : "创建失败，请重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="开始写作" size="md">
      <div className="space-y-3">
        <label className="block text-xs text-[var(--color-ink-soft)]">
          形式
          <select
            aria-label="写作形式"
            className="mt-1 h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-ink)]"
            value={kind}
            onChange={(event) => setKind(event.target.value as WritingKind)}
          >
            <option value="free">自由写作</option>
            <option value="whole">整篇写作</option>
            <option value="paragraph">段落专项</option>
          </select>
        </label>

        <label className="block text-xs text-[var(--color-ink-soft)]">
          方向
          <select
            aria-label="写作方向"
            className="mt-1 h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-ink)]"
            value={direction}
            onChange={(event) => setDirection(event.target.value as WritingDirection)}
          >
            <option value="通用">通用</option>
            <option value="考研">考研</option>
            <option value="雅思">雅思</option>
          </select>
        </label>

        <label className="block text-xs text-[var(--color-ink-soft)]">
          题目说明（可空）
          <textarea
            aria-label="题目说明"
            className="mt-1 h-24 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-sm text-[var(--color-ink)]"
            placeholder="想练什么就写什么；留空则按「自由写作」开始。"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>

        <label className="block text-xs text-[var(--color-ink-soft)]">
          标题（可空，自动取题面开头）
          <input
            aria-label="标题"
            className="mt-1 h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-ink)]"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        {error && <p className="text-xs text-[var(--color-accent-2)]" role="alert">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting ? "创建中…" : "开始写作"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
