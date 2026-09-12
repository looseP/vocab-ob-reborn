/**
 * OneClickForgettingCard — 一键遗忘确认流（ADR-0020 / T12）。
 *
 * 落点：仪表盘（DashboardPage）底部的低显著性入口。防误触（第一优先级）：
 * 1. 入口只做一件事——拉当次 preview；没有「跳过预览直接 apply」的路径；
 * 2. 确认弹窗：锚点清单默认全选、可逐个取消；提交集从**当次 preview 响应**
 *    构造，恒 ⊆ 当次响应；展示醒目计数与 agent 叙事占位槽（静态文案，
 *    不承诺、不伪造）。标记「取消勾选 = 一并挂起」，消灭选择歧义；
 * 3. apply 成功后展示执行结果；仅当持有 batchId 时提供「撤销本次遗忘」。
 *    apply（弹窗内）与 restore（结果区内）分属不同区域，不成对出现；
 * 4. 已知缺口（只报告，不修补）：无历史批次端点 → batchId 仅当次会话可用，
 *    刷新后撤销入口消失。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Undo2 } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Modal } from "@/frontend/components/ui/Modal";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import {
  applyForgetting,
  deriveL1ImpactCount,
  fetchDefaultWordbook,
  fetchForgettingPreview,
  restoreForgetting,
  resolveAnchorLabels,
  shortenWordId,
  type DefaultWordbook,
  type ForgettingApplyResult,
  type ForgettingPreview,
  type ForgettingRestoreResult,
} from "./forgettingFlow";

function friendlyError(error: unknown, fallback: string): string {
  if (error instanceof BrowserApiError && error.message.trim()) return error.message;
  return fallback;
}

export function OneClickForgettingCard() {
  // 默认词书：一次取用并缓存（promise 级缓存；失败即失效，点按可重试）。
  const bookPromiseRef = useRef<Promise<DefaultWordbook> | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const [book, setBook] = useState<DefaultWordbook | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preview, setPreview] = useState<ForgettingPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyError, setApplyError] = useState<{ message: string; stale: boolean } | null>(null);
  const [applied, setApplied] = useState<(ForgettingApplyResult & { bookId: string }) | null>(null);
  const [restored, setRestored] = useState<ForgettingRestoreResult | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const ensureBook = useCallback((): Promise<DefaultWordbook> => {
    bookPromiseRef.current ??= fetchDefaultWordbook().catch((error: unknown) => {
      bookPromiseRef.current = null; // 失败不缓存，允许重试
      throw error;
    });
    return bookPromiseRef.current;
  }, []);

  // 预取默认词书：只预热 promise 缓存，不改变任何渲染路径；失败保持静默。
  useEffect(() => {
    void ensureBook().catch(() => undefined);
  }, [ensureBook]);

  /** 确认步骤入口：以当次 preview 响应重置选择（默认全选）并打开弹窗。 */
  const startConfirm = (wordbook: DefaultWordbook, fresh: ForgettingPreview) => {
    setPreview(fresh);
    setSelected(new Set(fresh.anchors));
    setLabels({});
    setApplyError(null);
    setConfirmOpen(true);
    void resolveAnchorLabels(wordbook.id, fresh.anchors).then((resolved) => {
      if (aliveRef.current) setLabels(resolved);
    });
  };

  const openPreview = async () => {
    setCardError(null);
    setPreviewBusy(true);
    try {
      const wordbook = await ensureBook();
      const fresh = await fetchForgettingPreview(wordbook.id);
      if (!aliveRef.current) return;
      setBook(wordbook);
      startConfirm(wordbook, fresh);
    } catch (error) {
      if (!aliveRef.current) return;
      setCardError(friendlyError(error, "无法加载一键遗忘预览，请重试"));
    } finally {
      if (aliveRef.current) setPreviewBusy(false);
    }
  };

  /** apply 返回「预览已过期」时的重取：同一弹窗内重新 preview 并重置选择。 */
  const reloadPreview = async () => {
    if (!book) return;
    setPreviewBusy(true);
    setApplyError(null);
    try {
      const fresh = await fetchForgettingPreview(book.id);
      if (!aliveRef.current) return;
      startConfirm(book, fresh);
    } catch (error) {
      if (!aliveRef.current) return;
      setApplyError({ message: friendlyError(error, "预览加载失败，请重试"), stale: true });
    } finally {
      if (aliveRef.current) setPreviewBusy(false);
    }
  };

  const toggleAnchor = (wordId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(wordId)) next.delete(wordId);
      else next.add(wordId);
      return next;
    });
  };

  const confirmApply = async () => {
    if (!book || !preview) return;
    // 防误触红线：提交集只从当次 preview 响应构造（按响应顺序），恒 ⊆ 当次响应。
    const confirmedAnchorIds = preview.anchors.filter((wordId) => selected.has(wordId));
    setApplyBusy(true);
    setApplyError(null);
    try {
      const result = await applyForgetting(book.id, confirmedAnchorIds);
      if (!aliveRef.current) return;
      setApplied({ ...result, bookId: book.id });
      setRestored(null);
      setRestoreError(null);
      setConfirmOpen(false);
    } catch (error) {
      if (!aliveRef.current) return;
      if (error instanceof BrowserApiError && error.status === 422) {
        setApplyError({ message: "预览已过期，锚点清单可能已变化。请重新预览后再确认。", stale: true });
      } else {
        setApplyError({ message: friendlyError(error, "应用失败，请重试"), stale: false });
      }
    } finally {
      if (aliveRef.current) setApplyBusy(false);
    }
  };

  const runRestore = async () => {
    if (!applied) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      const result = await restoreForgetting(applied.bookId, applied.batchId);
      if (!aliveRef.current) return;
      setRestored(result);
      setApplied(null); // batchId 用毕即弃：撤销入口随之收起
    } catch (error) {
      if (!aliveRef.current) return;
      setRestoreError(friendlyError(error, "撤销失败，请重试"));
    } finally {
      if (aliveRef.current) setRestoreBusy(false);
    }
  };

  const closeConfirm = () => {
    if (applyBusy) return; // 执行中禁止关闭，避免状态割裂
    setConfirmOpen(false);
  };

  const selectedCount = preview ? preview.anchors.filter((wordId) => selected.has(wordId)).length : 0;
  const l1Impact = preview ? deriveL1ImpactCount(preview, selectedCount) : 0;
  const unresolvedCount = preview ? preview.anchors.filter((wordId) => !labels[wordId]).length : 0;

  return (
    <Card className="border-dashed">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--color-ink-soft)]">一键遗忘（重置本书进度）</p>
          <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">
            搁置复习后回归时，保留几个锚点词、其余进度先挂起；不删除任何词条与复习历史，可随时撤销。
          </p>
        </div>
        <Button variant="ghost" size="sm" disabled={previewBusy} onClick={() => void openPreview()}>
          {previewBusy ? "加载中…" : "一键遗忘"}
        </Button>
      </div>

      {cardError && <p className="mt-2 text-xs text-[var(--color-accent-2)]">{cardError}</p>}

      {applied && (
        <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted-warm)] p-3">
          <p className="text-sm text-[var(--color-ink)]">
            已应用一键遗忘：挂起 L1 进度 <span className="font-semibold">{applied.suspendedCount}</span> 条 · 暂停 L2
            进度 <span className="font-semibold">{applied.pausedCount}</span> 条
          </p>
          <div className="mt-2">
            <Button variant="ghost" size="sm" disabled={restoreBusy} onClick={() => void runRestore()}>
              <Undo2 className="h-3.5 w-3.5" />
              {restoreBusy ? "撤销中…" : "撤销本次遗忘"}
            </Button>
          </div>
          <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
            撤销入口仅限本次会话（刷新页面后该入口消失）。
          </p>
          {restoreError && <p className="mt-1 text-xs text-[var(--color-accent-2)]">{restoreError}</p>}
        </div>
      )}

      {restored && (
        <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted-warm)] p-3 text-sm text-[var(--color-ink)]">
          已撤销本次遗忘：恢复 L1 进度 <span className="font-semibold">{restored.restoredCount}</span> 条 · 解除 L2 暂停{" "}
          <span className="font-semibold">{restored.unpausedCount}</span> 条
        </div>
      )}

      <Modal
        open={confirmOpen}
        onClose={closeConfirm}
        title="一键遗忘（重置本书进度）"
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={closeConfirm} disabled={applyBusy}>
              取消
            </Button>
            <Button variant="danger" onClick={() => void confirmApply()} disabled={applyBusy || previewBusy}>
              {applyBusy ? "应用中…" : "确认应用"}
            </Button>
          </>
        }
      >
        {book && <p className="text-sm text-[var(--color-ink)]">目标词书：《{book.name}》</p>}

        <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted-warm)] p-3">
          <p className="text-sm text-[var(--color-ink)]">
            将挂起 <span className="text-2xl font-bold text-[var(--color-accent-2)]">{l1Impact}</span> 条 L1 学习进度
          </p>
          <p className="mt-1 text-xs text-[var(--color-ink-soft)]">L2 辨析进度将一并暂停（具体条数在执行后显示）。</p>
          <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
            不会删除任何词条与复习历史：进度只是被置为「已挂起」，可随时撤销。
          </p>
        </div>

        <div className="mt-4">
          <p className="text-sm font-medium text-[var(--color-ink)]">
            保留锚点（{selectedCount}/{preview?.anchors.length ?? 0}）
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">默认全选；取消勾选的词会随其余进度一起被挂起。</p>
          <div className="mt-2 max-h-56 space-y-1 overflow-y-auto pr-1">
            {preview?.anchors.map((wordId) => (
              <label
                key={wordId}
                className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-[var(--color-ink)] hover:bg-[var(--color-surface-glass-hover)]"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0"
                  checked={selected.has(wordId)}
                  disabled={applyBusy}
                  onChange={() => toggleAnchor(wordId)}
                />
                <span className="truncate">{labels[wordId] ?? shortenWordId(wordId)}</span>
              </label>
            ))}
          </div>
          {unresolvedCount > 0 && (
            <p className="mt-1 text-xs text-[var(--color-ink-soft)]">
              部分锚点词面暂不可用（显示为编号缩写，不影响操作）。
            </p>
          )}
        </div>

        <div className="mt-4 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 text-xs text-[var(--color-ink-soft)]">
          （预留：将在此展示 agent 叙事解读）
        </div>

        {applyError && (
          <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted-warm)] p-3">
            <p className="text-xs text-[var(--color-ink)]">{applyError.message}</p>
            {applyError.stale && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-2"
                disabled={previewBusy}
                onClick={() => void reloadPreview()}
              >
                {previewBusy ? "重新加载中…" : "重新预览"}
              </Button>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}
