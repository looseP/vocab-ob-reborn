/**
 * hintSteps —— T3 提示步构建与剧透检测（共享模块，LW-2 从 ReviewCardView 提取）。
 *
 * 降级链：H1 **揭示词形**（缺失降级 H1″ 语义链）→ **H1′ 真题语境**（FR-12 接线1，
 * 2026-10-04）→ H2 原型意象（isSpoiler 剧透跳级）→ H3 助记锚。数据缺失级自动跳过
 * （ADR-0036 LW-2：新词编码卡复用同链）。
 *
 * **H1 语义变更（2026-09-29，移植未合并的 86d9b3f / wordcard-mock 对齐）**：
 * 例句已由正面「例句线索区」（ClueZone）呈现且目标词被遮盖，H1 不再重复给整句，
 * 只负责**解锁词形**（`anchor`）。评分上限经济学**不变**：0→easy / 1→good / ≥2→hard。
 * 提示面板同步改为「👁 词形已揭示 — 回到上方例句核对语境与搭配」。
 *
 * **H1′ 真题语境（2026-10-04，FR-12 接线1 升级）**：用户自己圈记的 L3 语境（真题原句）
 * 从"卡背 Tier 2 折叠"升为**提示阶梯的一级** —— 翻卡前看不到语境这个问题（语境在
 * 卡背第 6 位、需滚动、而评分发生在翻卡之后）由此解决。口径三条：
 * 1. **目标词遮盖**（`maskTerm`）：这一级是"换一个真实语境再自认一次"，不是给答案；
 * 2. **不给 bound_sense**：语境义快照是中文释义，放进提示等于直接剧透（卡背折叠仍显示）；
 * 3. **定位不到词面就不生成这一级**（fail-closed）：宁可少一级，也不给未遮盖的句子。
 */

import type { ReviewCard } from "@/frontend/hooks/useReview";

export type HintStep =
  /**
   * H1 = 揭示词形。`anchor` 是被遮盖的目标词锚（例句里的原形/变形），
   * 为 null 时表示例句无可遮盖目标词（此时面板只给"已揭示"提示，不重复原文）。
   * 保留 `text`/`translation` 是为了让降级路径（无遮盖锚的 v1 批次）仍能给出上下文。
   */
  | { kind: "example"; text: string; translation: string | null; anchor: string | null }
  | { kind: "chain"; text: string }
  /** H1′ 真题语境（FR-12 接线1）：目标词遮盖的 L3 语境句（至多 limit 条，服务端 limit=2）。 */
  | { kind: "l3_context"; items: L3ContextHintItem[] }
  | { kind: "prototype"; text: string }
  | { kind: "mnemonic"; text: string; mtype: string | null };

export const HINT_STEP_LABEL: Record<HintStep["kind"], string> = {
  example: "H1 揭示词形",
  chain: "H1″ 语义链",
  l3_context: "H1′ 真题语境",
  prototype: "H2 原型",
  mnemonic: "H3 助记锚",
};

/**
 * 提示级用的 L3 语境条目（**只取 buildHintSteps 需要的字段**，不耦合 HTTP 契约全量）。
 */
export interface L3ContextHintItem {
  contextId: string;
  /** 真题原句（可能含 `〖n〗` 空号占位，渲染层统一解析）。 */
  text: string;
  sourceTitle: string;
  /** 遮盖锚：必须能在 `text` 中定位（否则该条不进提示级）。 */
  maskTerm: string;
}

/** 语境入参形态（`ReviewL3ContextItem` 的结构子集，便于测试构造）。 */
export interface L3ContextHintSource {
  context_id: string;
  text: string;
  source_title: string;
  /** occurrence 词面（服务端注入）；缺失时回退用 lemma 定位。 */
  surface?: string | null;
}

/** 词内字符判定（定位 lemma 整词时用，避免 `able` 命中 `available`）。 */
function isWordChar(ch: string): boolean {
  return ch !== "" && /[a-z0-9]/i.test(ch);
}

/** 整词出现（大小写不敏感，允许词首/词尾为标点或空格）。 */
function containsAsWord(text: string, term: string): boolean {
  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) return false;
    const before = idx === 0 ? "" : haystack[idx - 1];
    const after = idx + needle.length >= haystack.length ? "" : haystack[idx + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = idx + 1;
  }
}

/**
 * 定位该在语境句里遮哪个词面。
 *
 * - `surface` 优先：它由 occurrence 抽取而来，**构造上必是 text 的子串** ⇒ 直接子串定位；
 * - 回退 `lemma`：lemma 只是词元，未必以原形出现（`abundant` → `abundance`），
 *   所以只认整词，避免误遮；
 * - 两者都定位不到 ⇒ 返回 null（调用方据此**不生成**这一级，绝不露出未遮盖的句子）。
 */
export function locateMaskTerm(
  text: string,
  surface: string | null | undefined,
  lemma: string | null | undefined,
): string | null {
  const s = surface?.trim();
  if (s && text.toLowerCase().includes(s.toLowerCase())) return s;
  const l = lemma?.trim();
  if (l && containsAsWord(text, l)) return l;
  return null;
}

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

/**
 * 由 queue 直载的 word 字段动态构建提示步（缺失级自动降级跳过）。
 *
 * `l3Contexts` 为可选的 L3 语境（`ReviewCard.l3_contexts`）：给了才可能生成 H1′ 级。
 * **新词编码卡当前不传**（它已由 #198 的 exam 三层承担"真题语境"，重复渲染无收益）。
 */
export function buildHintSteps(
  word: ReviewCard["word"] | null | undefined,
  l3Contexts?: readonly L3ContextHintSource[] | null,
): HintStep[] {
  if (!word) return [];
  const steps: HintStep[] = [];
  const example = (word.examples ?? []).find(
    (e): e is { text: string; translation?: unknown; anchor?: unknown } =>
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
      // H1 只解锁词形：anchor 是例句里被遮盖的目标词（v1 批次可能缺失 → null，
      // 此时面板退化为纯"已揭示"提示，不重复给整句）。
      anchor:
        typeof example.anchor === "string" && example.anchor.trim().length > 0
          ? example.anchor
          : null,
    });
  } else if (word.semantic_chain && word.semantic_chain.trim().length > 0) {
    steps.push({ kind: "chain", text: word.semantic_chain });
  }
  // H1′ 真题语境：只保留"能定位到遮盖锚"的条目；一条都定位不到 ⇒ 整级不生成。
  const l3Items: L3ContextHintItem[] = [];
  for (const context of l3Contexts ?? []) {
    if (typeof context?.text !== "string" || context.text.trim().length === 0) continue;
    const maskTerm = locateMaskTerm(context.text, context.surface, word.lemma);
    if (!maskTerm) continue;
    l3Items.push({
      contextId: context.context_id,
      text: context.text,
      sourceTitle: context.source_title,
      maskTerm,
    });
  }
  if (l3Items.length > 0) steps.push({ kind: "l3_context", items: l3Items });
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
