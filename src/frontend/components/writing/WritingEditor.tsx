/**
 * 写作编辑器（W7，S§2/§4）——可靠保存 + 提交屏障 + 导出先行 flush。
 *
 * 纪律（逐条对应验收）：
 * - 保存逻辑**只**用 useWritingDraft（六态/防抖/退避/IME/flush/导航保护），不另造；
 * - 提交顺序：锁定编辑 → await flush() → 取最新确认版本（GET 权威）→ submit；
 *   任一步失败：不提交、不清空正文、不显示成功；
 * - 冲突：保留本地正文 + 提供「复制正文」与「载入服务器稿」（由上层重挂重置控制器）；
 * - 导出：先 flush，失败禁止导出；成功后以实际响应生成文件（不生成空文件/假成功）；
 * - 服务端保存响应经 controller 序号纪律，不覆盖用户更新的本地输入。
 */
import { useEffect, useMemo, useState } from "react";
import type { WritingSheetDetail, WritingTaskDto } from "@/domain";
import { countEnglishWords } from "@/domain/l3-writing";
import { writingClient } from "@/frontend/api/writingClient";
import { useWritingDraft } from "@/frontend/hooks/useWritingDraft";
import { Button } from "@/frontend/components/ui/Button";
import { saveStateLabel, WRITING_TEXTAREA_ID } from "@/frontend/viewModels/writingNavigation";

export interface WritingEditorProps {
  task: WritingTaskDto;
  detail: WritingSheetDetail;
  /** 提交成功（上层：刷新详情 + replace URL 到明确 sheetId）。 */
  onSubmitted: () => Promise<void>;
  /** 冲突时「载入服务器稿」：上层刷新详情并重挂本组件（重置控制器）。 */
  onLoadServerVersion: () => Promise<void>;
  /** 未保存脏态上报（上层导航守卫；卸载时归零）。 */
  onDirtyChange?: (dirty: boolean) => void;
}

function downloadMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function WritingEditor({ task, detail, onSubmitted, onLoadServerVersion, onDirtyChange }: WritingEditorProps) {
  const readOnly = detail.sheet.status !== "draft";
  const [actionState, setActionState] = useState<"idle" | "submitting" | "exporting">("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [copyHint, setCopyHint] = useState<string | null>(null);

  const save = useMemo(
    () => async (input: { text: string; expectedVersion: number }) => {
      const result = await writingClient.saveDraft(task.id, detail.sheet.id, input);
      return { draftVersion: result.sheet.draftVersion, textSha256: result.textSha256 };
    },
    [task.id, detail.sheet.id],
  );
  const load = useMemo(
    () => async () => {
      const latest = await writingClient.getSheet(task.id, detail.sheet.id);
      return { text: latest.text ?? "", version: latest.sheet.draftVersion };
    },
    [task.id, detail.sheet.id],
  );

  const draft = useWritingDraft({
    initialText: detail.text ?? "",
    initialVersion: detail.sheet.draftVersion,
    save,
    load,
  });

  // 脏态上报：变化时同步；卸载归零（避免离开后守卫误拦）。
  const blocked = draft.navigationBlocked;
  useEffect(() => {
    onDirtyChange?.(blocked);
    return () => onDirtyChange?.(false);
  }, [blocked, onDirtyChange]);

  const busy = actionState !== "idle";

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(draft.text);
      setCopyHint("已复制当前正文");
    } catch {
      setCopyHint("复制失败，请手动选择文本");
    }
  };

  const submit = async () => {
    setActionState("submitting");
    setActionError(null);
    try {
      // ① flush：保存未确认（失败/在途未确认）→ reject，禁止提交。
      await draft.flush();
      // ② 取最新确认版本（服务器权威）。
      const latest = await writingClient.getSheet(task.id, detail.sheet.id);
      if (latest.sheet.status !== "draft") {
        await onSubmitted();
        return;
      }
      // ③ 提交（CAS）。
      await writingClient.submitSheet(task.id, detail.sheet.id, { expectedVersion: latest.sheet.draftVersion });
      await onSubmitted();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setActionError(
        message.includes("empty") || message.includes("422")
          ? "正文为空或未通过校验，未提交；你的正文仍在。"
          : "提交未成功（可能是版本冲突或网络问题）；你的正文仍在，可重试。",
      );
    } finally {
      setActionState("idle");
    }
  };

  const exportMarkdown = async () => {
    setActionState("exporting");
    setActionError(null);
    try {
      // 先 flush：失败禁止导出（不生成伪“最新稿”）。
      await draft.flush();
      const markdown = await writingClient.exportSheet(task.id, detail.sheet.id);
      downloadMarkdown(`writing-${detail.sheet.id}.md`, markdown);
    } catch {
      setActionError("导出失败，未生成文件。请确认已保存后重试。");
    } finally {
      setActionState("idle");
    }
  };

  const text = draft.text;
  const wordCount = countEnglishWords(text);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-[var(--color-ink-soft)]">
          <span role="status" aria-live="polite">
            保存状态：{readOnly ? "已提交（只读）" : saveStateLabel(draft.state)}
          </span>
          <span>· 英文词数估算 {wordCount}</span>
          <span>· 字符数 {text.length}</span>
          {!readOnly && draft.navigationBlocked && <span className="text-[var(--color-accent-2)]">（有未保存内容）</span>}
        </div>
        <div className="flex items-center gap-2">
          {!readOnly && draft.state === "error" && (
            <Button size="sm" variant="secondary" onClick={() => void draft.retry()}>重试保存</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void copyText()}>复制正文</Button>
          <Button size="sm" variant="secondary" onClick={() => void exportMarkdown()} disabled={busy}>
            {actionState === "exporting" ? "导出中…" : "导出本稿"}
          </Button>
          {!readOnly && (
            <Button size="sm" onClick={() => void submit()} disabled={busy || draft.state === "conflict"}>
              {actionState === "submitting" ? "提交中…" : "提交本稿"}
            </Button>
          )}
        </div>
      </div>

      {copyHint && <p className="text-[11px] text-[var(--color-ink-soft)]">{copyHint}</p>}

      {!readOnly && draft.state === "conflict" && (
        <div className="rounded-lg border border-[var(--color-accent-2)] bg-[var(--color-surface)] p-2 text-xs text-[var(--color-ink)]" role="alert">
          <div className="font-medium text-[var(--color-accent-2)]">另一处更新了这份草稿（版本冲突）。</div>
          <div className="mt-1">你的本地正文仍保留在此，未被覆盖。可先「复制正文」备份，再选择载入服务器稿。</div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => void copyText()}>复制本地正文</Button>
            <Button size="sm" variant="secondary" onClick={() => void onLoadServerVersion()}>载入服务器稿</Button>
          </div>
        </div>
      )}

      {!readOnly && draft.state === "error" && (
        <div className="rounded-lg border border-[var(--color-accent-2)] bg-[var(--color-surface)] p-2 text-xs text-[var(--color-ink)]" role="alert">
          尚未保存，请保持页面打开；可「重试保存」或「复制正文」备份。
        </div>
      )}

      {actionError && <p className="text-xs text-[var(--color-accent-2)]" role="alert">{actionError}</p>}

      <textarea
        id={WRITING_TEXTAREA_ID}
        aria-label="作文正文"
        autoFocus={!readOnly}
        className="min-h-[50vh] w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm leading-6 text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
        placeholder={readOnly ? "" : "从这里开始写…（自动保存）"}
        value={text}
        readOnly={readOnly}
        onChange={(event) => draft.setText(event.target.value)}
        onCompositionStart={draft.onCompositionStart}
        onCompositionEnd={draft.onCompositionEnd}
      />

      {!readOnly && (
        <p className="text-[11px] text-[var(--color-ink-soft)]">
          提交后本地评阅助手可读取本稿；提交后不可再编辑本稿（修改请另起第二稿）。
        </p>
      )}
    </div>
  );
}
