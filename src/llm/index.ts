/**
 * LLM barrel — unified entry point for LLM provider construction,
 * parsing, and usage tracking.
 *
 * Re-exports public types/implementations and exposes {@link createLlmProvider}
 * so callers (services, scripts) never import concrete providers directly.
 */

export type {
  LlmProvider,
  LlmMessage,
  LlmOptions,
  LlmResult,
  LlmProviderConfig,
} from "./provider";
export { OpenAICompatibleProvider } from "./providers/openai-compatible";
export { AnthropicProvider } from "./providers/anthropic";
export { parseLlmJson, type ParseResult } from "./parser";
export { UsageTracker } from "./usage-tracker";

import type { LlmProvider, LlmProviderConfig } from "./provider";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import { AnthropicProvider } from "./providers/anthropic";

/**
 * Construct an {@link LlmProvider} from a typed config.
 *
 * - `openai`     → OpenAICompatibleProvider (covers OpenAI/DeepSeek/Ollama/中转站)
 * - `anthropic`  → AnthropicProvider (native Claude format)
 */
export function createLlmProvider(config: LlmProviderConfig): LlmProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAICompatibleProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    default: {
      // Exhaustiveness guard — future providers must extend this switch.
      const exhaustive: never = config.provider;
      throw new Error(`Unknown LLM provider: ${exhaustive}`);
    }
  }
}
