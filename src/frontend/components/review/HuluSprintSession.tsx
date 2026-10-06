/**
 * HuluSprintSession —— 葫芦冲刺会话（ADR-0041，P1）。
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
 *  3. **闸门读计划行的 `gate_ratio` 列值**，不写死 0.8；判定用前后端共用的纯函数
 *     `huluGateDecision`（单一真口径）。不达闸 → 整页自认清零、退回学习态、
 *     **不发请求**。
 *
 * 会话恢复（R3）：`localStorage["vocab:hulu:sprint:<planId>"]` + 24h TTL，
 * 恢复时校验 planId / roundNo 与服务端一致，不一致即丢弃、从 `pages_passed` 页重来。
 * 未结算页本来就没入库，超时丢失的代价只是重走当前页。
 *
 * 注意 `Card` / `Badge` 不透传额外 props，故所有 `data-testid` 都挂在原生元素上。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, Check, RotateCcw, Sprout, X } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { apiFetch } from "@/frontend/api/client";
import { getDefaultWordbook } from "@/frontend/api/wordbooks";
import {
  huluGateDecision,
  type HuluPagePayload,
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

type Phase = "setup" | "loading" | "sprint" | "finished" | "error";

export function HuluSprintSession({ onBack }: { onBack: () => void }) {
  const [phase, setPhase] = useState<Phase>("setup");
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<HuluPlanSummary | null>(null);
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
  const [examDate, setExamDate] = useState(todayKey);
  const [targetRounds, setTargetRounds] = useState(4);
  const [pageSize, setPageSize] = useState(20);

  /** 当前页是否已结算（游标之内）→ 只读回看，不可改。 */
  const settled = round !== null && pageIndex < round.pages_passed;
  const pages = page?.pages ?? 0;
  const isLastPage = pages > 0 && pageIndex >= pages - 1;

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

  /**
   * 取一页载荷并**跳过 alive = 0 的页**（整页定格词已删 → 服务端自动通过）。
   *
   * `alive = 0` 的页不发渲染、直接结算 `{ pageIndex, passed: 0, total: 0 }`，
   * 然后继续往后走 —— 直到遇到有存活词的页，或走到末页。
   */
  const loadPage = useCallback(async (planId: string, roundNo: number, index: number): Promise<void> => {
    let cursor = Math.max(0, index);
    for (;;) {
      const payload = await apiFetch<HuluPagePayload>(`/hulu/plans/${planId}/pages/${cursor}`);
      if (payload.alive > 0) {
        setPage(payload);
        setPageIndex(cursor);
        setFlipped({});
        setVerdict({});
        setStudy(false);
        return;
      }
      // 整页删空：直接结算（huluGateDecision(0, 0, gate) = pass，服务端同口径）
      await apiFetch(`/hulu/plans/${planId}/rounds/${roundNo}/pages`, {
        method: "POST",
        body: JSON.stringify({ pageIndex: cursor, passed: 0, total: 0 }),
      });
      if (cursor >= payload.pages - 1) {
        setPage(payload);
        setPageIndex(cursor);
        setFlipped({});
        setVerdict({});
        setStudy(false);
        return;
      }
      cursor += 1;
    }
  }, []);

  /**
   * 进入一个计划的冲刺：轮次（幂等）+ 会话恢复（R3）+ 取当前页。
   *
   * `cache` 只在从缓存续上时传；planId / roundNo 与服务端不一致即丢弃缓存。
   */
  const enterPlan = useCallback(async (planId: string, cache: PersistedHuluSession | null) => {
    const detail = await apiFetch<HuluPlanWithRounds>(`/hulu/plans/${planId}`);
    setPlan(detail.plan);

    if (detail.plan.status !== "active") {
      // 计划已结束：清缓存，展示状态（不静默重建）。
      clearCache(planId);
      setError(detail.plan.status === "completed" ? "该冲刺计划已完成" : "该冲刺计划已放弃");
      setPhase("error");
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

    await loadPage(planId, started.round_no, startIndex);
    if (resume && startIndex === resume.pageIndex) {
      setFlipped(Object.fromEntries(resume.flipped.map((key) => [key, true])));
      setVerdict(Object.fromEntries(
        Object.entries(resume.verdict).map(([key, value]) => [Number(key), value]),
      ));
    }
    setPhase("sprint");
  }, [loadPage]);

  /** 创建（或取回既有）计划 → 进入冲刺。 */
  const bootstrap = useCallback(async (options: { examDate: string; targetRounds: number; pageSize: number }) => {
    setPhase("loading");
    setError(null);
    try {
      const wordbook = await getDefaultWordbook();
      const created = await apiFetch<HuluPlanSummary>("/hulu/plans", {
        method: "POST",
        body: JSON.stringify({
          wordbookId: wordbook.id,
          examDate: options.examDate,
          targetRounds: options.targetRounds,
          pageSize: options.pageSize,
        }),
      });
      await enterPlan(created.id, readCache(created.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法加载冲刺计划");
      setPhase("error");
    }
  }, [enterPlan]);

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

  /** 轮次收尾：POST finish → 展示本轮耗时。 */
  const finishRound = useCallback(async (planId: string, roundNo: number) => {
    const finished = await apiFetch<HuluRoundRow>(`/hulu/plans/${planId}/rounds/${roundNo}/finish`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    clearCache(planId);
    setRound(finished);
    setElapsedSeconds(finished.elapsed_seconds ?? 0);
    setPhase("finished");
  }, []);

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
      // 回看已结算页：只读，不可改；只能往后翻。
      if (pageIndex < pages - 1) await loadPage(plan.id, round.round_no, pageIndex + 1);
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
      setError(err instanceof Error ? err.message : "页结算失败");
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }, [plan, round, page, study, settled, pageIndex, pages, passedCount, alive, isLastPage, loadPage, finishRound]);

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

          <div className="grid gap-4 sm:grid-cols-3">
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

          <div className="flex items-center gap-2">
            <Button
              disabled={!examDate}
              onClick={() => void bootstrap({ examDate, targetRounds, pageSize })}
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
          <Button variant="secondary" onClick={onBack}>返回</Button>
        </Card>
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
                </div>

                {revealed ? (
                  <div className="space-y-1" data-testid={`hulu-answer-${index}`}>
                    <p className="text-sm text-[var(--color-ink)]">{word.short_definition ?? "（无释义）"}</p>
                    {word.mnemonic_text && (
                      <p className="text-xs text-[var(--color-ink-soft)]">助记 · {word.mnemonic_text}</p>
                    )}
                  </div>
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
          disabled={busy || settled}
          onClick={() => void goNext()}
          data-testid="hulu-next"
        >
          {study ? "重新自认" : isLastPage ? "完成本轮" : "下一页"}
        </Button>
      </div>
    </div>
  );
}
