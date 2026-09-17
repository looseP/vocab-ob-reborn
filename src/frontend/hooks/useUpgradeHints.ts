/**
 * 升级提示映射（ADR-0018）：L1 复习卡上的首学徽标数据源。
 *
 * 会话初始化时【一次】批量取当前（默认）词书的进行中工单，建
 * wordId → { suggestion, workOrderId, direction } 映射；卡片只读映射。
 * 作答链路（提交评分 / 下一张卡）零新增网络请求——mark 仅在用户
 * 显式点击「标记升级」时发出。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/frontend/api/client";
import { getDefaultWordbook } from "@/frontend/api/wordbooks";

/** 三档升级建议（与后端 suggestion_snapshot.level 同值）。 */
export type UpgradeSuggestionLevel = "strong" | "normal" | "needs_settling";

export interface UpgradeHint {
  suggestion: UpgradeSuggestionLevel;
  workOrderId: string;
  direction: string;
}

/** 待升级清单 item 的最小读面（只取徽标需要字段）。 */
interface WorkOrderListItemLite {
  id: string;
  word_id: string;
  direction: string;
  suggestion: UpgradeSuggestionLevel;
}

interface MarkResponse {
  workOrder: { id: string; direction: string };
  suggestion: UpgradeSuggestionLevel;
}

export interface UseUpgradeHintsResult {
  /** wordId → 进行中工单的档位映射（含已标记词）。 */
  hints: Record<string, UpgradeHint>;
  /** 标记升级（POST）；成功后就地更新映射。失败向上抛出由调用方提示。 */
  mark: (wordId: string) => Promise<void>;
  /** 正在标记的 wordId（防连点）。 */
  markBusy: string | null;
}

/** 列表上限：与后端 UPGRADE_WORK_ORDER_MAX_LIMIT 对齐（够覆盖一本词书的进行中工单）。 */
const LIST_LIMIT = 200;

export function useUpgradeHints({ enabled = true }: { enabled?: boolean } = {}): UseUpgradeHintsResult {
  const [hints, setHints] = useState<Record<string, UpgradeHint>>({});
  const [markBusy, setMarkBusy] = useState<string | null>(null);
  const wordbookIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const wordbook = await getDefaultWordbook();
        wordbookIdRef.current = wordbook.id;
        const data = await apiFetch<{ items: WorkOrderListItemLite[] }>(
          `/upgrade-work-orders?wordbookId=${encodeURIComponent(wordbook.id)}&limit=${LIST_LIMIT}`,
        );
        if (cancelled) return;
        const map: Record<string, UpgradeHint> = {};
        for (const item of data.items ?? []) {
          map[item.word_id] = {
            suggestion: item.suggestion,
            workOrderId: item.id,
            direction: item.direction,
          };
        }
        setHints(map);
      } catch {
        // 徽标是增益信息：加载失败静默降级（不打扰复习节奏）。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const mark = useCallback(async (wordId: string) => {
    const wordbookId = wordbookIdRef.current;
    if (!wordbookId) return;
    setMarkBusy(wordId);
    try {
      const result = await apiFetch<MarkResponse>("/upgrade-work-orders", {
        method: "POST",
        body: JSON.stringify({ wordbookId, wordId }),
        timeoutMs: 20_000,
      });
      setHints((prev) => ({
        ...prev,
        [wordId]: {
          suggestion: result.suggestion,
          workOrderId: result.workOrder.id,
          direction: result.workOrder.direction,
        },
      }));
    } finally {
      setMarkBusy(null);
    }
  }, []);

  return { hints, mark, markBusy };
}
