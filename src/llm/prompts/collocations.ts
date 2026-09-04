import type { LlmMessage } from "../provider";
import type { DictionaryCandidate } from "../../dictionary/provider";

interface WordContext {
  lemma: string;
  pos: string;
  semanticField: string;
  shortDefinition: string;
  cefrTarget: string;
}

interface CollocationPromptConfig {
  count: number;
  cefrTarget: string;
}

/**
 * Options for the collocation prompt builder.
 *
 * `dictionaryCandidates` switches the prompt into dictionary-grounded mode:
 * the LLM is told it may only refine/annotate the supplied candidates and must
 * not invent collocations absent from the list. This is the core of B3 — the
 * dictionary is the single source of truth for which phrases exist.
 */
export interface CollocationPromptOptions {
  dictionaryCandidates?: DictionaryCandidate[];
}

/**
 * Serialize dictionary candidates into a compact, LLM-readable block. Each line
 * carries the phrase plus any gloss/example/score Datamuse provided so the LLM
 * has context to refine rather than regenerate.
 */
function serializeCandidates(candidates: DictionaryCandidate[]): string {
  return candidates
    .map((c, i) => {
      const parts = [`${i + 1}. phrase: ${c.phrase}`];
      if (c.headword) parts.push(`headword: ${c.headword}`);
      if (c.meaning) parts.push(`meaning: ${c.meaning}`);
      if (c.example) parts.push(`example: ${c.example}`);
      if (typeof c.score === "number") parts.push(`score: ${c.score}`);
      if (c.sourceName) parts.push(`source: ${c.sourceName}`);
      return parts.join(", ");
    })
    .join("\n");
}

export function buildCollocationPrompt(
  word: WordContext,
  config: CollocationPromptConfig,
  options?: CollocationPromptOptions,
): LlmMessage[] {
  const candidates = options?.dictionaryCandidates;

  // ── Dictionary-grounded prompt (B3) ────────────────────────────────────
  // When candidates are supplied, the LLM is constrained to refine/annotate
  // only those candidates. This is the candidate-grounding contract: the
  // dictionary is the sole source of which phrases exist; the LLM only adds
  // glosses/examples/tone. Datamuse is treated as a candidate source, not
  // absolute truth — the LLM may drop weak candidates but may not invent new
  // ones outside the list.
  if (candidates && candidates.length > 0) {
    const candidateBlock = serializeCandidates(candidates);
    return [
      {
        role: "system",
        content: `你是一个英语词汇教学专家。下面是从词典检索到的候选搭配，你的任务是对其进行精选与润色。
【关键约束 / Critical constraints】
- 你只能从下方 dictionaryCandidates 中选择、排序、润色，不得发明（invent）任何不在候选列表中的新搭配。
- 可以合并语义重复的候选，可以丢弃明显不相关或低质量的候选，但不能新增候选。
- 为每个保留的搭配补充中文释义、语感标注（formal/neutral/informal）与简短例句。
- 例句应基于候选语境，不要编造与搭配无关的句子。
- 目标考试级别：${config.cefrTarget}
- 最多输出 ${config.count} 个搭配。
- 严格只输出 JSON 数组，不要任何解释文字：
[{"phrase":"...","gloss":"中文释义","tone":"formal|neutral|informal","example":"英文例句","exampleTranslation":"中文翻译"}]

dictionaryCandidates（唯一事实来源 / sole source of truth）：
${candidateBlock}`,
      },
      {
        role: "user",
        content: `单词：${word.lemma}（${word.pos}）
语义场：${word.semanticField}
核心释义：${word.shortDefinition}

请从上面的 dictionaryCandidates 中精选最多 ${config.count} 个搭配并润色。再次强调：不要发明候选列表之外的新搭配。`,
      },
    ];
  }

  // ── Ungrounded prompt (legacy / no dictionary) ────────────────────────
  return [
    {
      role: "system",
      content: `你是一个英语词汇教学专家。为给定单词生成 ${config.count} 个最值得记忆的搭配。
要求：
- 每个搭配配一句简短例句（来自真实语境，不是编造的）
- 搭配要"高频且考试有用"，不要生僻
- 标注每个搭配的语感（formal/neutral/informal）
- 目标考试级别：${config.cefrTarget}
- 严格只输出 JSON 数组，不要任何解释文字：
[{"phrase":"...","gloss":"中文释义","tone":"formal|neutral|informal","example":"英文例句","exampleTranslation":"中文翻译"}]`,
    },
    {
      role: "user",
      content: `单词：${word.lemma}（${word.pos}）
语义场：${word.semanticField}
核心释义：${word.shortDefinition}`,
    },
  ];
}
