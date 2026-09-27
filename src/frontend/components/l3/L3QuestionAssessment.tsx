/**
 * 题卡「评析」子区（批次二增补，ADR-0034 v2 条 10/11）。
 *
 * 一题一条的 owner/agent 共建沉淀：textarea 编辑 + 只读预览切换（不引 Markdown
 * 编辑器依赖，预览为纯文本 pre-wrap）；挂题不挂题纸（跨题纸、跨 venue 永存）；
 * last_editor/updated_at 留痕展示（latest-wins 无历史版本）。
 *
 * **2026-09-27：数据改为父层批量下发**（`assessment` prop + `onSaved` 回写）。原先本组件
 * 挂载即自取单题 GET，20 题的卷 = 20 个请求（N+1），而父层同时**数不出**本卷有几条评析
 * ⇒ 纯净模式不敢按 S-1「隐藏必须自带声明」隐藏评析（那条偏离登记在
 * `examModeVisibility.ts`）。现在父层一次批量读回，同一份数据既供计数也供渲染。
 *
 * **本组件不再持有评析 state**：保存成功后经 `onSaved` 把行交回父层，由父层那张
 * questionId→行 的映射做单一更新。不要为了「保存后立刻显示」把行 copy 进本地 state
 * ——那会造出第二个真源，换卷（父层重新批量读）时它就会留下陈旧行。宁可多传一次
 * 回调，也不要两处各存一份。
 *
 * 保存仍走单题 PUT（写面与读面本就是两个端点，同 `annotations`），成功后不再重发整批：
 * 一次编辑只影响一题，重拉 20 条是为省一次回调而付 20 个请求。
 */
import { useCallback, useState } from "react";
import {
  saveQuestionAssessment,
  type L3Assessment,
} from "@/frontend/api/l3Client";
import { useToast } from "@/frontend/components/ui/Toast";

function formatEditedAt(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function L3QuestionAssessment({ questionId, assessment, loadState = "ready", onRetry, onSaved }: {
  questionId: string;
  /** 父层批量读回的行；`null` = 该题还没有评析（空态，不是错误）。 */
  assessment: L3Assessment | null;
  /**
   * 读面状态（2026-09-27）。`error` 时**不给任何写入口** —— PUT 是 latest-wins
   * upsert，用户在没看到旧内容的情况下点「写评析」就会把它覆盖，那是数据丢失。
   * 「读失败」也不是「没有」：显示成「待沉淀」是关于用户自己劳动的假陈述。
   */
  loadState?: "loading" | "ready" | "error";
  /** 读失败时的重试出口（不给的话用户只能刷新整页）。 */
  onRetry?: () => void;
  /** 保存成功：把服务端行交回父层（父层是唯一真源，本组件不留副本）。 */
  onSaved: (row: L3Assessment) => void;
}) {
  const { addToast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

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
      onSaved(await saveQuestionAssessment(questionId, contentMd));
      setEditing(false);
      addToast("success", "评析已保存");
    } catch {
      addToast("error", "保存失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }, [draft, questionId, addToast, onSaved]);

  const hasContent = Boolean(assessment && assessment.content_md.trim().length > 0);

  // 读失败：只给「重试」，不给展开（展开里的一切都以「已知旧内容」为前提）。
  if (loadState === "error") {
    return (
      <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-[var(--color-surface)] px-2.5 py-1.5 text-xs ring-1 ring-[var(--color-border)]"
        onClick={(event) => event.stopPropagation()}>
        <span className="text-[var(--color-ink-soft)]">评析 · 未能读取</span>
        {onRetry && (
          <button type="button" onClick={onRetry}
            className="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-ink)] hover:border-[var(--color-accent)]">
            重读评析
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg bg-[var(--color-surface)] text-xs ring-1 ring-[var(--color-border)]"
      onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); setExpanded((v) => !v); }}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 whitespace-nowrap px-2.5 py-1.5 text-xs font-semibold text-[var(--color-ink-soft)] hover:text-[var(--color-accent)]"
      >
        {/* 读取中不给「待沉淀」：那是对用户自己劳动的假陈述，而且会闪一下。 */}
        <span>评析 · {loadState === "loading" ? "读取中" : hasContent ? "已沉淀" : "待沉淀"}</span>
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
