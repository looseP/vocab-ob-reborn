/**
 * 反馈面板（W8，S§2/§5）：总体反馈 / 值得保留的表达 / 最多三项重点修改 / 维度折叠。
 *
 * 纪律：
 * - agent 文本纯文本渲染（React 文本节点，无 dangerouslySetInnerHTML / 不执行 HTML）；
 * - 定位跳转：anchor 指向本稿 UTF-16 区间 → textarea#writing-draft-textarea 选中并聚焦；
 * - 刷新：手动触发，loading/error/retry；**刷新失败保留旧结果并明确提示**（不假装最新）；
 * - 绑定校验：feedback.textSha256 与当前 detail.textSha256 不一致 → 隐藏内容并提示，
 *   绝不把旧反馈当作当前稿反馈展示；内容已清理 → 占位「本稿正文已清理」。
 */
import { useState } from "react";
import type { WritingFeedback, WritingSheetDetail, WritingTaskDto } from "@/domain";
import { Button } from "@/frontend/components/ui/Button";
import { WRITING_TEXTAREA_ID } from "@/frontend/viewModels/writingNavigation";

const DIMENSION_LABELS: Record<string, string> = {
  task_response: "任务回应",
  organization: "组织与结构",
  language: "语言准确性",
  expression: "表达与风格",
};

export interface WritingFeedbackPanelProps {
  task: WritingTaskDto;
  detail: WritingSheetDetail;
  onRefresh: () => Promise<void>;
}

type RefreshState = { status: "idle" | "loading" | "error"; message?: string };

function jumpToAnchor(start: number, end: number): boolean {
  const node = document.getElementById(WRITING_TEXTAREA_ID);
  if (!(node instanceof HTMLTextAreaElement)) return false;
  node.focus();
  node.setSelectionRange(start, end);
  return true;
}

function FeedbackBody(props: { feedback: WritingFeedback }) {
  const { feedback } = props;
  const [jumpHint, setJumpHint] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <section aria-label="总体反馈">
        <h4 className="text-xs font-semibold text-[var(--color-ink-soft)]">总体反馈</h4>
        <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-ink)]">{feedback.summary}</p>
      </section>

      {feedback.strengths.length > 0 && (
        <section aria-label="值得保留的表达">
          <h4 className="text-xs font-semibold text-[var(--color-ink-soft)]">值得保留的表达</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-[var(--color-ink)]">
            {feedback.strengths.map((item, index) => (
              <li key={index} className="whitespace-pre-wrap">{item}</li>
            ))}
          </ul>
        </section>
      )}

      {feedback.priorities.length > 0 ? (
        <section aria-label="重点修改">
          <h4 className="text-xs font-semibold text-[var(--color-ink-soft)]">重点修改（{feedback.priorities.length}）</h4>
          <ol className="mt-1 space-y-2">
            {feedback.priorities.map((priority) => (
              <li key={priority.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
                <div className="text-[11px] text-[var(--color-ink-soft)]">{DIMENSION_LABELS[priority.dimension] ?? priority.dimension}</div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-ink)]">{priority.observation}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-ink-soft)]">建议：{priority.action}</p>
                {priority.anchor ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-1"
                    onClick={() => {
                      const ok = jumpToAnchor(priority.anchor!.start, priority.anchor!.end);
                      setJumpHint(ok ? null : "当前视图无法定位（正文不可选中）");
                    }}
                  >
                    跳至原句
                  </Button>
                ) : (
                  <div className="mt-1 text-[11px] text-[var(--color-ink-soft)]">全文建议</div>
                )}
              </li>
            ))}
          </ol>
          {jumpHint && <p className="mt-1 text-xs text-[var(--color-accent-2)]">{jumpHint}</p>}
        </section>
      ) : (
        <p className="text-sm text-[var(--color-ink-soft)]">本次反馈没有需要特别修改的点。</p>
      )}

      <details className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
        <summary className="cursor-pointer text-xs font-semibold text-[var(--color-ink-soft)]">分维度内容</summary>
        <dl className="mt-2 space-y-2">
          {Object.entries(feedback.dimensions).map(([key, value]) => (
            <div key={key}>
              <dt className="text-[11px] font-medium text-[var(--color-ink-soft)]">
                {DIMENSION_LABELS[key] ?? key}{value.applicable ? "" : "（本稿不适用）"}
              </dt>
              <dd className="whitespace-pre-wrap text-sm text-[var(--color-ink)]">{value.comment}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

export function WritingFeedbackPanel({ task, detail, onRefresh }: WritingFeedbackPanelProps) {
  const [refresh, setRefresh] = useState<RefreshState>({ status: "idle" });
  const feedback = detail.feedback;

  if (detail.contentStatus === "cleared") {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-ink-soft)]">
        本稿正文已清理，不再展示评语。
      </div>
    );
  }

  const hashMismatch = feedback != null
    && detail.textSha256 != null
    && feedback.textSha256 !== detail.textSha256;

  const runRefresh = async () => {
    setRefresh({ status: "loading" });
    try {
      await onRefresh();
      setRefresh({ status: "idle" });
    } catch {
      setRefresh({ status: "error", message: "刷新失败；以下仍为上次结果。" });
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-glass)] p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">
          反馈{detail.sheet.revisionNo != null ? ` · 第 ${detail.sheet.revisionNo} 稿` : ""}
        </h3>
        <Button size="sm" variant="secondary" onClick={runRefresh} disabled={refresh.status === "loading"}>
          {refresh.status === "loading" ? "刷新中…" : "刷新反馈"}
        </Button>
      </div>

      {refresh.status === "error" && (
        <div className="rounded-lg border border-[var(--color-accent-2)] bg-[var(--color-surface)] p-2 text-xs text-[var(--color-accent-2)]" role="alert">
          {refresh.message}
        </div>
      )}

      {hashMismatch ? (
        <div className="rounded-lg border border-[var(--color-accent-2)] bg-[var(--color-surface)] p-2 text-xs text-[var(--color-accent-2)]" role="alert">
          反馈与当前正文不一致，已隐藏以免误导；请刷新反馈后重试。
        </div>
      ) : feedback == null ? (
        <div className="space-y-2">
          <p className="text-sm text-[var(--color-ink-soft)]">本稿已保存，尚无反馈。可复制本地评阅指令交给评阅助手，完成后回到本页刷新。</p>
        </div>
      ) : (
        <>
          <div className="text-[11px] text-[var(--color-ink-soft)]">
            版本 {feedback.version} · 评阅者 {feedback.lastEditor} · {feedback.updatedAt}
          </div>
          <FeedbackBody feedback={feedback.feedback} />
        </>
      )}
    </div>
  );
}
