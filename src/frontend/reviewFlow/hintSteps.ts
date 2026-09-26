/**
 * hintSteps —— T3 提示步构建与剧透检测（共享模块，LW-2 从 ReviewCardView 提取）。
 *
 * 降级链：H1 例句（缺失降级 H1′ 语义链）→ H2 原型意象（isSpoiler 剧透跳级）
 * → H3 助记锚。数据缺失级自动跳过（ADR-0036 LW-2：新词编码卡复用同链）。
 * 逻辑与 ReviewCardView 原实现逐行等价（提取重构，行为零变化）。
 */

import type { ReviewCard } from "@/frontend/hooks/useReview";

export type HintStep =
  | { kind: "example"; text: string; translation: string | null }
  | { kind: "chain"; text: string }
  | { kind: "prototype"; text: string }
  | { kind: "mnemonic"; text: string; mtype: string | null };

export const HINT_STEP_LABEL: Record<HintStep["kind"], string> = {
  example: "H1 例句",
  chain: "H1′ 语义链",
  prototype: "H2 原型",
  mnemonic: "H3 助记锚",
};

/**
 * isSpoiler：提示文本与短释义的剧透重合检测（设计稿 v2 口径）——
 * 释义中任一 ≥2 连续汉字串出现在提示文本（去空白/记号）中 → 判剧透。
 */
export function isSpoiler(hintText: string, shortDefinition: string | null | undefined): boolean {
  if (!shortDefinition) return false;
  const runs = shortDefinition.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  if (runs.length === 0) return false;
  const stripped = hintText.replace(/[\s*`·]/g, "").toLowerCase();
  return runs.some((run) => stripped.includes(run));
}

/**
 * 记忆锚核心提取：精修版 mnemonic_text 可能是「核心 text 行 + **词源锚** + **画面锚**」
 * 拼接块；只取非锚段的核心行；整块都是锚段（核心丢失）时返回 null。
 */
export function extractMnemonicCore(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const segments = raw
    .split(/(?=\*\*词源锚)|(?=\*\*画面锚)|\n/)
    .map((segment) =>
      segment
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .replace(/^- (?:text:\s*)?/, "")
        .trim(),
    )
    .filter(Boolean);
  const core = segments.find(
    (segment) => !segment.startsWith("词源锚") && !segment.startsWith("画面锚"),
  );
  return core || null;
}

/** 由 queue 直载的 word 字段动态构建提示步（缺失级自动降级跳过）。 */
export function buildHintSteps(word: ReviewCard["word"] | null | undefined): HintStep[] {
  if (!word) return [];
  const steps: HintStep[] = [];
  const example = (word.examples ?? []).find(
    (e): e is { text: string; translation?: unknown } =>
      typeof e === "object" && e !== null &&
      typeof (e as { text?: unknown }).text === "string" &&
      ((e as { text: string }).text.trim().length > 0),
  );
  if (example) {
    steps.push({
      kind: "example",
      text: example.text,
      translation:
        typeof example.translation === "string" && example.translation.trim().length > 0
          ? example.translation
          : null,
    });
  } else if (word.semantic_chain && word.semantic_chain.trim().length > 0) {
    steps.push({ kind: "chain", text: word.semantic_chain });
  }
  if (
    word.prototype_text && word.prototype_text.trim().length > 0 &&
    !isSpoiler(word.prototype_text, word.short_definition)
  ) {
    steps.push({ kind: "prototype", text: word.prototype_text });
  }
  const mnemonicCore = extractMnemonicCore(word.mnemonic_text ?? null);
  if (mnemonicCore) {
    steps.push({ kind: "mnemonic", text: mnemonicCore, mtype: word.mnemonic_type ?? null });
  }
  return steps;
}
