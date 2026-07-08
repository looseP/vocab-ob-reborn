import OpenAI from "openai";
import type { LlmProvider, LlmMessage, LlmOptions, LlmResult } from "../provider";

interface OpenAICompatibleConfig {
  apiKey?: string;
  baseURL?: string;
  model: string;
}

/**
 * 覆盖 OpenAI / DeepSeek / Ollama / 中转站 —— 所有 OpenAI 兼容 API。
 * 通过不同 baseURL 区分，底层用官方 openai SDK。
 */
export class OpenAICompatibleProvider implements LlmProvider {
  private client: OpenAI;
  private defaultModel: string;

  constructor(config: OpenAICompatibleConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey ?? "dummy",
      baseURL: config.baseURL,
    });
    this.defaultModel = config.model;
  }

  async generate(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResult> {
    const model = options?.model ?? this.defaultModel;
    const response = await this.client.chat.completions.create({
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens,
    });

    const content = response.choices[0]?.message?.content ?? "";
    return {
      content,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      model: response.model ?? model,
    };
  }
}
