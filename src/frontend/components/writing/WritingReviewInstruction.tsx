/**
 * 作文评阅指令卡（W8）——「复制本地评阅指令」的单一真源（S§7/§5）。
 * 只含 taskId/sheetId/相对 API/评阅范围与 schema 说明；**不含任何 token**，
 * 不承诺自动回灌（提交后由用户回到本页手动刷新反馈）。
 */
import { useState } from "react";
import { Button } from "@/frontend/components/ui/Button";

export function buildReviewInstruction(taskId: string, sheetId: string): string {
  return [
    "请以本地评阅助手身份评阅一篇作文（阅读—反馈闭环的第 3 步）。",
    "",
    `- 任务 ID：${taskId}`,
    `- 稿次 ID：${sheetId}`,
    "",
    "步骤：",
    `1) 读取：GET /api/l3/writing/tasks/${taskId}/sheets/${sheetId}/feedback-context`,
    "   （返回该稿题面、正文、textSha256 与当前 feedbackVersion；以响应为准，不要臆造正文。）",
    "2) 生成：按 WritingFeedback schemaVersion=1 结构给出 summary / strengths / dimensions / priorities；",
    "   priorities 最多 3 条；anchor 使用 UTF-16 offset（start/end），quote 必须与正文逐字一致；没有问题可给 0 条。",
    `3) 写回：PUT /api/l3/writing/tasks/${taskId}/sheets/${sheetId}/feedback`,
    "   携带 expectedVersion（首次为 0；已有反馈用上一步的 feedbackVersion）、textSha256（须等于正文 hash）与新的 requestId。",
    "",
    "说明：写入后请回到作文页面点击「刷新反馈」查看结果；本指令不承诺自动回灌。",
  ].join("\n");
}

export function WritingReviewInstruction(props: { taskId: string; sheetId: string }) {
  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");
  const instruction = buildReviewInstruction(props.taskId, props.sheetId);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(instruction);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <div className="space-y-2">
      <textarea
        readOnly
        aria-label="本地评阅指令"
        className="h-40 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-[11px] leading-5 text-[var(--color-ink-soft)]"
        value={instruction}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={copy}>复制本地评阅指令</Button>
        {copied === "ok" && <span className="text-xs text-[var(--color-ink-soft)]">已复制</span>}
        {copied === "failed" && <span className="text-xs text-[var(--color-accent-2)]">复制失败，请手动选择上方文本</span>}
      </div>
    </div>
  );
}
