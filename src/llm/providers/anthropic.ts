import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, LlmMessage, LlmOptions, LlmResult } from "../provider";

interface AnthropicConfig {
  apiKey?: string;
  baseURL?: string;
  model: string;
}

/**
 * Anthropic Claude 原生 provider。
 * API 格式与 OpenAI 不同：system 消息单独传，content 返回是数组。
 */
export class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  private defaultModel: string;

  constructor(config: AnthropicConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey ?? "dummy",
      baseURL: config.baseURL,
    });
    this.defaultModel = config.model;
  }

  async generate(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResult> {
    const model = options?.model ?? this.defaultModel;

    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
      system: systemMessage?.content,
      messages: nonSystemMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });

    const content = response.content
      .filter((block) => block.type === "text")
      .map((block) => ("text" in block ? block.text : ""))
      .join("");

    return {
      content,
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      model: response.model ?? model,
    };
  }
}
