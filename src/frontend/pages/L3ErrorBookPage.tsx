/**
 * L3 错题库（ADR-0019 §1/§3）：attempts(outcome=wrong) 的派生视图 + 两轴筛选。
 *
 * - 列表：GET error-book（space/direction 双筛选；cursor 分页——首屏不带 cursor
 *   （服务端 offset 兼容口径亦返回 nextCursor），「加载更多」以 nextCursor 续页）；
 * - 行：原句 + 目标词（来自作答时的 payload 快照）+ 最近作答结果 + 错误次数
 *   （聚合字段全部由服务端给出：跨分页窗口正确，不再回看 ≤100 条 attempts 窗口）；
 * - 只读面：不发任何写请求，也不消费 FSRS 概念。
 */
import { useCallback, useEffect, useState } from "react";
import type { Direction, L3SubSpace } from "@/domain";
import { L3ErrorMessage } from "../components/L3ErrorMessage";
import { L3NavigationActions } from "../components/L3NavigationActions";
import {
  isNormalizedL3Error,
  L3_DIRECTION_VALUES,
  L3_SUB_SPACE_VALUES,
  normalizeL3TransportError,
  type L3FrontendClient,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";
import { navigationAction, type L3NavigationIntent } from "../viewModels/l3NavigationViewModel";
import {
  buildErrorBookRows,
  outcomeLabel,
  type ErrorBookDisplayRow,
} from "../viewModels/l3PracticeViewModel";

const PAGE_SIZE = 20;

interface L3ErrorBookPageProps {
  client: L3FrontendClient;
  onNavigate(intent: L3NavigationIntent): void;
}

function normalizeUnknownError(error: unknown): NormalizedL3Error {
  return isNormalizedL3Error(error) ? error : normalizeL3TransportError(error);
}

/** 跨页合并：同一语境只保留首次出现的行（列表按时间倒序）。 */
function mergeRows(prev: ErrorBookDisplayRow[], next: ErrorBookDisplayRow[]): ErrorBookDisplayRow[] {
  const seen = new Set(prev.map((row) => row.contextId));
  const merged = [...prev];
  for (const row of next) {
    if (seen.has(row.contextId)) continue;
    seen.add(row.contextId);
    merged.push(row);
  }
  return merged;
}

export function L3ErrorBookPage({ client, onNavigate }: L3ErrorBookPageProps) {
  const [space, setSpace] = useState<L3SubSpace | null>(null);
  const [direction, setDirection] = useState<Direction | null>(null);
  const [rows, setRows] = useState<ErrorBookDisplayRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<NormalizedL3Error | null>(null);

  const load = useCallback(async (cursor: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const page = await client.listErrorBook({ space, direction, limit: PAGE_SIZE, cursor });
      const nextRows = buildErrorBookRows(page.items);
      setTotal(page.total);
      setNextCursor(page.nextCursor);
      setLoadedCount((prev) => (cursor === null ? page.items.length : prev + page.items.length));
      setRows((prev) => (cursor === null ? nextRows : mergeRows(prev, nextRows)));
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setLoading(false);
    }
  }, [client, space, direction]);

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <section className="l3-page space-y-4">
      <p className="eyebrow">L3 Error Book</p>
      <h2>错题库：练错的语境在这里回看</h2>
      <p className="lede">
        错题库是练习记录中「答错」的派生视图（非独立存储）。可按子空间 / 方向筛选；每行给出原句、目标词、最近作答与错误次数（服务端全量聚合，跨分页窗口）。
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-ink-soft)]">
          子空间
          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
            disabled={loading}
            onChange={(event) => setSpace((event.target.value || null) as L3SubSpace | null)}
            value={space ?? ""}
          >
            <option value="">全部</option>
            {L3_SUB_SPACE_VALUES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-ink-soft)]">
          方向
          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
            disabled={loading}
            onChange={(event) => setDirection((event.target.value || null) as Direction | null)}
            value={direction ?? ""}
          >
            <option value="">全部</option>
            {L3_DIRECTION_VALUES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        {loadedCount > 0 && (
          <span className="text-[11px] text-[var(--color-ink-soft)]">已加载 {loadedCount} / 共 {total} 条</span>
        )}
      </div>

      <L3ErrorMessage error={error} />

      {!loading && !error && rows.length === 0 && (
        <p className="text-sm text-[var(--color-ink-soft)]">错题库为空：练习中答错的语境会出现在这里。</p>
      )}

      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li className="space-y-1 rounded-lg border border-[var(--color-border)] px-3 py-2" key={row.contextId}>
              <p className="text-[13px] leading-relaxed">{row.text || "（该记录未含原句快照）"}</p>
              <p className="text-[11px] text-[var(--color-ink-soft)]">
                目标词：{row.target || "—"} · 错误 {row.wrongCount} 次
              </p>
              <p className="text-[11px] text-[var(--color-ink-soft)]">
                最近作答：{outcomeLabel(row.latestOutcome)}
                {row.latestAt ? ` · ${row.latestAt}` : ""}
              </p>
              <L3NavigationActions
                actions={[navigationAction("查看语境", { target: "context", contextId: row.contextId })]}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      )}

      {!loading && nextCursor !== null && (
        <button
          className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-ink-soft)]"
          onClick={() => void load(nextCursor)}
          type="button"
        >
          加载更多
        </button>
      )}
      {loading && <p className="text-sm text-[var(--color-ink-soft)]">加载中…</p>}
    </section>
  );
}
