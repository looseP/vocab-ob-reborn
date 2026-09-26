/**
 * L3 错题库 · 枢纽（2026-09-26）。
 *
 * 三处改动，每一处都对着一个已知缺陷：
 *
 * 1. **两腿合并**（P1-1）：数据源从「句级单腿 + cursor」换成统一投影
 *    （`client.listUnifiedErrorBook`），题做完判错也进得来。分页从 cursor 改为
 *    offset——cursor 在两腿间不成立（旧实现游标走 attempts、显示按语境去重，
 *    两者口径不一致，见 `eb1-error-book-aggregation-cursor-2026-09-12.md:117`）。
 * 2. **按 kind 分区**（CONTEXT.md「错题条目」）：题级 / 句级各自成区，标题带
 *    本页计数。口径写在标签上，不再让两个同名数字互相打架。
 * 3. **回流出口**（P1-2）：每行给出站内 URL——句级「再练一次」进练习页只练这一条
 *    语境；题级「回看原题」进题型空间/题纸深链。题既无来源也无题纸时**不给死按钮**，
 *    如实说明原因。收错题的面终于能消费错题。
 *
 * 边界：只读面（不发任何写请求），不消费 FSRS 概念（ADR-0004 §6）。
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Direction, L3SubSpace, L3UnifiedErrorBookItem } from "@/domain";
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
  buildErrorBookHubRow,
  buildErrorBookHubSections,
  ERROR_BOOK_OUTCOME_LABELS,
  errorBookRowActionLabel,
  errorBookSourceLabel,
  type ErrorBookHubRow,
} from "../viewModels/l3ErrorBookHubViewModel";

const PAGE_SIZE = 20;

interface L3ErrorBookPageProps {
  client: L3FrontendClient;
  onNavigate(intent: L3NavigationIntent): void;
}

function normalizeUnknownError(error: unknown): NormalizedL3Error {
  return isNormalizedL3Error(error) ? error : normalizeL3TransportError(error);
}

function formatWhen(iso: string): string {
  return iso ? iso.slice(0, 10) : "";
}

function HubRow({ row, onNavigate }: { row: ErrorBookHubRow; onNavigate(intent: L3NavigationIntent): void }) {
  const navigate = useNavigate();
  const { item } = row;
  const outcome = ERROR_BOOK_OUTCOME_LABELS[item.latest_outcome] ?? item.latest_outcome;
  return (
    <li className="space-y-1 rounded-lg border border-[var(--color-border)] px-3 py-2" data-testid={`error-book-row-${row.kind}`}>
      <p className="text-[13px] leading-relaxed">{item.target_label || "（该记录未含内容快照）"}</p>
      <p className="text-[11px] text-[var(--color-ink-soft)]">
        {row.kind === "sentence"
          ? `练习类型：${item.practice_type ?? "—"}`
          : `题型：${item.target_secondary ?? "—"}`}
        {" · "}来源：{errorBookSourceLabel(item)}
        {item.space ? ` · 子空间：${item.space}` : ""}
      </p>
      <p className="text-[11px] text-[var(--color-ink-soft)]">
        最近判定：{outcome} · 错误 {item.wrong_count} 次
        {formatWhen(item.latest_at) ? ` · ${formatWhen(item.latest_at)}` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-3 pt-0.5">
        {row.href ? (
          <button
            type="button"
            data-testid={`error-book-retry-${row.kind}`}
            onClick={() => navigate(row.href as string)}
            className="rounded-full border border-[var(--color-accent)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--color-accent)]"
          >
            {errorBookRowActionLabel(row)}
          </button>
        ) : (
          <span className="text-[11px] text-[var(--color-ink-soft)]">{row.hrefMissingReason}</span>
        )}
        {/* 句级仍保留「查看语境」：再练是回路，查看是取证，两个出口不互相取代。 */}
        {row.kind === "sentence" && (
          <L3NavigationActions
            actions={[navigationAction("查看语境", { target: "context", contextId: item.target_id })]}
            onNavigate={onNavigate}
          />
        )}
      </div>
    </li>
  );
}

export function L3ErrorBookPage({ client, onNavigate }: L3ErrorBookPageProps) {
  const [space, setSpace] = useState<L3SubSpace | null>(null);
  const [direction, setDirection] = useState<Direction | null>(null);
  const [rows, setRows] = useState<L3UnifiedErrorBookItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<NormalizedL3Error | null>(null);

  const load = useCallback(async (nextOffset: number) => {
    setLoading(true);
    setError(null);
    try {
      const page = await client.listUnifiedErrorBook({ space, direction, limit: PAGE_SIZE, offset: nextOffset });
      setTotal(page.total);
      setOffset(nextOffset);
      setRows((prev) => (nextOffset === 0 ? page.items : [...prev, ...page.items]));
    } catch (caught) {
      setError(normalizeUnknownError(caught));
    } finally {
      setLoading(false);
    }
  }, [client, space, direction]);

  useEffect(() => {
    void load(0);
  }, [load]);

  const sections = buildErrorBookHubSections(rows);
  const hasMore = rows.length < total;

  return (
    <section className="l3-page space-y-4">
      <p className="eyebrow">L3 Error Book</p>
      <h2>错题库：练错的都在这里，且能直接回去再练</h2>
      <p className="lede">
        错题库是派生视图（非独立存储），合并两条腿：<strong>题级</strong>（做题判错/部分对）与
        <strong>句级</strong>（练习答错）。每条给出最近判定、错误次数与来源，并给一个站内出口——
        句级直接再练这一条语境，题级回到原题现场。
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
        {rows.length > 0 && (
          <span className="text-[11px] text-[var(--color-ink-soft)]" data-testid="error-book-counter">
            已加载 {rows.length} / 共 {total} 条
          </span>
        )}
      </div>

      <L3ErrorMessage error={error} />

      {!loading && !error && rows.length === 0 && (
        <p className="text-sm text-[var(--color-ink-soft)]">
          错题库为空：做题判错（题级）与练习答错（句级）都会出现在这里。
        </p>
      )}

      {sections
        .filter((section) => section.rows.length > 0)
        .map((section) => (
          <section key={section.kind} className="space-y-2" data-testid={`error-book-section-${section.kind}`}>
            <h3 className="text-sm font-semibold">
              {section.label}
              <span className="ml-2 text-[11px] font-normal text-[var(--color-ink-soft)]">
                本页 {section.rows.length} 条
              </span>
            </h3>
            <ul className="space-y-2">
              {section.rows.map((row) => (
                <HubRow key={row.key} row={row} onNavigate={onNavigate} />
              ))}
            </ul>
          </section>
        ))}

      {!loading && hasMore && (
        <button
          className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-ink-soft)]"
          onClick={() => void load(offset + PAGE_SIZE)}
          type="button"
        >
          加载更多
        </button>
      )}
      {loading && <p className="text-sm text-[var(--color-ink-soft)]">加载中…</p>}
    </section>
  );
}
