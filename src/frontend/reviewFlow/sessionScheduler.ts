/**
 * sessionScheduler —— 阶梯会话三轮编排纯函数（ADR-0036，演示页 startSession 逐条落地）。
 *
 * 拍板⑥：三轮制轮内交替（再认→巩固→产出）：
 * - pass1 再认轮：R1/R2 卡 + 新词编码卡（R3 无卡面不进 pass1/pass2）；
 * - pass2 巩固轮：复习段反序（拉开同词间距）+ 新词 follow；
 * - pass3 产出轮：R3 在前（本档即测量）+ 其余反序 + 新词穿插 weave；
 * - 轮内新旧交替 weave(revs, news)；同词两阶段不背靠背（跨 pass 交界 + pass 内）。
 *
 * 纯函数模块：无 DB 访问、无副作用、无定时器。
 */

import type { ReviewCard, Rating } from "@/frontend/hooks/useReview";
import type { DictationTier, LadderVisit, LadderStage } from "./stageMap";
import { VISIT_TEMPLATE } from "./stageMap";

/** 队列卡在会话编排中的视图（queue 下标 + 起步档 + 是否新词）。 */
export interface SchedulerCardView {
  qi: number;
  progressId: string;
  /** 起步档（queue 直载 ladderRung 缺失时按 state 派生：new→R0 视为 R1 模板排队；存量→1）。 */
  rung: number;
  isNew: boolean;
}

/** 演示页 weave：轮内新旧穿插（revs 逐个 → news 逐个 → 循环至耗尽）。 */
export function weave<T>(revs: T[], news: T[]): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < revs.length || j < news.length) {
    if (i < revs.length) out.push(revs[i++]);
    if (j < news.length) out.push(news[j++]);
  }
  return out;
}

/**
 * no-back-to-back-same-word（拍板⑥规则）：同 progressId 的节点不得相邻。
 * 交换修复式：从左向右扫描，遇相邻同词即与后方**最近的可行异词节点**交换。
 *
 * 2026-10-11 审查（S3）修正：旧实现的可行条件只检查了交换位置的**后侧**
 * （`out[j+1] !== out[i].progressId`），漏检**前侧**（`out[j] !== out[i-1]`），
 * 于是「明明存在合法解」也判成退化放弃。现改为检查换后**左右两侧**。
 *
 * @param groupKey 分组键（阶梯传 `pass`）：**交换候选严格限制在同一轮内**。
 *   这是硬约束，不是优化 —— 跨轮交换会把产出轮的词换到巩固轮之前，等于让词
 *   "先默写再跟写"，直接破坏三轮的语义递进（演示实测：两词会话被换成一
 *   card → card → dictation → dictation → follow → follow）。
 *   跨轮背靠背（pass1 尾与 pass2 头同词）因此**保持原序**：段内没有可换的异词时，
 *   任何修复都要靠改变轮次顺序，代价大于收益。
 */
export function enforceNoBackToBack<T extends { progressId: string }>(
  items: T[],
  groupKey?: (item: T) => string,
): T[] {
  const out = [...items];
  const conflictsAt = (idx: number) => idx > 0 && out[idx].progressId === out[idx - 1].progressId;
  /** 同组区间的右开端点（无分组时即数组末尾）。 */
  const groupEnd = (idx: number): number => {
    if (!groupKey) return out.length;
    const g = groupKey(out[idx]);
    let end = idx + 1;
    while (end < out.length && groupKey(out[end]) === g) end++;
    return end;
  };
  let guard = out.length * out.length * 2 + 8;
  let i = 1;
  while (i < out.length && guard-- > 0) {
    if (!conflictsAt(i)) {
      i++;
      continue;
    }
    const bad = out[i].progressId;
    const end = groupEnd(i);
    let swapped = false;
    for (let j = i + 1; j < end && !swapped; j++) {
      if (out[j].progressId === bad) continue;
      const leftOk = out[j].progressId !== out[i - 1].progressId;
      const rightOk = j + 1 >= out.length || out[j + 1].progressId !== bad;
      if (leftOk && rightOk) {
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
        swapped = true;
      }
    }
    // 交换后原位重查（可能引入新冲突）；无可行解则前进一格（退化场景，保持原序）
    if (!swapped) i++;
  }
  return out;
}

/** 由队列卡派生起步档：queue 直载 ladderRung 优先；缺失时 new→1（R0 按 R1 模板排队）、存量→1。 */
function rungOf(card: ReviewCard): number {
  if (typeof card.ladderRung === "number" && card.ladderRung >= 1 && card.ladderRung <= 3) {
    return card.ladderRung;
  }
  return 1;
}

function stageForRung(rung: number, pass: 1 | 2 | 3): LadderStage {
  if (pass === 1) return rung === 2 ? "card-no-hints" : "card";
  if (pass === 2) return "follow";
  return "dictation";
}

/**
 * buildLadderSession(queue) → 三轮队列（演示页 startSession 逐条落地）。
 * - 复习段按 rung 降序（R3→R1）；r1r2 = rung<3；r3s = rung≥3；
 * - pass1: weave(r1r2, news) → card / card-encode（新词）/ card-no-hints（R2）；
 * - pass2: weave(r1r2 反序, news) → follow；
 * - pass3: weave(r3s.concat(r1r2 反序), news) → dictation；
 * - 全队列 enforce no-back-to-back-same-word。
 */
export function buildLadderSession(queue: ReviewCard[]): LadderVisit[] {
  if (queue.length === 0) return [];

  const views: SchedulerCardView[] = queue.map((card, qi) => ({
    qi,
    progressId: card.progressId,
    rung: rungOf(card),
    isNew: card.state === "new",
  }));

  const revs = views
    .filter((v) => !v.isNew)
    .sort((a, b) => b.rung - a.rung); // R3 → R1
  const news = views.filter((v) => v.isNew);
  const r1r2 = revs.filter((v) => v.rung < 3);
  const r3s = revs.filter((v) => v.rung >= 3);

  const visit = (v: SchedulerCardView, pass: 1 | 2 | 3): LadderVisit => ({
    qi: v.qi,
    progressId: v.progressId,
    pass,
    stage: v.isNew && pass === 1 ? "card-encode" : stageForRung(v.rung, pass),
  });

  const pass1 = weave(r1r2, news).map((v) => visit(v, 1));
  const pass2 = weave([...r1r2].reverse(), news).map((v) => visit(v, 2));
  const pass3 = weave([...r3s, ...[...r1r2].reverse()], news).map((v) => visit(v, 3));

  // 分组键 = 轮次：交换只在同一轮内进行（跨轮交换会破坏「再认→巩固→产出」的递进顺序）
  return enforceNoBackToBack([...pass1, ...pass2, ...pass3], (v) => String(v.pass));
}

/** 结算页逐词行（演示页结算表：词/卡面/默写/最终/S→/起步档/门 由 ReviewPage 组装渲染）。 */
export interface LadderSettlementRow {
  progressId: string;
  lemma: string;
  cardRating: Rating | null;
  tier: DictationTier;
  wrongTimes: number | null;
  dictMap: Rating | null;
  finalRating: Rating;
  /** 首评词（新词）标记：结算表显示「新词首学 → 首评 X · 起步档 R1」。 */
  isFirstRating: boolean;
}
