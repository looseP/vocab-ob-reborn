import type { LlmMessage } from "../provider";

interface WordContext {
  lemma: string;
  pos: string;
  semanticField: string;
  shortDefinition: string;
  cefrTarget: string;
}

interface AntonymPromptConfig {
  count: number;
}

/**
 * Build the prompt for generating antonyms (反义词) of a word.
 *
 * Unlike the synonym prompt (which focuses on near-meaning discrimi-
 * nation), this prompt is tuned to surface *contrastive* lemmas: words
 * that mark the opposite end of the word's semantic axis. Each entry
 * describes the antonym itself, how it contrasts with the target word,
 * and the usage boundary that tells learners when one applies vs. the
 * other.
 *
 * The output JSON shape matches `l2SynonymItemSchema` (word /
 * semanticDiff / tone / usage / delta / object) so it flows through the
 * existing antonym content schema and parser unchanged.
 */
export function buildAntonymPrompt(
  word: WordContext,
  config: AntonymPromptConfig,
): LlmMessage[] {
  return [
    {
      role: "system",
      content: `你是一个英语词汇教学专家。为给定单词生成 ${config.count} 个最值得辨析的反义词/对立词。
要求：
- 反义词必须与原词构成真正的语义对立（不是任意无关词），优先选学习者易混淆的高频词
- 每条提供五维辨析：
  · semanticDiff：该反义词与原词的语义对立点（一句话）
  · tone：语感 formal|neutral|informal
  · usage：用法差异——在什么语境下该用反义词而非原词
  · delta：核心区别——两者的根本对立轴是什么
  · object：适用对象——该反义词常搭配的人/物/抽象概念
- 明确标注反义词与原词的用法边界（usage boundary）：何时用哪个，避免误用
- 严格只输出 JSON 数组，不要任何解释文字：
[{"word":"反义词","semanticDiff":"一句话语义对立","tone":"formal|neutral|informal","usage":"用法差异与边界","delta":"核心对立","object":"适用对象"}]`,
    },
    {
      role: "user",
      content: `单词：${word.lemma}（${word.pos}）
语义场：${word.semanticField}
核心释义：${word.shortDefinition}`,
    },
  ];
}
