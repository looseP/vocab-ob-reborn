/**
 * LLM Provider 统一接口 —— 薄胶水层，底层用官方 SDK。
 *
 * 设计原则：
 * - 官方 SDK 负责 HTTP/重试/SSE/错误码（脏活让 SDK 干）
 * - 我们只写统一接口把 SDK 包起来
 * - OpenAI/DeepSeek/Ollama/中转站全走 OpenAICompatibleProvider（不同 baseURL）
 * - Anthropic 走 AnthropicProvider（原生格式）
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

export interface LlmResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export interface LlmProvider {
  generate(messages: LlmMessage[], options?: LlmOptions): Promise<LlmResult>;
}

export interface LlmProviderConfig {
  /** 供应商类型：openai（含 DeepSeek/Ollama/中转站）或 anthropic */
  provider: "openai" | "anthropic";
  /** API Key（Ollama 本地不需要） */
  apiKey?: string;
  /** 自定义端点（中转站/Ollama/DeepSeek 都用这个） */
  baseURL?: string;
  /** 默认模型 */
  model: string;
  /** 单次 SDK 请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 未显式传 maxTokens 时使用的输出 token 上限。 */
  maxTokens?: number;
  /** 当前进程允许同时进行的 provider 请求数。 */
  maxConcurrency?: number;
}
