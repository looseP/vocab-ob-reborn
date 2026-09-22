/**
 * 学习笔记导出按钮（Task 10）——**唯一**导出实现的两个宿主共用外壳。
 *
 * 宿主：
 *  - 页面版编辑器工具栏（`StudyNoteEditor` → 验收 `export-note-button`）；
 *  - 09B 卷面侧栏编辑器（`StudyNoteSecondaryExportButton`，供卷面宿主在需要时使用）。
 *
 * 两者都调用本组件的 `onExport`，而两侧的 `onExport` 都只做一件事：
 * `flushThenExportNote(...)`（`@/frontend/state/studyNoteExportFlusher`）——
 * 不存在第二份「先 flush 再 GET」的顺序实现，也不存在第二套锁定机制。
 *
 * 锁定（沿用既有 action-lock 模式，见 `L3ExamPaper.tsx:1703/1730` 的
 * `acquireActionLock("export")`）：
 *  - `lockRef` 同步闸门（React state 传播晚于事件，必须 ref 同步判定）；
 *  - `useState` 只驱动「导出中…」文案与 disabled；
 *  - IME：`onCompositionStart/End` 记录组合态，组合中点击一律忽略（合成期间
 *    输入不完整、且 flush 会等不到 compositionend）；
 *  - 键盘：组合态判定用 `event.nativeEvent.isComposing`（Enter/空格提交候选词不触发）。
 */
import { useCallback, useRef, useState } from "react";
import { Button } from "@/frontend/components/ui/Button";

export interface StudyNoteExportButtonProps {
  /** 执行一次导出（两侧宿主均传共享流水线）；返回值仅用于「是否已开始下载」的提示。 */
  onExport: () => Promise<{ ok: boolean; message?: string }>;
  /** 编辑被锁（恢复/导航/冲突处理中）时禁用出口。 */
  disabled?: boolean;
  /** 附加禁用原因（不可编辑时给出可见原因，不做假禁用）。 */
  disabledReason?: string | null;
  /** 主题样式（页面工具栏 vs 侧栏）。 */
  variant?: "ghost" | "secondary" | "primary";
  size?: "sm" | "md" | "lg";
  className?: string;
  testId?: string;
}

export function StudyNoteExportButton({
  onExport,
  disabled = false,
  disabledReason = null,
  variant = "ghost",
  size = "sm",
  className,
  testId = "export-note-button",
}: StudyNoteExportButtonProps) {
  const [busy, setBusy] = useState(false);
  /** 同步闸门：双击/连点的第二次点击在这里被丢弃（state 尚未传播）。 */
  const lockRef = useRef(false);
  /** IME 组合态（组合中不导出：内容不完整，且不应触发「下载出错」）。 */
  const composingRef = useRef(false);

  const handleExport = useCallback(async () => {
    if (lockRef.current) return; // 双击 / 重复点击 / 重入：忽略
    if (composingRef.current) return; // IME 组合中：忽略（不视为失败）
    lockRef.current = true;
    setBusy(true);
    try {
      await onExport();
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  }, [onExport]);

  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      onClick={() => void handleExport()}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
      }}
      onKeyDown={(event) => {
        // 组合确认键（Enter/空格）在部分浏览器里仍会派发 click：组合态直接吞掉。
        if (composingRef.current || event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      disabled={disabled || busy}
      title={disabled ? disabledReason ?? undefined : undefined}
      aria-busy={busy}
      data-testid={testId}
    >
      {busy ? "导出中…" : "导出 .md"}
    </Button>
  );
}
