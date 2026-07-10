import OpenAI from "openai";
import type { LlmProvider, LlmMessage, LlmOptions, LlmResult } from "../provider";
import { Semaphore } from "../semaphore";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 2_048;
const DEFAULT_MAX_CONCURRENCY = 4;

interface OpenAICompatibleConfig {
  apiKey?: string;
  baseURL?: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  maxConcurrency?: number;
}

/**
 * 覆盖 OpenAI / DeepSeek / Ollama / 中转站 —— 所有 OpenAI 兼容 API。
 * 通过不同 baseURL 区分，底层用官方 openai SDK。
 */
export class OpenAICompatibleProvider implements LlmProvider {
  private readonly client: OpenAI;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;
  private readonly timeoutMs: number;
  private readonly semaphore: Semaphore;

  constructor(config: OpenAICompatibleConfig) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client = new OpenAI({
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
    const response = await this.semaphore.run(() =>
      this.client.chat.completions.create(
        {
          model,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          temperature: options?.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? this.defaultMaxTokens,
        },
        { timeout: this.timeoutMs },
      ),
    );

    const content = response.choices[0]?.message?.content ?? "";
    return {
      content,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      model: response.model ?? model,
    };
  }
}
