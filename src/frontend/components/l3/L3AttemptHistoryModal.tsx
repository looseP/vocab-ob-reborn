/**
 * 作答历史 modal（批次二，0034，设计卡 D8）：
 * 题卡徽标点开的历史预览——题干 + attempts 时间线（时间 / venue / 答案摘要 /
 * 自评）+ 本题注记摘要 + 「去题型空间打开此文」深链 + 单条历史软删（内联确认）。
 * 默认预览不打断做题流（modal 而非跳视图）；删除是软删——只影响历史列表与
 * 结果页占位，成绩统计保持定格时口径（服务端保持软删行）。
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import type { L3Attempt, QuestionAnnotation } from "@/frontend/api/l3Client";
import { hasAnswerContent } from "@/domain/l3-sheets";

export interface AttemptHistoryQuestion {
  id: string;
  stem: string;
}

const VENUE_LABELS: Record<string, string> = { file: "题型空间", paper: "整卷" };

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatAttemptTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 题型无关答案的展示摘要（choice/text/choices 约定键；无作答内容显示「未作答」）。 */
export function summarizeAttemptAnswer(answer: unknown): string {
  if (answer == null) return "内容已清理";
  if (typeof answer === "string") return answer.trim().length > 0 ? truncate(answer, 60) : "未作答";
  if (typeof answer === "object" && !Array.isArray(answer)) {
    const record = answer as Record<string, unknown>;
    if (typeof record.choice === "string" && record.choice.trim().length > 0) return `选 ${record.choice}`;
    if (Array.isArray(record.choices) && record.choices.length > 0) return `多选 ${record.choices.join("")}`;
    if (typeof record.text === "string" && record.text.trim().length > 0) return truncate(record.text, 60);
  }
  // 口径统一修正（2026-09-17）：无作答内容（仅主观痕迹/空对象）≠ 已作答。
  return hasAnswerContent(answer) ? "已作答" : "未作答";
}

export function L3AttemptHistoryModal({
  question,
  attempts,
  annotations,
  deepLink,
  onClose,
  onDelete,
}: {
  question: AttemptHistoryQuestion;
  attempts: L3Attempt[];
  annotations: QuestionAnnotation[];
  /** 「去题型空间打开此文」深链（?venue=<题型>&file=<文件键>）；无文件身份时为 null。 */
  deepLink: { venue: string; fileKey: string } | null;
  onClose: () => void;
  onDelete: (attemptId: string) => void;
}) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog" aria-modal="true" aria-label="作答历史">
      <div className="max-h-[80vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl bg-[var(--color-surface)] p-5 shadow-xl ring-1 ring-[var(--color-border)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-bold">作答历史</h3>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-soft)]">{truncate(question.stem, 90)}</p>
          </div>
          <button type="button" onClick={onClose}
            className="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
            关闭
          </button>
        </div>

        <div>
          <h4 className="mb-1.5 text-xs font-semibold text-[var(--color-ink-soft)]">作答记录 · {attempts.length} 次</h4>
          {attempts.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-ink-soft)]">
              还没有作答记录。
            </p>
          ) : (
            <ul className="space-y-1.5">
              {attempts.map((attempt) => (
                <li key={attempt.id} className="rounded-lg bg-[var(--color-surface)] p-2.5 text-xs ring-1 ring-[var(--color-border)]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-[var(--color-accent-soft,var(--color-surface))] px-2 py-0.5 text-[10px] text-[var(--color-accent)]">
                      {VENUE_LABELS[attempt.venue] ?? attempt.venue}
                    </span>
                    <span className="text-[var(--color-ink-soft)]">{formatAttemptTime(attempt.created_at)}</span>
                    <span className="font-medium text-[var(--color-ink)]">{summarizeAttemptAnswer(attempt.answer)}</span>
                    <span className="ml-auto flex items-center gap-1.5">
                      {pendingDeleteId === attempt.id ? (
                        <>
                          <button type="button"
                            onClick={() => { setPendingDeleteId(null); onDelete(attempt.id); }}
                            className="rounded-md border border-rose-400 px-2 py-0.5 text-[10px] text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30">
                            确认删除
                          </button>
                          <button type="button" onClick={() => setPendingDeleteId(null)}
                            className="rounded-md px-2 py-0.5 text-[10px] text-[var(--color-ink-soft)]">
                            取消
                          </button>
                        </>
                      ) : (
                        <button type="button" onClick={() => setPendingDeleteId(attempt.id)}
                          className="rounded-md px-2 py-0.5 text-[10px] text-[var(--color-ink-soft)] hover:text-rose-500">
                          删除
                        </button>
                      )}
                    </span>
                  </div>
                  {attempt.self_assessment != null && (
                    <p className="mt-1 text-[11px] text-[var(--color-ink-soft)]">
                      自评：{truncate(JSON.stringify(attempt.self_assessment), 60)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {annotations.length > 0 && (
          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-[var(--color-ink-soft)]">本题注记 · {annotations.length} 条</h4>
            <ul className="space-y-1">
              {annotations.slice(0, 5).map((annotation) => (
                <li key={annotation.id} className="flex items-start gap-2 text-xs">
                  {annotation.stage === "draft" && (
                    <span className="mt-0.5 shrink-0 rounded-full border border-dashed border-[var(--color-accent)] px-1.5 text-[10px] text-[var(--color-accent)]">
                      草稿
                    </span>
                  )}
                  <span className="min-w-0 text-[var(--color-ink)]">
                    {truncate(annotation.note || annotation.excerpt || "（无内容）", 60)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-2.5">
          <p className="text-[10px] text-[var(--color-ink-soft)]">删除只影响历史列表；成绩统计保持定格时口径。</p>
          {deepLink && (
            <Link to={`/l3?venue=${encodeURIComponent(deepLink.venue)}&file=${encodeURIComponent(deepLink.fileKey)}`}
              className="shrink-0 text-xs text-[var(--color-accent)] hover:underline">
              去题型空间打开此文 →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
