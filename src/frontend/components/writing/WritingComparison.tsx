/**
 * 双稿对照（W8，S§2）：两稿原文左右/上下对照 + 各自独立反馈。
 *
 * 纪律：
 * - 只对照 sealed 稿（草稿不进入）；两稿分别读取（不借用对方反馈）；
 * - 内容已清理显示占位（不从缓存复活）；不做复杂字符 diff、不宣称分数提升；
 * - mobile 单列堆叠、桌面双栏（Tailwind md: 断点）。
 */
import { useEffect, useState } from "react";
import type { WritingSheetDetail } from "@/domain";
import { writingClient } from "@/frontend/api/writingClient";
import { Button } from "@/frontend/components/ui/Button";
import { revisionLabel } from "@/frontend/viewModels/writingNavigation";

interface ColumnState {
  status: "loading" | "ready" | "error";
  detail: WritingSheetDetail | null;
  message?: string;
}

const initialColumn: ColumnState = { status: "loading", detail: null };

function Column(props: { title: string; state: ColumnState }) {
  const { title, state } = props;
  return (
    <section className="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <h4 className="text-xs font-semibold text-[var(--color-ink-soft)]">{title}</h4>
      {state.status === "loading" && <p className="mt-2 text-sm text-[var(--color-ink-soft)]">加载中…</p>}
      {state.status === "error" && (
        <p className="mt-2 text-sm text-[var(--color-accent-2)]" role="alert">{state.message ?? "读取失败"}</p>
      )}
      {state.status === "ready" && state.detail && (
        <div className="mt-2 space-y-2">
          <div className="text-[11px] text-[var(--color-ink-soft)]">
            {revisionLabel(state.detail.sheet)} · {state.detail.sheet.sealedAt ?? state.detail.sheet.updatedAt}
          </div>
          {state.detail.contentStatus === "cleared" || state.detail.text == null ? (
            <p className="text-sm text-[var(--color-ink-soft)]">本稿正文已清理，仅保留稿次记录。</p>
          ) : (
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-[var(--color-ink)]">
              {state.detail.text}
            </pre>
          )}
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-glass)] p-2">
            {state.detail.contentStatus === "cleared" ? (
              <p className="text-xs text-[var(--color-ink-soft)]">评语随正文清理，不再展示。</p>
            ) : state.detail.feedback ? (
              <p className="whitespace-pre-wrap text-xs text-[var(--color-ink)]">
                <span className="font-semibold text-[var(--color-ink-soft)]">反馈（v{state.detail.feedback.version}）：</span>
                {state.detail.feedback.feedback.summary}
              </p>
            ) : (
              <p className="text-xs text-[var(--color-ink-soft)]">本稿尚无反馈。</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export interface WritingComparisonProps {
  taskId: string;
  leftSheetId: string;
  rightSheetId: string;
  onClose: () => void;
}

export function WritingComparison({ taskId, leftSheetId, rightSheetId, onClose }: WritingComparisonProps) {
  const [left, setLeft] = useState<ColumnState>(initialColumn);
  const [right, setRight] = useState<ColumnState>(initialColumn);

  useEffect(() => {
    let cancelled = false;
    const load = async (sheetId: string, set: (state: ColumnState) => void) => {
      try {
        const detail = await writingClient.getSheet(taskId, sheetId);
        if (cancelled) return;
        if (detail.sheet.status !== "sealed") {
          set({ status: "error", detail: null, message: "仅已提交稿可参与对照。" });
          return;
        }
        set({ status: "ready", detail });
      } catch (error) {
        if (cancelled) return;
        set({ status: "error", detail: null, message: error instanceof Error ? error.message : "读取失败" });
      }
    };
    setLeft(initialColumn);
    setRight(initialColumn);
    void load(leftSheetId, setLeft);
    void load(rightSheetId, setRight);
    return () => { cancelled = true; };
  }, [taskId, leftSheetId, rightSheetId]);

  return (
    <section aria-label="双稿对照" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-ink)]">双稿对照</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>关闭对照</Button>
      </div>
      <div className="flex flex-col gap-3 md:flex-row">
        <Column title={`左：${revisionLabel(left.detail?.sheet ?? { status: "sealed", revisionNo: null })}`} state={left} />
        <Column title={`右：${revisionLabel(right.detail?.sheet ?? { status: "sealed", revisionNo: null })}`} state={right} />
      </div>
      <p className="text-[11px] text-[var(--color-ink-soft)]">对照仅呈现原文与各自反馈，不宣称分数变化。</p>
    </section>
  );
}
