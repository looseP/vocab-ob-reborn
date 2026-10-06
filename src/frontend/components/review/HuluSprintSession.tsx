/**
 * HuluSprintSession —— 葫芦冲刺会话（ADR-0041，P1 起；P2 补多轮流转）。
 *
 * 葫芦 = 挂在 L1 词书上的阶段性多轮冲刺计划：整批词按页推进、页级检索闸门、
 * 多轮滚动、只记轮次耗时。本组件是**第 6 个显式复习模式**的会话体（不选该模式
 * 则分支不可达），与 `ReviewSession` / `DrillSession` / `LadderReviewSession` 并列。
 *
 * 三条硬约束（违反任一 = 返工）：
 *  1. **单卡路径零请求**：逐词翻开 / 自认只改本地 state，不发任何网络请求。
 *     请求只发生在四个时点：取页载荷（每页 1 次）、页结算（每页 1 次）、
 *     轮次开始（每轮 1 次）、轮次收尾（每轮 1 次）。
 *  2. **不嵌 `ReviewCardView`**：那是服务于评分流的组件（会写 FSRS）。这里**新写
 *     只读卡面**（词头 / 音标 / 词性 / 释义 / 助记），答案层默认折叠。
 *  3. **闸门读计划行的 `gate_ratio` 列值**，不写死；判定用前后端共用的纯函数
 *     `huluGateDecision`（单一真口径）。不达闸 → 整页自认清零、退回学习态、
 *     **不发请求**。
 *
 * 会话恢复（R3）：`localStorage["vocab:hulu:sprint:<planId>"]` + 24h TTL，
 * 恢复时校验 planId / roundNo 与服务端一致，不一致即丢弃、从 `pages_passed` 页重来。
 * 未结算页本来就没入库，超时丢失的代价只是重走当前页。
 *
 * 「本轮页已全部结算但轮未收尾」的恢复（P2 必修）：末页整页删空后刷新、或末页
 * 结算与 finish 之间中断，重进时页游标会落在页数上。这不是错误状态 ——
 * `loadPage` 与 `enterPlan` 都把它当作「本轮已可收尾」直接 `finishRound`（幂等），
 * 不报错、不清缓存回 setup。`loadPage` 的自动结算结果写回 `round` state，
 * 否则游标滞后会把这条路径变成当场卡死。
 *
 * 注意 `Card` / `Badge` 不透传额外 props，故所有 `data-testid` 都挂在原生元素上。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, Check, ChevronDown, ChevronRight, RotateCcw, Sprout, X } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { Markdown } from "@/frontend/components/ui/Markdown";
import { SenseList } from "@/frontend/components/words/SenseList";
import { useOptionalToast } from "@/frontend/components/ui/Toast";
import { HuluSpeedCurve } from "@/frontend/components/review/HuluSpeedCurve";
import { apiFetch } from "@/frontend/api/client";
import { getDefaultWordbook } from "@/frontend/api/wordbooks";
import {
  huluGateDecision,
  huluPageCount,
  type HuluPagePayload,
  type HuluPageWordItem,
  type HuluPlanSummary,
  type HuluPlanWithRounds,
  type HuluRoundRow,
} from "@/domain/hulu-sprint";

/** 每页自认结论（仅前端暂存；不入库、不参与任何 FSRS 写入）。 */
type Verdict = "pass" | "miss";

/** 缓存键前缀（R3）：独立前缀，不进经典会话 `vocab:review:session:` 的扫描面。 */
const CACHE_PREFIX = "vocab:hulu:sprint:";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface PersistedHuluSession {
  planId: string;
  roundNo: number;
  pageIndex: number;
  /** 已翻开的卡（页内下标）。 */
  flipped: number[];
  /** 已自认的结论（页内下标 → pass/miss）。 */
  verdict: Record<string, Verdict>;
  savedAt: number;
}

/** 词书选项（创建表单的选择器；默认词书优先）。 */
interface WordbookOption {
  id: string;
  name: string;
  isDefault?: boolean;
}

function cacheKey(planId: string): string {
  return `${CACHE_PREFIX}${planId}`;
}

function readCache(planId: string): PersistedHuluSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(planId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedHuluSession;
    if (parsed.planId !== planId) return null;
    if (Date.now() - (parsed.savedAt ?? 0) > CACHE_TTL_MS) {
      window.localStorage.removeItem(cacheKey(planId));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 扫描前缀，取最近一条未过期缓存（刷新/重进后续上的入口）。 */
function findLatestCache(): PersistedHuluSession | null {
  if (typeof window === "undefined") return null;
  try {
    let best: PersistedHuluSession | null = null;
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(CACHE_PREFIX)) continue;
      const planId = key.slice(CACHE_PREFIX.length);
      const entry = readCache(planId);
      if (entry && (!best || entry.savedAt > best.savedAt)) best = entry;
    }
    return best;
  } catch {
    return null;
  }
}

function writeCache(entry: Omit<PersistedHuluSession, "savedAt">): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(cacheKey(entry.planId), JSON.stringify({ ...entry, savedAt: Date.now() }));
  } catch {
    /* quota / private mode：静默失败，行为退化为无缓存 */
  }
}

function clearCache(planId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(cacheKey(planId));
  } catch {
    /* ignore */
  }
}

/** 404 判据（越界页 = 本轮页已全部结算，不是错误）。 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && (error as { status?: unknown }).status === 404
  );
}

/** 错误码判据（D1：页内词集漂移 → 自动重取本页，不落错误页）。 */
function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === code
  );
}

/** D1 的稳定机器码（服务端 `src/errors/codes.ts` 单一真源的同值字面量）。 */
const HULU_PAGE_ALIVE_MISMATCH = "HULU_PAGE_ALIVE_MISMATCH";

/** jsonb 元素的字符串窄化（缺字段 / 空串一律 null，防御性渲染）。 */
function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** 例句的前 N 条（形状由导入器决定，逐项窄化；无 text 的条目直接丢弃）。 */
function pickExamples(examples: unknown[], limit = 2): Array<{ text: string; translation: string | null; source: string | null }> {
  const picked: Array<{ text: string; translation: string | null; source: string | null }> = [];
  for (const entry of examples) {
    if (picked.length >= limit) break;
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const text = asText(record.text);
    if (!text) continue;
    picked.push({
      text,
      translation: asText(record.translation),
      source: asText(record.source),
    });
  }
  return picked;
}

/** 秒 → 「n 分 ss 秒」（轮次耗时展示）。 */
function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)} 分 ${String(total % 60).padStart(2, "0")} 秒`;
}

/** 今天的日期键（YYYY-MM-DD，本地日历日）—— 创建表单的默认值。 */
function todayKey(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 考试日是否已过（YYYY-MM-DD 字典序即日期序）。 */
function examDatePassed(examDate: string): boolean {
  return examDate < todayKey();
}

type Phase = "setup" | "loading" | "sprint" | "finished" | "plan" | "error";

/**
 * 卡背五层披露（R10 / D-B）——**纯展示**，一切数据来自页载荷（单卡路径零请求）。
 *
 *   Tier0  短释主行（大字）
 *   义项层 core_definitions → `SenseList`（priority 序即重要程度）；空则降级
 *          `definition_md`（与 L1 卡背同一判据）
 *   助记锚 mnemonic_text + mnemonic_type 徽标（显著，非低调常驻）
 *   例句   examples 前 1–2 条（text + 可选来源/译文，防御性渲染）
 *   Tier2  semantic_chain（默认折叠、可点展开）+ prototype_text
 *
 * 不嵌 `ReviewCardView`（那是评分流组件、会写 FSRS），不调 `useWordDetail`
 * （每卡一请求会破零请求约束）—— 只复用 `SenseList` 这类纯展示子组件。
 */
function HuluCardFace({ word, index }: { word: HuluPageWordItem; index: number }) {
  const [chainOpen, setChainOpen] = useState(false);
  const senses = word.core_definitions ?? [];
  const hasSenses = senses.length > 0;
  // 防御性：契约保证 definition_md 是字符串，但旧缓存/局部 mock 可能缺席 ——
  // 这里退化为「无降级内容」而不是整卡崩掉。
  const hasDefinitionMd = !hasSenses && (word.definition_md ?? "").trim().length > 0;
  const examples = pickExamples(word.examples ?? []);
  const hasChain = (word.semantic_chain ?? "").trim().length > 0;

  return (
    <div className="space-y-3" data-testid={`hulu-answer-${index}`}>
      {/* ── Tier0：短释主行（大字） ── */}
      {word.short_definition ? (
        <p className="text-lg font-medium text-[var(--color-ink)]" data-testid={`hulu-tier0-${index}`}>
          {word.short_definition}
        </p>
      ) : (
        <p className="text-sm text-[var(--color-ink-soft)]">暂无释义</p>
      )}

      {/* ── 义项层：结构化义项（按 priority 序）→ 无则降级 definition_md ── */}
      {hasSenses && (
        <div className="rounded-xl bg-[var(--color-surface-muted)] px-3 py-2.5" data-testid={`hulu-senses-${index}`}>
          <SenseList senses={senses} />
        </div>
      )}
      {hasDefinitionMd && (
        <div
          className="rounded-xl bg-[var(--color-surface-muted)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--color-ink)]"
          data-testid={`hulu-definition-${index}`}
        >
          <Markdown content={word.definition_md} />
        </div>
      )}

      {/* ── 助记锚（显著；数据缺席时整块不渲染） ── */}
      {word.mnemonic_text && (
        <div
          className="flex items-start gap-2 rounded-xl border border-[var(--color-pill-warm-border)] bg-[var(--color-surface-glass)] px-3 py-2"
          data-testid={`hulu-mnemonic-${index}`}
        >
          <span className="shrink-0 text-xs font-semibold text-[var(--color-highlight)]">助记</span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] leading-snug text-[var(--color-ink)]">{word.mnemonic_text}</p>
          </div>
          {word.mnemonic_type && (
            <span data-testid={`hulu-mnemonic-type-${index}`}>
              <Badge tone="warm">{word.mnemonic_type}</Badge>
            </span>
          )}
        </div>
      )}

      {/* ── 例句（前 1–2 条；无例句安静缺席） ── */}
      {examples.length > 0 && (
        <ul className="space-y-1.5" data-testid={`hulu-examples-${index}`}>
          {examples.map((example, i) => (
            <li key={i} className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2">
              <p className="text-[12.5px] leading-snug text-[var(--color-ink)]">{example.text}</p>
              {example.translation && (
                <p className="mt-0.5 text-[11.5px] text-[var(--color-ink-soft)]">{example.translation}</p>
              )}
              {example.source && (
                <p className="mt-0.5 text-[11px] text-[var(--color-ink-soft)]">— {example.source}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* ── Tier2：语义链（默认折叠）+ 原型 ── */}
      {(hasChain || word.prototype_text) && (
        <div data-testid={`hulu-tier2-${index}`}>
          <button
            type="button"
            onClick={() => setChainOpen((open) => !open)}
            className="flex items-center gap-1 text-xs text-[var(--color-ink-soft)] hover:text-[var(--color-ink)]"
            data-testid={`hulu-tier2-toggle-${index}`}
          >
            {chainOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            语义链 / 词源
          </button>
          {chainOpen && (
            <div
              className="mt-1.5 space-y-1 rounded-xl bg-[var(--color-surface-muted)] px-3 py-2"
              data-testid={`hulu-tier2-body-${index}`}
            >
              {word.prototype_text && (
                <p className="text-[12.5px] leading-snug text-[var(--color-ink)]">原型 · {word.prototype_text}</p>
              )}
              {hasChain && (
                <p className="text-[12.5px] leading-snug text-[var(--color-ink)]">{word.semantic_chain}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function HuluSprintSession({ onBack }: { onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>("setup");
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<HuluPlanSummary | null>(null);
  /** 轻提示（可选：无 Provider 时安静缺席，见 useOptionalToast 的注释）。 */
  const toast = useOptionalToast();
  const [rounds, setRounds] = useState<HuluRoundRow[]>([]);
  const [round, setRound] = useState<HuluRoundRow | null>(null);
  const [page, setPage] = useState<HuluPagePayload | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [flipped, setFlipped] = useState<Record<number, boolean>>({});
  const [verdict, setVerdict] = useState<Record<number, Verdict>>({});
  /** 学习态：本页没到闸门，答案全展开、不可进下一页、不发请求。 */
  const [study, setStudy] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);
  /** 本页被闸门拦下的次数（纯展示）。 */
  const [blocked, setBlocked] = useState(0);
  const [busy, setBusy] = useState(false);

  // 创建表单
  const [wordbooks, setWordbooks] = useState<WordbookOption[]>([]);
  const [wordbookId, setWordbookId] = useState("");
  const [examDate, setExamDate] = useState(todayKey);
  const [targetRounds, setTargetRounds] = useState(4);
  const [pageSize, setPageSize] = useState(20);
  /** 可选挂起开关（默认关；只能创建时设定）。 */
  const [suspendReview, setSuspendReview] = useState(false);

  /** 当前页是否已结算（游标之内）→ 只读回看，不可改。 */
  const settled = round !== null && pageIndex < round.pages_passed;
  const pages = page?.pages ?? 0;
  const isLastPage = pages > 0 && pageIndex >= pages - 1;
  /** 计划是否已走到目标轮数（末轮收尾后服务端把 status 置 completed）。 */
  const isPlanComplete = plan !== null
    && (plan.status === "completed" || (round?.round_no ?? 0) >= plan.target_rounds);

  /** 落盘（每次自认 / 翻页后调用；纯本地，零请求）。 */
  const persist = useCallback((next: {
    planId: string; roundNo: number; pageIndex: number;
    flipped: Record<number, boolean>; verdict: Record<number, Verdict>;
  }) => {
    writeCache({
      planId: next.planId,
      roundNo: next.roundNo,
      pageIndex: next.pageIndex,
      flipped: Object.entries(next.flipped).filter(([, value]) => value).map(([key]) => Number(key)),
      verdict: Object.fromEntries(
        Object.entries(next.verdict).filter(([, value]) => value !== undefined),
      ) as Record<string, Verdict>,
    });
  }, []);

  /** 计划 + 轮次刷新（缩时曲线的唯一数据源：GET /hulu/plans/:id）。 */
  const refreshPlan = useCallback(async (planId: string): Promise<HuluPlanWithRounds> => {
    const detail = await apiFetch<HuluPlanWithRounds>(`/hulu/plans/${planId}`);
    setPlan(detail.plan);
    setRounds(detail.rounds);
    return detail;
  }, []);

  /**
   * 轮次收尾：POST finish → 展示本轮耗时 + 曲线（含刚收尾的这一轮）。
   * 幂等：服务端对已收尾轮返回现状，重复调用不会重写耗时。
   */
  const finishRound = useCallback(async (planId: string, roundNo: number): Promise<void> => {
    const finished = await apiFetch<HuluRoundRow>(`/hulu/plans/${planId}/rounds/${roundNo}/finish`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    clearCache(planId);
    setRound(finished);
    setElapsedSeconds(finished.elapsed_seconds ?? 0);
    try {
      await refreshPlan(planId);
    } catch {
      /* 曲线刷新失败不影响「本轮已收尾」的展示 */
    }
    setPhase("finished");
  }, [refreshPlan]);

  /**
   * 取一页载荷并**跳过 alive = 0 的页**（整页定格词已删 → 服务端自动通过）。
   *
   * `alive = 0` 的页不发渲染、直接结算 `{ pageIndex, passed: 0, total: 0 }`，
   * 然后继续往后走 —— 直到遇到有存活词的页，或走到末页。
   *
   * 越界页（404）= 本轮页已**全部结算**（末页结算与收尾之间中断、或末页整页删空
   * 后的续上）：直接 `finishRound`（幂等）并返回 true，**不报错、不清缓存**。
   *
   * 返回 true 表示「本轮已收尾」（调用方不要再覆盖 phase）。
   */
  const loadPage = useCallback(async (
    planId: string,
    roundNo: number,
    index: number,
  ): Promise<boolean> => {
    let cursor = Math.max(0, index);
    for (;;) {
      let payload: HuluPagePayload;
      try {
        payload = await apiFetch<HuluPagePayload>(`/hulu/plans/${planId}/pages/${cursor}`);
      } catch (err) {
        if (isNotFound(err)) {
          await finishRound(planId, roundNo);
          return true;
        }
        throw err;
      }
      if (payload.alive > 0) {
        setPage(payload);
        setPageIndex(cursor);
        setFlipped({});
        setVerdict({});
        setStudy(false);
        return false;
      }
      // 整页删空：直接结算（huluGateDecision(0, 0, gate) = pass，服务端同口径）
      const settledRound = await apiFetch<HuluRoundRow>(
        `/hulu/plans/${planId}/rounds/${roundNo}/pages`,
        { method: "POST", body: JSON.stringify({ pageIndex: cursor, passed: 0, total: 0 }) },
      );
      // 写回游标（不写回 → settled 判据滞后，末页「完成本轮」按钮会点不动）
      setRound(settledRound);
      if (cursor >= payload.pages - 1) {
        // 末页整页删空：本页已自动结算，交「完成本轮」按钮收尾（不静默收尾）。
        setPage(payload);
        setPageIndex(cursor);
        setFlipped({});
        setVerdict({});
        setStudy(false);
        return false;
      }
      cursor += 1;
    }
  }, [finishRound]);

  /**
   * 进入一个计划的冲刺：轮次（幂等）+ 会话恢复（R3）+ 取当前页。
   *
   * `cache` 只在从缓存续上时传；planId / roundNo 与服务端不一致即丢弃缓存。
   * 恢复时若页游标已落在页数上（本轮页全部结算但轮未收尾）→ 直接收尾（幂等）。
   */
  const enterPlan = useCallback(async (planId: string, cache: PersistedHuluSession | null) => {
    const detail = await apiFetch<HuluPlanWithRounds>(`/hulu/plans/${planId}`);
    setPlan(detail.plan);
    setRounds(detail.rounds);

    if (detail.plan.status !== "active") {
      // 计划已结束：清缓存，展示计划页（曲线 / 挂起状态），不静默重建。
      clearCache(planId);
      setPhase("plan");
      return;
    }

    // 轮次：后端幂等 —— 有未收尾轮就返回它，否则新开一轮。
    const started = await apiFetch<HuluRoundRow>(`/hulu/plans/${planId}/rounds`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setRound(started);

    // 恢复校验：roundNo 一致才续用页内进度；否则丢弃、从 pages_passed 页重来。
    const resume = cache && cache.roundNo === started.round_no ? cache : null;
    const startIndex = resume
      ? Math.max(resume.pageIndex, started.pages_passed)
      : started.pages_passed;

    // 本轮页已全部结算（结算后中断 / 末页整页删空）：直接收尾，不是错误状态。
    const totalPages = huluPageCount(detail.plan.word_count, detail.plan.page_size);
    if (totalPages > 0 && startIndex >= totalPages) {
      await finishRound(planId, started.round_no);
      return;
    }

    const completed = await loadPage(planId, started.round_no, startIndex);
    if (completed) return;
    if (resume && startIndex === resume.pageIndex) {
      setFlipped(Object.fromEntries(resume.flipped.map((key) => [key, true])));
      setVerdict(Object.fromEntries(
        Object.entries(resume.verdict).map(([key, value]) => [Number(key), value]),
      ));
    }
    setPhase("sprint");
  }, [loadPage, finishRound]);

  /** 创建（或取回既有）计划 → 进入冲刺。 */
  const bootstrap = useCallback(async (options: {
    examDate: string; targetRounds: number; pageSize: number;
    wordbookId: string; suspendReview: boolean;
  }) => {
    setPhase("loading");
    setError(null);
    try {
      const wbId = options.wordbookId || (await getDefaultWordbook()).id;
      const created = await apiFetch<HuluPlanSummary>("/hulu/plans", {
        method: "POST",
        body: JSON.stringify({
          wordbookId: wbId,
          examDate: options.examDate,
          targetRounds: options.targetRounds,
          pageSize: options.pageSize,
          suspendReview: options.suspendReview,
        }),
      });
      await enterPlan(created.id, readCache(created.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法加载冲刺计划");
      setPhase("error");
    }
  }, [enterPlan]);

  /** 词书选择器的选项：GET /wordbooks；不可用时回落默认词书。 */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await apiFetch<{ items: WordbookOption[] }>("/wordbooks");
        if (cancelled) return;
        const items = list.items ?? [];
        setWordbooks(items);
        setWordbookId((current) => current
          || items.find((wb) => wb.isDefault)?.id
          || items[0]?.id
          || "");
      } catch {
        try {
          const fallback = await getDefaultWordbook();
          if (cancelled) return;
          setWordbooks([{ id: fallback.id, name: fallback.name, isDefault: true }]);
          setWordbookId((current) => current || fallback.id);
        } catch {
          /* 两者都失败：bootstrap 时会给出可读错误 */
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * 挂载即尝试续上未完成的冲刺（刷新/重进后续上，R3）：
   * 扫前缀取最近一条未过期缓存 → 校验服务端 planId/roundNo → 续当前页。
   * 没有可续的缓存就停在 setup（让用户建计划）。
   */
  useEffect(() => {
    const cache = findLatestCache();
    if (!cache) return;
    let cancelled = false;
    setPhase("loading");
    void (async () => {
      try {
        if (!cancelled) await enterPlan(cache.planId, cache);
      } catch {
        // 计划不存在 / 网络失败：清掉死缓存，回 setup 让用户重新开始。
        if (!cancelled) {
          clearCache(cache.planId);
          setPhase("setup");
        }
      }
    })();
    return () => { cancelled = true; };
    // 只在挂载时尝试一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 翻开（单卡路径：纯本地，零请求）。 */
  const flip = (index: number) => {
    if (settled || study || flipped[index]) return;
    const next = { ...flipped, [index]: true };
    setFlipped(next);
    if (plan && round) persist({ planId: plan.id, roundNo: round.round_no, pageIndex, flipped: next, verdict });
  };

  /** 自认（单卡路径：纯本地，零请求）。 */
  const judge = (index: number, value: Verdict) => {
    if (settled || study) return;
    const next = { ...verdict, [index]: value };
    setVerdict(next);
    if (plan && round) persist({ planId: plan.id, roundNo: round.round_no, pageIndex, flipped, verdict: next });
  };

  const alive = page?.alive ?? 0;
  const passedCount = useMemo(
    () => Object.values(verdict).filter((value) => value === "pass").length,
    [verdict],
  );
  const judgedCount = Object.keys(verdict).length;
  /** 本页通过率按**存活词**算（与页结算的 total 同口径）。 */
  const gatePasses = plan !== null && huluGateDecision(passedCount, alive, plan.gate_ratio) === "pass";

  /** 进入第 n+1 轮：POST /rounds（幂等）→ 从新轮的 pages_passed 页开始。 */
  const startNextRound = useCallback(async () => {
    if (!plan) return;
    setPhase("loading");
    setError(null);
    try {
      const started = await apiFetch<HuluRoundRow>(`/hulu/plans/${plan.id}/rounds`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setRound(started);
      setElapsedSeconds(null);
      setBlocked(0);
      const completed = await loadPage(plan.id, started.round_no, started.pages_passed);
      if (!completed) setPhase("sprint");
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法开始下一轮");
      setPhase("error");
    }
  }, [plan, loadPage]);

  /** 放弃计划（active → abandoned）：同事务恢复挂起快照，之后刷新计划页。 */
  const abandonPlan = useCallback(async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await apiFetch(`/hulu/plans/${plan.id}/abandon`, { method: "POST", body: JSON.stringify({}) });
      clearCache(plan.id);
      await refreshPlan(plan.id);
      setPhase("plan");
    } catch (err) {
      setError(err instanceof Error ? err.message : "放弃计划失败");
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }, [plan, refreshPlan]);

  /** 页尾推进：过闸 → 结算 → 下一页；不过闸 → 整页清零、退学习态、**不发请求**。 */
  const goNext = useCallback(async () => {
    if (!plan || !round || !page) return;
    // 学习态下点「重新自认」：退出学习态、清本页自认（不入库、不发请求）。
    if (study) {
      setStudy(false);
      setVerdict({});
      setFlipped({});
      return;
    }
    if (settled) {
      // 回看已结算页：只读，不可改；末页则本轮已无页可走 → 收尾（幂等）。
      if (isLastPage) {
        setBusy(true);
        try {
          await finishRound(plan.id, round.round_no);
        } catch (err) {
          setError(err instanceof Error ? err.message : "轮次收尾失败");
          setPhase("error");
        } finally {
          setBusy(false);
        }
        return;
      }
      await loadPage(plan.id, round.round_no, pageIndex + 1);
      return;
    }

    // 闸门：读计划行的 gate_ratio 列值（不写死）；alive = 0 由 loadPage 直接结算。
    if (huluGateDecision(passedCount, alive, plan.gate_ratio) === "block") {
      setVerdict({});
      setFlipped({});
      setStudy(true);
      setBlocked((count) => count + 1);
      return; // 不发任何请求
    }

    setBusy(true);
    try {
      const settledRound = await apiFetch<HuluRoundRow>(
        `/hulu/plans/${plan.id}/rounds/${round.round_no}/pages`,
        { method: "POST", body: JSON.stringify({ pageIndex, passed: passedCount, total: alive }) },
      );
      setRound(settledRound);
      if (isLastPage) {
        await finishRound(plan.id, round.round_no);
        return;
      }
      await loadPage(plan.id, round.round_no, pageIndex + 1);
    } catch (err) {
      // D1（R11）：页内词集已变化（定格词被上架/下架）→ 手里的 total 过期了。
      // 自动重取本页 + 轻提示；**不落错误页**、不重复结算（重取后回到未自认态）。
      if (hasErrorCode(err, HULU_PAGE_ALIVE_MISMATCH)) {
        toast?.addToast("info", "本页词集已变化，已重新加载");
        try {
          await loadPage(plan.id, round.round_no, pageIndex);
        } catch (reloadErr) {
          setError(reloadErr instanceof Error ? reloadErr.message : "重新加载本页失败");
          setPhase("error");
        }
        return;
      }
      setError(err instanceof Error ? err.message : "页结算失败");
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }, [plan, round, page, study, settled, pageIndex, pages, passedCount, alive, isLastPage, loadPage, finishRound, toast]);

  /** 上一页（只读回看；未结算页不允许倒回，避免状态错乱）。 */
  const goPrev = () => {
    if (pageIndex === 0 || busy) return;
    setStudy(false);
    if (plan && round) void loadPage(plan.id, round.round_no, pageIndex - 1);
  };

  if (phase === "setup") {
    return (
      <div className="space-y-5" data-testid="hulu-setup">
        <Card className="space-y-5">
          <div className="flex items-center gap-3">
            <Sprout className="h-6 w-6 text-[var(--color-accent)]" />
            <div>
              <h2 className="text-lg font-semibold text-[var(--color-ink)]">葫芦冲刺</h2>
              <p className="text-sm text-[var(--color-ink-soft)]">
                整批词按页滚动，页级闸门过了才进下一页。只记轮次耗时，不写入复习数据。
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1 text-sm">
              <span className="text-[var(--color-ink-soft)]">词书</span>
              <select
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-glass)] px-3 py-2 text-[var(--color-ink)]"
                value={wordbookId}
                onChange={(event) => setWordbookId(event.target.value)}
                data-testid="hulu-wordbook"
              >
                {wordbooks.length === 0 && <option value={wordbookId}>默认词书</option>}
                {wordbooks.map((wb) => (
                  <option key={wb.id} value={wb.id}>
                    {wb.name}{wb.isDefault ? "（默认）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-[var(--color-ink-soft)]">考试日期</span>
              <input
                type="date"
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-glass)] px-3 py-2 text-[var(--color-ink)]"
                value={examDate}
                min={todayKey()}
                onChange={(event) => setExamDate(event.target.value)}
                data-testid="hulu-exam-date"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-[var(--color-ink-soft)]">目标轮数（2–8）</span>
              <input
                type="number"
                min={2}
                max={8}
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-glass)] px-3 py-2 text-[var(--color-ink)]"
                value={targetRounds}
                onChange={(event) => setTargetRounds(Number(event.target.value))}
                data-testid="hulu-target-rounds"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-[var(--color-ink-soft)]">每页词数（5–50）</span>
              <input
                type="number"
                min={5}
                max={50}
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-glass)] px-3 py-2 text-[var(--color-ink)]"
                value={pageSize}
                onChange={(event) => setPageSize(Number(event.target.value))}
                data-testid="hulu-page-size"
              />
            </label>
          </div>

          <label className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-glass)] p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4"
              checked={suspendReview}
              onChange={(event) => setSuspendReview(event.target.checked)}
              data-testid="hulu-suspend-toggle"
            />
            <span className="space-y-1">
              <span className="block text-[var(--color-ink)]">冲刺期间把这批词移出到期队列</span>
              <span className="block text-xs text-[var(--color-ink-soft)]" data-testid="hulu-suspend-hint">
                这批词会暂时退出到期队列，计划结束或放弃时自动回来。
                开关只能在创建时设定，中途不能切换（要换就放弃重建）。
              </span>
            </span>
          </label>

          <div className="flex items-center gap-2">
            <Button
              disabled={!examDate || !wordbookId}
              onClick={() => void bootstrap({ examDate, targetRounds, pageSize, wordbookId, suspendReview })}
              data-testid="hulu-start"
            >
              开始冲刺
            </Button>
            <Button variant="ghost" onClick={onBack}>退出</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div data-testid="hulu-loading">
        <Card>
          <p className="text-center text-sm text-[var(--color-ink-soft)]">正在准备冲刺计划…</p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div data-testid="hulu-error">
        <Card>
          <EmptyState
            title="葫芦冲刺无法继续"
            description={error ?? undefined}
            action={<Button onClick={onBack}><RotateCcw className="h-4 w-4" />返回</Button>}
          />
        </Card>
      </div>
    );
  }

  /** 计划概况卡（收尾页与计划页共用）：状态 / 挂起 / 考试日提示 / 曲线 / 放弃。 */
  const planOverview = plan && (
    <>
      {plan.status === "active" && examDatePassed(plan.exam_date) && (
        <div data-testid="hulu-exam-passed">
          <Card className="border-[var(--color-pill-warm-border)]">
            <p className="text-sm text-[var(--color-ink)]">
              <strong>考试日已过</strong>（{plan.exam_date}），建议放弃以恢复到期队列。
            </p>
          </Card>
        </div>
      )}
      <div data-testid="hulu-plan-status">
        <Card className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={plan.status === "active" ? "accent" : "warm"}>
              {plan.status === "active" ? "进行中" : plan.status === "completed" ? "已完成" : "已放弃"}
            </Badge>
            <Badge>{plan.word_count} 词 · 每页 {plan.page_size} · 共 {plan.target_rounds} 轮</Badge>
            <span data-testid="hulu-suspend-state">
              <Badge tone={plan.suspend_review ? "warm" : "accent"}>
                {plan.suspend_review
                  ? `挂起中：${plan.suspended_count} 词暂不在到期队列`
                  : "未启用挂起"}
              </Badge>
            </span>
          </div>
          <p className="text-xs text-[var(--color-ink-soft)]">
            考试日 {plan.exam_date}
            {plan.suspend_review && "。这批词会在计划结束或放弃时自动回到到期队列。"}
          </p>
        </Card>
      </div>
      <HuluSpeedCurve
        rounds={rounds}
        targetRounds={plan.target_rounds}
        examDate={plan.exam_date}
      />
    </>
  );

  const abandonButton = plan?.status === "active" && (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={() => void abandonPlan()}
      data-testid="hulu-abandon"
    >
      放弃计划
    </Button>
  );

  if (phase === "finished") {
    return (
      <div className="space-y-4" data-testid="hulu-finished">
        <Card className="space-y-4">
          <div className="flex items-center gap-3">
            <Check className="h-6 w-6 text-[var(--color-accent)]" />
            <div>
              <h2 className="text-lg font-semibold text-[var(--color-ink)]">
                第 {round?.round_no ?? 1} / {plan?.target_rounds ?? 1} 轮走完
              </h2>
              <p className="text-sm text-[var(--color-ink-soft)]" data-testid="hulu-elapsed">
                本轮耗时 {formatSeconds(elapsedSeconds ?? 0)}
              </p>
            </div>
          </div>
          <p className="text-xs text-[var(--color-ink-soft)]">
            耗时是墙钟时间（中断不切开），是熟练度的代理指标、不是掌握证明。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {!isPlanComplete && (
              <Button onClick={() => void startNextRound()} data-testid="hulu-next-round">
                进入第 {(round?.round_no ?? 0) + 1} 轮
              </Button>
            )}
            {isPlanComplete && (
              <span data-testid="hulu-plan-complete">
                <Badge tone="accent">计划已完成，这批词已回到正常复习</Badge>
              </span>
            )}
            {abandonButton}
            <Button variant="ghost" onClick={onBack}>返回</Button>
          </div>
        </Card>
        {planOverview}
      </div>
    );
  }

  if (phase === "plan") {
    return (
      <div className="space-y-4" data-testid="hulu-plan">
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold text-[var(--color-ink)]">冲刺计划</h2>
          <p className="text-sm text-[var(--color-ink-soft)]" data-testid="hulu-plan-message">
            {plan?.status === "completed" ? "该冲刺计划已完成。" : "该冲刺计划已放弃。"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {abandonButton}
            <Button variant="ghost" onClick={onBack}>返回</Button>
          </div>
        </Card>
        {planOverview}
      </div>
    );
  }

  const progressText = `第 ${pageIndex + 1} / ${pages} 页 · 第 ${round?.round_no ?? 1} / ${plan?.target_rounds ?? 1} 轮`;

  return (
    <div className="space-y-4" data-testid="hulu-sprint">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="hulu-progress"><Badge tone="accent">{progressText}</Badge></span>
          <span data-testid="hulu-rate">
            <Badge tone={gatePasses ? "accent" : "warm"}>
              本页通过 {passedCount}/{alive} · {alive > 0 ? Math.round((passedCount / alive) * 100) : 0}%
            </Badge>
          </span>
          <Badge>闸门 {Math.round((plan?.gate_ratio ?? 0) * 100)}%</Badge>
          {plan?.suspend_review && <Badge tone="warm">挂起中</Badge>}
          {settled && <span data-testid="hulu-settled"><Badge tone="warm">此页已结算（只读）</Badge></span>}
          {blocked > 0 && !settled && <Badge tone="warm">本页已被拦 {blocked} 次</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={pageIndex === 0 || busy} onClick={goPrev}>
            <ArrowLeft className="h-4 w-4" />上一页
          </Button>
          <Button variant="ghost" size="sm" onClick={onBack}>退出</Button>
        </div>
      </div>

      {study && (
        <div data-testid="hulu-study-banner">
          <Card className="border-[var(--color-pill-warm-border)]">
            <p className="text-sm text-[var(--color-ink)]">
              <strong>本页没到闸门。</strong>
              已退回学习态：答案展开，这一次失败不入库，也不能进下一页。看完再重新自认。
            </p>
          </Card>
        </div>
      )}
      {settled && (
        <Card>
          <p className="text-sm text-[var(--color-ink-soft)]">回看已过的页。自认已经结算，不能改。</p>
        </Card>
      )}

      <div className="space-y-3">
        {(page?.items ?? []).map((word, index) => {
          const revealed = study || settled || Boolean(flipped[index]);
          const current = settled ? undefined : verdict[index];
          return (
            <div key={word.id} data-testid={`hulu-card-${index}`}>
              <Card className="space-y-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-base font-semibold text-[var(--color-ink)]">{word.lemma || word.title}</span>
                  {word.ipa && <span className="text-xs text-[var(--color-ink-soft)]">{word.ipa}</span>}
                  {word.pos && <span className="text-xs text-[var(--color-ink-soft)]">{word.pos}</span>}
                  {word.cefr && <Badge tone="warm">CEFR {word.cefr}</Badge>}
                </div>

                {revealed ? (
                  <HuluCardFace word={word} index={index} />
                ) : (
                  <p className="text-xs text-[var(--color-ink-soft)]">
                    先回忆这个词。想完再翻开，翻开之前不算通过。
                  </p>
                )}

                <div className="flex items-center gap-2">
                  {!revealed && !settled && (
                    <Button size="sm" variant="secondary" onClick={() => flip(index)} data-testid={`hulu-flip-${index}`}>
                      <BookOpen className="h-4 w-4" />翻开核对
                    </Button>
                  )}
                  {revealed && !study && !settled && (
                    <>
                      <Button
                        size="sm"
                        variant={current === "pass" ? "primary" : "secondary"}
                        onClick={() => judge(index, "pass")}
                        data-testid={`hulu-pass-${index}`}
                      >
                        通过
                      </Button>
                      <Button
                        size="sm"
                        variant={current === "miss" ? "danger" : "secondary"}
                        onClick={() => judge(index, "miss")}
                        data-testid={`hulu-miss-${index}`}
                      >
                        <X className="h-4 w-4" />没通过
                      </Button>
                    </>
                  )}
                  {settled && (
                    <span className="text-xs text-[var(--color-ink-soft)]">此页已结算</span>
                  )}
                </div>
              </Card>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--color-ink-soft)]">
          已自认 {judgedCount}/{alive}（未自认的按没通过计）
        </p>
        <Button
          disabled={busy}
          onClick={() => void goNext()}
          data-testid="hulu-next"
        >
          {study ? "重新自认" : isLastPage ? "完成本轮" : "下一页"}
        </Button>
      </div>
    </div>
  );
}
