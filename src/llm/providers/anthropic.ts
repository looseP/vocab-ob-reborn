import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, LlmMessage, LlmOptions, LlmResult } from "../provider";
import { Semaphore } from "../semaphore";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 2_048;
const DEFAULT_MAX_CONCURRENCY = 4;

interface AnthropicConfig {
  apiKey?: string;
  baseURL?: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  maxConcurrency?: number;
}

/**
 * Anthropic Claude 原生 provider。
 * API 格式与 OpenAI 不同：system 消息单独传，content 返回是数组。
 */
export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs: number;
  private readonly semaphore: Semaphore;

  constructor(config: AnthropicConfig) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client = new Anthropic({
      apiKey: config.apiKey ?? "dummy",
      baseURL: config.baseURL,
      timeout: this.timeoutMs,
      maxRetries: 0,
    });
    this.defaultModel = config.model;
    this.defaultMaxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.semaphore = new Semaphore(config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  }

  async generate(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResult> {
    const model = options?.model ?? this.defaultModel;

    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const response = await this.semaphore.run(() =>
      this.client.messages.create(
        {
          model,
          max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
          temperature: options?.temperature ?? 0.7,
          system: systemMessage?.content,
          messages: nonSystemMessages.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
        },
        { timeout: this.timeoutMs },
      ),
    );

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
