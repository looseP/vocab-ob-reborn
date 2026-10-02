/**
 * 卷面选区 → 就近题目绑定（纯函数引擎，2026-10-02）。
 *
 * ## 为什么要有它
 *
 * 划词捕获原先只记鼠标坐标，不知道选区落在哪个空、哪一段 —— 于是「建原文分析条目」
 * 弹出一个 20 项的长列表让用户人肉找题。真实做题场景里，「我在第 3 空这句上划线」
 * 是**已知事实**（空格就在选区的字符区间里），不该让用户复述一遍。
 *
 * ## 为什么必须是纯函数
 *
 * 判定依赖两个坐标：选区的 content UTF-16 区间 与 空位的 UTF-16 区间 —— 两者同一
 * 坐标系（见 `examPassageSpans.ts` 的契约）。距离/包围判定 100% 可离线计算，不该
 * 混在 JSX 里靠 DOM 度量。所以这里零 DOM、零 React、零 IO，单测毫秒级覆盖。
 *
 * ## 判定优先级（先证后猜）
 *
 * 1. `enclosed_blank`（high）—— 选区**完整包住**某空位：这是唯一的**证据级**判定，
 *    用户划的就是那个空的上下文。
 * 2. `nearest_blank`（medium）—— 选区内无空位：按字符中点距离取最近空位。是**推断**，
 *    故置信度降一档，UI 必须让用户可改（不能默认替代用户意志）。
 * 3. `paragraph_aligned`（medium）—— 整段没有空位（阅读选择题的段落）：按选区中点
 *    落在哪一段判定。同样是推断。
 *
 * 全部候选按距离升序排出 `sortedCandidates`（首选恒在第 1 位），UI 直接照序渲染即可，
 * 不需要在前端再排一次 —— 排序规则只有这一处。
 */

/** 题目引用（stem 用于候选列表展示；ordinal 仅在缺 displayNo 时兜底）。 */
export interface ProximityQuestionRef {
  id: string;
  ordinal: number;
  stem: string;
}

/** 空位锚点：content UTF-16 区间 + 它归属的题。 */
export interface ProximityBlankAnchor {
  blankNo: number;
  start: number;
  end: number;
  questionId: string;
}

/** 段落锚点：无空位卷（阅读理解）的兜底绑定依据。 */
export interface ProximityParagraphAnchor {
  paragraphIndex: number;
  start: number;
  end: number;
  questionId: string;
}

export interface ProximityCandidate {
  questionId: string;
  displayNo: number;
  stem: string;
}

export type ProximityReason = "enclosed_blank" | "nearest_blank" | "paragraph_aligned";

export interface ProximityMatch {
  targetQuestionId: string;
  displayNo: number;
  stem: string;
  reason: ProximityReason;
  /** `high` 只给证据级判定（选区真的包住了空位）；推断一律 `medium`。 */
  confidence: "high" | "medium";
  /** 按距离升序；首选题目恒为第 1 位。 */
  sortedCandidates: ProximityCandidate[];
}

export interface ResolveProximityInput {
  selectionStart: number;
  selectionEnd: number;
  blanks?: readonly ProximityBlankAnchor[];
  questions: readonly ProximityQuestionRef[];
  /**
   * 展示题号（`questionDisplayNo`）。**它是权威**：新题型题的展示号是 `ordinal + 41`，
   * 不是 `ordinal + 1`，只有卷面自己算得对。缺省时才退回 `ordinal + 1`。
   */
  questionDisplayNo?: ReadonlyMap<string, number>;
  paragraphAnchors?: readonly ProximityParagraphAnchor[];
}

interface ScoredCandidate {
  candidate: ProximityCandidate;
  distance: number;
  /** 同距离时的稳定次序（空位起点 / 段序），保证结果与输入顺序无关。 */
  order: number;
  enclosed: boolean;
}

function midOf(start: number, end: number): number {
  return (start + end) / 2;
}

/**
 * 一题只留一条候选：同 id 再次出现时若更近（或同距但更靠前）就**替换**而不是并存。
 * 用 Map 而不是数组 + 去重，是因为「并存再 filter」写下标时会漏掉旧条目 —— 那样
 * 候选列表里会出现两道同名题，看起来像 bug。
 */
function offer(map: Map<string, ScoredCandidate>, next: ScoredCandidate): void {
  const current = map.get(next.candidate.questionId);
  if (!current) {
    map.set(next.candidate.questionId, next);
    return;
  }
  if (next.distance < current.distance || (next.distance === current.distance && next.order < current.order)) {
    map.set(next.candidate.questionId, next);
  }
}

/** 距离升序 → 同距按阅读序 → 同序按 id（全序，结果与输入顺序无关）。 */
function rank(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.order !== b.order) return a.order - b.order;
  return a.candidate.questionId < b.candidate.questionId ? -1 : 1;
}

/**
 * 解析选区应当绑定到哪道题。无任何可用依据时返回 `null`（调用方回退到「全部候选」
 * 的旧交互，而不是硬塞一个猜测）。
 */
export function resolveProximityQuestion(input: ResolveProximityInput): ProximityMatch | null {
  const { selectionStart, selectionEnd, questions } = input;
  if (questions.length === 0) return null;
  // 退化选区（空选 / 反向选 / 非有限值）不猜。
  if (!Number.isFinite(selectionStart) || !Number.isFinite(selectionEnd)) return null;
  if (selectionEnd <= selectionStart) return null;

  const byId = new Map(questions.map((question) => [question.id, question]));
  const displayNoOf = (question: ProximityQuestionRef): number =>
    input.questionDisplayNo?.get(question.id) ?? question.ordinal + 1;
  const selectionMid = midOf(selectionStart, selectionEnd);

  // ── 一级/二级：空位判定 ──
  const byBlank = new Map<string, ScoredCandidate>();
  for (const blank of input.blanks ?? []) {
    // 卷内已不存在的题（被裁掉的快照题）不给候选 —— 绑上去也点不动。
    const question = byId.get(blank.questionId);
    if (!question) continue;
    const enclosed = blank.start >= selectionStart && blank.end <= selectionEnd;
    offer(byBlank, {
      candidate: { questionId: blank.questionId, displayNo: displayNoOf(question), stem: question.stem },
      // 被选区完整包住 = 距离视为 0：它就在选区里，比任何「旁边」都更该赢。
      distance: enclosed ? 0 : Math.abs(midOf(blank.start, blank.end) - selectionMid),
      order: blank.start,
      enclosed,
    });
  }

  const scored = [...byBlank.values()].sort(rank);
  if (scored.length > 0) {
    const target = scored[0]!;
    return {
      targetQuestionId: target.candidate.questionId,
      displayNo: target.candidate.displayNo,
      stem: target.candidate.stem,
      reason: target.enclosed ? "enclosed_blank" : "nearest_blank",
      confidence: target.enclosed ? "high" : "medium",
      sortedCandidates: scored.map((item) => item.candidate),
    };
  }

  // ── 三级：段落对齐（无空位卷）──
  const byParagraph = new Map<string, ScoredCandidate>();
  for (const anchor of input.paragraphAnchors ?? []) {
    const question = byId.get(anchor.questionId);
    if (!question) continue;
    const contains = anchor.start <= selectionMid && selectionMid < anchor.end;
    offer(byParagraph, {
      candidate: { questionId: anchor.questionId, displayNo: displayNoOf(question), stem: question.stem },
      distance: contains ? 0 : Math.abs(midOf(anchor.start, anchor.end) - selectionMid),
      order: anchor.paragraphIndex,
      enclosed: contains,
    });
  }
  const paragraphScored = [...byParagraph.values()].sort(rank);
  if (paragraphScored.length === 0) return null;

  const target = paragraphScored[0]!;
  return {
    targetQuestionId: target.candidate.questionId,
    displayNo: target.candidate.displayNo,
    stem: target.candidate.stem,
    reason: "paragraph_aligned",
    confidence: "medium",
    sortedCandidates: paragraphScored.map((item) => item.candidate),
  };
}

/** 判定原因的界面文案（单一真源：UI 不自己拼字符串）。 */
export const PROXIMITY_REASON_LABELS: Record<ProximityReason, string> = {
  enclosed_blank: "选区包含该空",
  nearest_blank: "距该空最近",
  paragraph_aligned: "与本段对应",
};
