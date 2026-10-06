/**
 * HuluSpeedCurve —— 缩时曲线（ADR-0041，完备设计 §九，P2；R13 修订）。
 *
 * 唯一数据源：`GET /api/hulu/plans/:id` 的 `rounds`（`hulu_rounds` 行）。
 * 只画 `kind ∈ ('recall','legacy')` 的**已收尾**轮、按 `round_no` 升序。**禁止**
 * 前端推算耗时、禁止用词数/通过率反推 —— 每根柱子的高度只来自该行的
 * `elapsed_seconds`，柱子上带 `data-round-id` / `data-elapsed-seconds` 供「可回溯」断言。
 *
 * R13 口径（只比**可比较轮**）：
 *  - **曝光轮不进图**（其耗时在计划页单列「首次曝光耗时」，注明不计入对比）；
 *  - **基准轮** = 第一条 `kind = 'recall'` 的已收尾轮（legacy 轮**永不**当基准）；
 *    全 legacy 序列维持旧画法（首个已收尾轮为基准，老计划口径不回改）；
 *  - **可比性** = `word_set_fingerprint` 一致（`huluSameWordSet` 纯函数）；不一致的轮
 *    照画柱、降幅位标「词集已变化，不与基准比较」。
 *    **词数相等不是等价判据**（定格词数恒不变、不随删词浮动，两轮同数可能是两批
 *    不同的词）—— 唯一判据是指纹。本组件因此不读计划/轮次的词数列。
 *
 * **必须同时展示免责声明**（完备设计 §九 两条 + R13 追加第三条，缺一不可）：
 *  ① 缩时是熟练度的**代理指标**，不证明掌握（一手口径：背完可能仍记不住，
 *     但天数在减少）；
 *  ② 中途长中断会按**墙钟**计入当轮，使该轮虚高（R5：中断不切开）；
 *  ③ 只有「已结算词集一致」的轮次才比较耗时；词书增删导致的词集漂移会让对应轮
 *     不参与降幅计算。
 *
 * 日常复习的「变强信号」另行立项，不共图（§九 末条）。
 */

import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { huluSameWordSet, type HuluRoundRow } from "@/domain/hulu-sprint";

const MS_PER_DAY = 86400000;

/** 秒 → 「n 分 ss 秒」（超过一小时改「n 时 mm 分」，柱下标签用）。 */
function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)} 时 ${String(minutes % 60).padStart(2, "0")} 分`;
  }
  return `${minutes} 分 ${String(total % 60).padStart(2, "0")} 秒`;
}

/**
 * 两个 YYYY-MM-DD 之间的日历日差：用各自的 UTC 零点求差，
 * 避开夏令时/时区偏移（与服务层 `daysBetween` 同口径）。
 */
function daysBetweenKeys(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00Z`);
  const to = Date.parse(`${toKey}T00:00:00Z`);
  return Math.round((to - from) / MS_PER_DAY);
}

/** 本地日历日的日期键（YYYY-MM-DD）。 */
function localTodayKey(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface HuluSpeedCurveProps {
  /** 计划详情的轮次列表（hulu_rounds 行）—— 唯一数据源。 */
  rounds: HuluRoundRow[];
  /** 目标轮数（剩余轮数 = 目标 − 已收尾轮数）。 */
  targetRounds: number;
  /** 考试日（YYYY-MM-DD）。 */
  examDate: string;
  /** 「今天」的日期键；缺省取本地日历日（测试注入固定值）。 */
  today?: string;
}

export function HuluSpeedCurve({ rounds, targetRounds, examDate, today }: HuluSpeedCurveProps) {
  // 只画已收尾的**复习轮**（R13）：曝光轮不进图（它另有「首次曝光耗时」单行）。
  const finishedRounds = rounds
    .filter((round) => round.ended_at !== null && round.elapsed_seconds !== null && round.kind !== "exposure")
    .sort((a, b) => a.round_no - b.round_no);

  // 基准轮（R13）：第一条 kind='recall' 的已收尾轮；全 legacy 序列维持旧画法
  // （首个已收尾轮为基准）。legacy 轮**永不**当基准。
  const firstRecall = finishedRounds.find((round) => round.kind === "recall");
  const baseline = firstRecall ?? finishedRounds[0] ?? null;
  const baselineSeconds = baseline?.elapsed_seconds ?? null;
  const maxSeconds = finishedRounds.reduce(
    (max, round) => Math.max(max, round.elapsed_seconds ?? 0),
    0,
  );
  const remainingRounds = Math.max(0, targetRounds - finishedRounds.length);
  const daysLeft = daysBetweenKeys(today ?? localTodayKey(), examDate);

  return (
    <div data-testid="hulu-speed-curve">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-[var(--color-ink)]">缩时曲线</h3>
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="hulu-curve-remaining">
              <Badge>剩余 {remainingRounds} 轮</Badge>
            </span>
            <span data-testid="hulu-curve-days-left">
              <Badge tone={daysLeft <= 0 ? "warm" : "accent"}>
                {daysLeft > 0 ? `距考试 ${daysLeft} 天` : daysLeft === 0 ? "考试日就是今天" : "考试日已过"}
              </Badge>
            </span>
          </div>
        </div>

        {finishedRounds.length === 0 ? (
          <p className="text-xs text-[var(--color-ink-soft)]" data-testid="hulu-curve-empty">
            还没有已收尾的轮次。走完一轮后，这里会画出这一轮的墙钟耗时。
          </p>
        ) : (
          <div className="flex items-end gap-3" data-testid="hulu-curve-bars">
            {finishedRounds.map((round) => {
              const seconds = round.elapsed_seconds ?? 0;
              // 柱高按最长一轮归一；最短也留 6% 让柱子可见（只影响画法，不改数字）。
              const heightPct = maxSeconds > 0
                ? Math.max(6, Math.round((seconds / maxSeconds) * 100))
                : 6;
              const isBaseline = baseline !== null && round.id === baseline.id;
              // 可比性判据（R13）：指纹一致才比降幅。baseline 自己恒是基准。
              const comparable = isBaseline
                || (baseline !== null && huluSameWordSet(round.word_set_fingerprint, baseline.word_set_fingerprint));
              const dropPct = baselineSeconds !== null && baselineSeconds > 0
                ? Math.round(((baselineSeconds - seconds) / baselineSeconds) * 100)
                : 0;
              return (
                <div
                  key={round.id}
                  className="flex flex-1 flex-col items-center gap-1"
                  data-testid={`hulu-curve-bar-${round.round_no}`}
                  data-round-id={round.id}
                  data-round-no={round.round_no}
                  data-elapsed-seconds={seconds}
                  data-comparable={comparable ? "true" : "false"}
                >
                  <div className="flex h-28 w-full items-end">
                    <div
                      className="w-full rounded-t bg-[var(--color-accent)]"
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                  <span className="text-xs text-[var(--color-ink)]">
                    第 {round.round_no} 轮
                  </span>
                  <span className="text-xs text-[var(--color-ink-soft)]">
                    {formatElapsed(seconds)}
                  </span>
                  <span className="text-xs text-[var(--color-ink-soft)]" data-testid={`hulu-curve-drop-${round.round_no}`}>
                    {isBaseline
                      ? "基准轮"
                      : !comparable
                        ? "词集已变化，不与基准比较"
                        : dropPct > 0
                          ? `比基准轮快 ${dropPct}%`
                          : dropPct === 0
                            ? "与基准轮持平"
                            : `比基准轮慢 ${-dropPct}%`}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div
          className="space-y-1 border-t border-[var(--color-border)] pt-2"
          data-testid="hulu-curve-disclaimer"
        >
          <p className="text-xs text-[var(--color-ink-soft)]">
            缩时是<strong>熟练度的代理指标</strong>，不证明掌握：背完可能仍然记不住，
            但走完一轮需要的天数在减少。
          </p>
          <p className="text-xs text-[var(--color-ink-soft)]">
            耗时按<strong>墙钟</strong>计（中断不切开）：中途长时间离开会让这一轮的耗时虚高。
          </p>
          <p className="text-xs text-[var(--color-ink-soft)]">
            只有<strong>已结算词集一致</strong>的轮次才比较耗时；词书增删导致的词集漂移会让
            对应轮不参与降幅计算。
          </p>
        </div>
      </Card>
    </div>
  );
}
