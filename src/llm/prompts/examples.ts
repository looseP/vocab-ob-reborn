import type { LlmMessage } from "../provider";
import type { L2StyleProfile } from "../../domain/l2-style-profile";

interface WordContext {
  lemma: string;
  pos: string;
  semanticField: string;
  shortDefinition: string;
  cefrTarget: string;
}

interface ExamplePromptConfig {
  domains: string[];
  difficulty: string;
  count: number;
}

/**
 * Options for the example prompt builder.
 *
 * `styleProfile` (B4) injects the selected profile's prompt rules — register,
 * difficulty, domains, sentence length, translation toggle, etc. — into the
 * system message so the LLM's example sentences conform to the requested
 * style. When omitted, the legacy config-driven prompt is used unchanged.
 */
export interface ExamplePromptOptions {
  styleProfile?: L2StyleProfile;
}

/**
 * Render a style profile's prompt rules into a human-readable bullet block.
 * Only rules the profile actually declares are emitted; absent rules are
 * omitted so the LLM isn't told to apply a constraint that doesn't exist.
 */
function renderStyleRules(profile: L2StyleProfile): string {
  const r = profile.promptRules;
  const lines: string[] = [];
  if (r.register) lines.push(`- 语体（register）：${r.register}`);
  if (r.difficulty) lines.push(`- 难度（difficulty）：${r.difficulty}`);
  if (r.domains && r.domains.length > 0) lines.push(`- 领域偏好：${r.domains.join("、")}`);
  if (r.cefrRange && r.cefrRange.length > 0) lines.push(`- CEFR 范围：${r.cefrRange.join("/")}`);
  if (r.sentenceLength) lines.push(`- 句长：${r.sentenceLength}`);
  if (r.includeTranslation === false) lines.push(`- 不需要中文翻译`);
  if (r.includeUsageNote) lines.push(`- 每句附用法说明（usageNote）`);
  if (r.includePattern) lines.push(`- 标注句型（pattern）`);
  if (r.avoidRareWords) lines.push(`- 避免生僻词`);
  if (r.avoidCliches) lines.push(`- 避免陈词滥调（cliché）`);
  if (r.examReady) lines.push(`- 优先考试可用句型`);
  if (typeof r.maxItems === "number") lines.push(`- 最多 ${r.maxItems} 句`);
  return lines.join("\n");
}

export function buildExamplePrompt(
  word: WordContext,
  config: ExamplePromptConfig,
  options?: ExamplePromptOptions,
): LlmMessage[] {
  const profile = options?.styleProfile;
  // Style profile rules, when present, override the legacy config values:
  // profile.domains wins over config.domains, profile.difficulty wins over
  // config.difficulty, profile.maxItems wins over config.count. This keeps the
  // profile as the authoritative style source (B4) while config remains the
  // fallback for callers that don't pass a profile.
  const domains = profile?.promptRules.domains ?? config.domains;
  const difficulty = profile?.promptRules.difficulty ?? config.difficulty;
  const count = profile?.promptRules.maxItems ?? config.count;
  const includeTranslation = profile?.promptRules.includeTranslation ?? true;

  const styleBlock = profile ? renderStyleRules(profile) : "";
  const styleHeader = profile
    ? `\n当前风格配置（styleProfile="${profile.id}"）：\n${styleBlock}`
    : "";

  const translationInstruction = includeTranslation
    ? "- 每句配中文翻译"
    : "- 不需要中文翻译";
  // When the profile requests a usage note, advertise the extra JSON field so
  // the LLM knows to populate it; otherwise the legacy three-field shape stays.
  const usageNoteField = profile?.promptRules.includeUsageNote
    ? ',"usageNote":"用法说明"'
    : "";

  return [
    {
      role: "system",
      content: `你是一个英语词汇教学专家。为给定单词生成 ${count} 个例句。
要求：
- 领域偏好：见 user 消息
- 难度：${difficulty}
${translationInstruction}
- 优先使用真实语境（不要教科书式无聊例句，要有信息密度）
- 严格只输出 JSON 数组：
[{"text":"英文例句","translation":"中文翻译","source":"generated"${usageNoteField}}]${styleHeader}`,
    },
    {
      role: "user",
      content: `单词：${word.lemma}（${word.pos}）
语义场：${word.semanticField}
核心释义：${word.shortDefinition}
领域偏好：${domains.join("、")}`,
    },
  ];
}
