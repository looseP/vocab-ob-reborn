/**
 * 待录核对面（ADR-0037 决策 6）。
 *
 * 这是 owner 对 agent 录题产物的**核对责任面**。它必须带足核对所需的事实：
 *  - **答案键**（`question.answer`）—— 没有它，「采纳」就是盲签；
 *  - **每条证据锚点在原文里的实际切片**（服务端算好的 `evidenceExcerpts`）——
 *    让 owner 确认 agent 标的证据确实指向它声称的那句话；
 *  - **越界锚点显式告警**（`outOfRange`）—— 静默截断成一个看似合法的短句，
 *    会让 owner 误以为证据是对的。
 *
 * 为什么不给 agent 看这个面：agent 只需要"写入成功"就算完事，核对是人的责任。
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/frontend/api/client";

type PendingAnswer = {
  choice?: string;
  choices?: string[];
  text?: string;
  sample?: string;
  points?: string[];
};

type PendingOption = { key: string; text: string };

type PendingQuestion = {
  id: string;
  source_id: string | null;
  file_key: string | null;
  question_type: string;
  stem: string;
  options: PendingOption[];
  answer: PendingAnswer;
  explanation: string | null;
  evidence: Array<{ start: number; end: number; label: string }>;
  created_by: string;
  created_at: string;
};

type PendingItem = {
  question: PendingQuestion;
  sourceTitle: string | null;
  evidenceExcerpts: Array<{ excerpt: string | null; outOfRange: boolean }>;
};

type AcceptResult = {
  results: Array<{ id: string; ok: boolean; reason?: "not_found" | "not_pending"; status?: string }>;
  acceptedCount: number;
};

/** 答案键的人话形式（选择题给选项字母，主观题给答案要点）。 */
function answerLabel(answer: PendingAnswer): string {
  if (answer.choice) return `选项 ${answer.choice}`;
  if (answer.choices?.length) return `多选 ${answer.choices.join("、")}`;
  if (answer.text) return answer.text;
  if (answer.sample) return `参考：${answer.sample}`;
  if (answer.points?.length) return `要点：${answer.points.join("；")}`;
  return "（未给答案）";
}

export function PendingQuestionsPanel({ onToast }: {
  onToast: (kind: "success" | "error", msg: string) => void;
}) {
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const page = await apiFetch<{ items: PendingItem[]; total: number }>("/l3/questions?status=pending&limit=100");
      setItems(page.items);
      setTotal(page.total);
    } catch {
      onToast("error", "待录列表读取失败");
      setItems([]);
    }
  }, [onToast]);
  useEffect(() => { void load(); }, [load]);

  const reportFailures = (result: AcceptResult, done: number) => {
    const failed = result.results.filter((entry) => !entry.ok);
    if (failed.length === 0) {
      onToast("success", `已采纳 ${done} 道待录题`);
      return;
    }
    // 部分失败必须逐条可见（决策 4/9）：整批报成功会让人以为全过了
    onToast("error", `已采纳 ${done} 条，${failed.length} 条未成功（已被采纳/驳回，或不存在）`);
  };

  const accept = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const result = ids.length === 1
        ? await apiFetch<AcceptResult>(`/l3/questions/${ids[0]}/accept`, { method: "POST" })
        : await apiFetch<AcceptResult>("/l3/questions/accept-batch", {
          method: "POST",
          body: JSON.stringify({ questionIds: ids }),
        });
      reportFailures(result, result.acceptedCount);
      setPicked(new Set());
      await load();
    } catch {
      onToast("error", "采纳失败");
    } finally {
      setBusy(false);
    }
  };

  const reject = async (id: string) => {
    setBusy(true);
    try {
      await apiFetch(`/l3/questions/${id}/reject`, { method: "POST" });
      onToast("success", "已驳回该待录题");
      setPicked(new Set());
      await load();
    } catch {
      onToast("error", "驳回失败");
    } finally {
      setBusy(false);
    }
  };

  if (items === null) {
    return <p className="text-sm text-[var(--color-ink-soft)]">读取待录列表…</p>;
  }
  if (items.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-[var(--color-ink-soft)]">没有待录题。</p>
        <p className="text-xs text-[var(--color-ink-soft)]">
          agent 用 <code>POST /api/l3/questions</code> 录的题会先落在这里（status=pending），
          采纳后才进入做题面。理由：答案键一旦被作答就永久不可改。
        </p>
      </div>
    );
  }

  const allPicked = items.every((item) => picked.has(item.question.id));
  const pickedIds = items.map((item) => item.question.id).filter((id) => picked.has(id));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm">
          待录 {total} 道 · 已选 {pickedIds.length}
        </p>
        <label className="flex items-center gap-1 text-xs text-[var(--color-ink-soft)]">
          <input
            type="checkbox"
            checked={allPicked}
            onChange={(event) => setPicked(event.target.checked
              ? new Set(items.map((item) => item.question.id))
              : new Set())}
          />
          全选
        </label>
        <button
          type="button"
          disabled={busy || pickedIds.length === 0}
          onClick={() => void accept(pickedIds)}
          className="rounded-full bg-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50"
        >
          采纳所选（{pickedIds.length}）
        </button>
      </div>

      {items.map((item) => {
        const { question, sourceTitle, evidenceExcerpts } = item;
        const hasOutOfRange = evidenceExcerpts.some((entry) => entry.outOfRange);
        return (
          <article
            key={question.id}
            data-testid={`pending-item-${question.id}`}
            className="space-y-2 rounded-lg border border-[var(--color-border)] p-3"
          >
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                aria-label={`选择待录题 ${question.id}`}
                checked={picked.has(question.id)}
                onChange={(event) => setPicked((prev) => {
                  const next = new Set(prev);
                  if (event.target.checked) next.add(question.id);
                  else next.delete(question.id);
                  return next;
                })}
              />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-xs text-[var(--color-ink-soft)]">
                  {sourceTitle ?? question.file_key ?? "（无材料）"} · {question.question_type} · 由 {question.created_by} 录
                </p>
                <p className="text-sm">{question.stem}</p>
                {question.options.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-[var(--color-ink-soft)]">
                    {question.options.map((option) => (
                      <li key={option.key} data-testid={`pending-option-${option.key}`}>
                        <span className="font-medium">{option.key}.</span> {option.text}
                      </li>
                    ))}
                  </ul>
                )}
                {/* 决策 6：答案键必须在采纳前可见 —— 否则「采纳」是盲签 */}
                <p data-testid="pending-answer" className="text-xs">
                  <span className="text-[var(--color-ink-soft)]">答案：</span>
                  <span className="font-medium">{answerLabel(question.answer)}</span>
                </p>
                {question.explanation && (
                  <p className="text-xs text-[var(--color-ink-soft)]">解析：{question.explanation}</p>
                )}
                {evidenceExcerpts.length > 0 && (
                  <div className="space-y-0.5">
                    <p className="text-xs text-[var(--color-ink-soft)]">证据：</p>
                    {evidenceExcerpts.map((entry, index) => (
                      <p
                        key={`${question.id}-evidence-${index}`}
                        data-testid={entry.outOfRange ? "pending-evidence-out-of-range" : "pending-evidence"}
                        className={`text-xs ${entry.outOfRange ? "text-[var(--color-danger,var(--color-ink))]" : "text-[var(--color-ink-soft)]"}`}
                      >
                        {entry.outOfRange
                          ? `「${question.evidence[index]?.label ?? index}」锚点越界（原文对不上）—— 请驳回或改锚点`
                          : `「${question.evidence[index]?.label ?? index}」${entry.excerpt}`}
                      </p>
                    ))}
                  </div>
                )}
                {hasOutOfRange && (
                  <p className="text-xs">⚠️ 有锚点越界：证据位置与原文不符，采纳前请先核对。</p>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void accept([question.id])}
                className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-50"
              >
                采纳
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void reject(question.id)}
                className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs disabled:opacity-50"
              >
                驳回
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
