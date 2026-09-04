import type { LlmMessage } from "../provider";

interface WordContext {
  lemma: string;
  pos: string;
  semanticField: string;
  shortDefinition: string;
  cefrTarget: string;
}

interface SynonymPromptConfig {
  count: number;
}

export function buildSynonymPrompt(
  word: WordContext,
  config: SynonymPromptConfig,
): LlmMessage[] {
  return [
    {
      role: "system",
      content: `你是一个英语词汇教学专家。为给定单词生成 ${config.count} 个最值得辨析的近义词。
要求：
- 五维辨析：semanticDiff（语义差异）/ tone（语气）/ usage（用法差异）/ delta（核心区别）/ object（适用对象）
- 严格只输出 JSON 数组：
[{"word":"近义词","semanticDiff":"一句话语义差异","tone":"formal|neutral|informal","usage":"用法差异","delta":"核心区别","object":"适用对象"}]`,
    },
    {
      role: "user",
      content: `单词：${word.lemma}（${word.pos}）
语义场：${word.semanticField}
核心释义：${word.shortDefinition}`,
    },
  ];
}
