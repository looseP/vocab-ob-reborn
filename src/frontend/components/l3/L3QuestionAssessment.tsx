/**
 * 题卡「评析」子区（批次二增补，ADR-0034 v2 条 10/11）。
 *
 * 一题一条的 owner/agent 共建沉淀：textarea 编辑 + 只读预览切换（不引 Markdown
 * 编辑器依赖，预览为纯文本 pre-wrap）；挂题不挂题纸（跨题纸、跨 venue 永存）；
 * last_editor/updated_at 留痕展示（latest-wins 无历史版本）。
 */
import { useCallback, useEffect, useState } from "react";
import {
  fetchQuestionAssessment,
  saveQuestionAssessment,
  type L3Assessment,
} from "@/frontend/api/l3Client";
import { useToast } from "@/frontend/components/ui/Toast";

function formatEditedAt(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function L3QuestionAssessment({ questionId }: { questionId: string }) {
  const { addToast } = useToast();
  const [assessment, setAssessment] = useState<L3Assessment | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchQuestionAssessment(questionId)
      .then((row) => { if (!cancelled) setAssessment(row); })
      .catch(() => { /* 评析加载失败静默降级，不打断做题 */ });
    return () => { cancelled = true; };
  }, [questionId]);

  const startEditing = useCallback(() => {
    setDraft(assessment?.content_md ?? "");
    setEditing(true);
    setExpanded(true);
  }, [assessment]);

  const save = useCallback(async () => {
    const contentMd = draft.trim();
    if (contentMd.length === 0) return;
    setBusy(true);
    try {
      const row = await saveQuestionAssessment(questionId, contentMd);
      setAssessment(row);
      setEditing(false);
      addToast("success", "评析已保存");
    } catch {
      addToast("error", "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }, [draft, questionId, addToast]);

  const hasContent = Boolean(assessment && assessment.content_md.trim().length > 0);

  return (
    <div className="mt-2 rounded-lg bg-[var(--color-surface)] text-xs ring-1 ring-[var(--color-border)]"
      onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); setExpanded((v) => !v); }}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 whitespace-nowrap px-2.5 py-1.5 text-xs font-semibold text-[var(--color-ink-soft)] hover:text-[var(--color-accent)]"
      >
        <span>评析 · {hasContent ? "已沉淀" : "待沉淀"}</span>
        <span className="flex items-center gap-2 text-[10px] font-normal">
          {assessment && (
            <span className="text-[var(--color-ink-soft)]">
              {assessment.last_editor === "agent" ? "agent 编辑" : "owner 编辑"} · {formatEditedAt(assessment.updated_at)}
            </span>
          )}
          <span>{expanded ? "收起 ▴" : "展开 ▸"}</span>
        </span>
      </button>
      {expanded && (
        <div className="border-t border-[var(--color-border)] p-2.5" onClick={(event) => event.stopPropagation()}>
          {editing ? (
            <div className="space-y-2">
              <textarea
                rows={6}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="写下对本题的评析（判据质量 / 标记命中 / 复盘要点）…"
                className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-xs leading-relaxed focus:border-[var(--color-accent)] focus:outline-none"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setEditing(false)}
                  className="rounded-md px-2 py-1 text-[11px] text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]">
                  取消
                </button>
                <button type="button" disabled={busy || draft.trim().length === 0} onClick={() => void save()}
                  className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-[11px] font-semibold text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50">
                  保存评析
                </button>
              </div>
            </div>
          ) : hasContent ? (
            <div className="space-y-2">
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-ink)]">{assessment!.content_md}</p>
              <div className="flex justify-end">
                <button type="button" onClick={startEditing}
                  className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:border-[var(--color-accent)]">
                  编辑
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
                还没有评析。评卷请让本地 agent 走「评卷上下文」通道（它带标准答案；「导出」的
                Markdown 不含答案、只供存档外发），复盘则写在这里。
              </p>
              <button type="button" onClick={startEditing}
                className="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:border-[var(--color-accent)]">
                写评析
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
