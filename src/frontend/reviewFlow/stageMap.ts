/**
 * stageMap —— 阶梯会话契约常量与评分纯函数（ADR-0036，演示页 D 区 stageMap v3.2 逐条落地）。
 *
 * 拍板①：评分政策 B（B-floor）= min(卡面自评, 默写映射)，客观只降不升。
 * 拍板③：R2 撤提示面板（card:no-hints）。
 * 拍板⑥：三轮制（再认→巩固→产出），轮内新旧交替，同词不背靠背，复核入队尾。
 * 拍板⑦：产出环节自选降档——档位菜单常驻（选择即信号，不由失败触发）。
 */

import type { LadderRung } from "@/domain/ladder-rung";
import type { ReviewRating } from "@/domain";

/** 评分序（again < hard < good < easy）；数值越大 = 记得越好。 */
export const CAP_RANK: Record<ReviewRating, number> = { again: 0, hard: 1, good: 2, easy: 3 };

/** 档位菜单（拍板⑦）：默写·无上限 / 听写·上限困难 / 照着打·上限重来。 */
export type DictationTier = "dictation" | "listen" | "copy";

export const TIER_CAP: Record<DictationTier, ReviewRating | null> = {
  dictation: null,
  listen: "hard",
  copy: "again",
};

export const TIER_LABEL: Record<DictationTier, string> = {
  dictation: "默写",
  listen: "听写",
  copy: "照着打",
};

/** 档内错键 → 表现映射（演示页 THRESH = { goodMax: 2, hardMax: 4 }）。 */
export const DICTATION_THRESH = { goodMax: 2, hardMax: 4 } as const;

/** baseRating(wt)：0 错→轻松；1–2 错→良好；3–4 错→困难；≥5 键→重来。 */
export function baseRating(wrongTimes: number): ReviewRating {
  if (wrongTimes <= 0) return "easy";
  if (wrongTimes <= DICTATION_THRESH.goodMax) return "good";
  if (wrongTimes <= DICTATION_THRESH.hardMax) return "hard";
  return "again";
}

/**
 * T3 提示上限（默写档 Tab 逐字母揭示，每揭一字母计一级）。
 * 与卡面 HintLadderPanel 的 hintCapNow 同口径：0 级→easy / 1 级→good / ≥2 级→hard。
 */
export function dictationHintCap(hintChars: number): ReviewRating {
  if (hintChars <= 0) return "easy";
  if (hintChars === 1) return "good";
  return "hard";
}

/** 档内完成 → dictMap = min(表现映射, T3 提示上限, 档位上限)（如实差分，逐项取更严者）。 */
export function dictMapOf(input: {
  wrongTimes: number;
  hintChars: number;
  tier: DictationTier;
}): ReviewRating {
  let map = baseRating(input.wrongTimes);
  const dCap = dictationHintCap(input.hintChars);
  if (CAP_RANK[map] > CAP_RANK[dCap]) map = dCap;
  const tierCap = TIER_CAP[input.tier];
  if (tierCap && CAP_RANK[map] > CAP_RANK[tierCap]) map = tierCap;
  return map;
}

/**
 * 政策 B final（演示页 endSession 逐条落地）：
 * - rung≥3：final = dictMap（本档即测量，卡面自评不参与）；
 * - rung<3：final = cardRating，被 dictMap 兜底压低（只降不升）。
 */
export function policyBFinal(input: {
  ladderRung: LadderRung;
  cardRating: ReviewRating | null;
  dictMap: ReviewRating | null;
}): ReviewRating {
  if (input.ladderRung >= 3) return input.dictMap ?? "again";
  let final = input.cardRating ?? "again";
  if (input.dictMap && CAP_RANK[final] > CAP_RANK[input.dictMap]) final = input.dictMap;
  return final;
}

/** 会话调度常量（演示页 D 区 SESSION_SCHEDULER）。 */
export const SESSION_SCHEDULER = {
  passes: ["recognition", "consolidation", "production"],
  interleave: "new-between-reviews",
  rule: "no-back-to-back-same-word",
  fallbackEnqueue: "session-tail",
} as const;

/**
 * 每词访问模板（演示页 D 区 VISIT_TEMPLATE）：
 * NEW(R0)=[card-encode, follow|listen, dictation, first-rate]；
 * R1=[card, follow|listen, dictation]；R2=[card:no-hints, …]；R3=[dictation]。
 */
export const VISIT_TEMPLATE = {
  NEW: ["card-encode", "follow", "dictation", "first-rate"],
  R1: ["card", "follow", "dictation"],
  R2: ["card-no-hints", "follow", "dictation"],
  R3: ["dictation"],
} as const;

/** 阶梯会话内的一次访问（三 pass 中的一个节点）。 */
export type LadderStage = "card" | "card-encode" | "card-no-hints" | "follow" | "dictation" | "meaning";

export interface LadderVisit {
  /** 来源队列卡下标（buildLadderSession 输入数组中的位置）。 */
  qi: number;
  progressId: string;
  pass: 1 | 2 | 3;
  stage: LadderStage;
  /** R3 词产出完成后的词义卡复核（入队尾，无调度语义，不再 POST）。 */
  meaningReview?: boolean;
}
