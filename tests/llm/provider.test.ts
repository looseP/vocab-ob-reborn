import { describe, it, expectTypeOf, expect, vi } from "vitest";
import type { LlmProvider, LlmMessage, LlmOptions, LlmResult, LlmProviderConfig } from "@/llm/provider";
import { OpenAICompatibleProvider } from "@/llm/providers/openai-compatible";

// mock openai SDK
vi.mock("openai", () => ({
  default: vi.fn(function (this: any, _config: any) {
    return {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"phrase":"abundant evidence"}' } }],
            usage: { prompt_tokens: 50, completion_tokens: 20 },
            model: "gpt-4o",
          }),
        },
      },
    };
  }),
}));

describe("LLM types", () => {
  it("LlmMessage has role + content", () => {
    expectTypeOf<LlmMessage>().toMatchTypeOf<{
      role: "system" | "user" | "assistant";
      content: string;
    }>();
  });

  it("LlmOptions has optional fields", () => {
    expectTypeOf<LlmOptions>().toMatchTypeOf<{
      temperature?: number;
      maxTokens?: number;
      model?: string;
    }>();
  });

  it("LlmResult has content + usage", () => {
    expectTypeOf<LlmResult>().toMatchTypeOf<{
      content: string;
      promptTokens: number;
      completionTokens: number;
      model: string;
    }>();
  });

  it("LlmProvider has generate method", () => {
    expectTypeOf<LlmProvider>().toMatchTypeOf<{
      generate: (messages: LlmMessage[], options?: LlmOptions) => Promise<LlmResult>;
    }>();
  });

  it("LlmProviderConfig has provider + apiKey + baseURL + model", () => {
    expectTypeOf<LlmProviderConfig>().toMatchTypeOf<{
      provider: "openai" | "anthropic";
      apiKey?: string;
      baseURL?: string;
      model: string;
    }>();
  });
});

describe("OpenAICompatibleProvider", () => {
  it("generate returns LlmResult with content + usage", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      model: "gpt-4o",
    });
    const result = await provider.generate([
      { role: "system", content: "You are a vocabulary teacher." },
      { role: "user", content: "Generate collocations for 'abundant'" },
    ]);
    expect(result.content).toBe('{"phrase":"abundant evidence"}');
    expect(result.promptTokens).toBe(50);
    expect(result.completionTokens).toBe(20);
    expect(result.model).toBe("gpt-4o");
  });

  it("accepts custom baseURL for DeepSeek/Ollama", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-deepseek",
      baseURL: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
    });
    const result = await provider.generate([
      { role: "user", content: "test" },
    ]);
    expect(result.content).toBeDefined();
  });

  it("uses options.model to override default", async () => {
    const OpenAI = (await import("openai")).default;
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      model: "gpt-4o",
    });
    await provider.generate(
      [{ role: "user", content: "test" }],
      { model: "gpt-4o-mini" },
    );
    const mockResults = vi.mocked(OpenAI).mock.results;
    const mockInstance = mockResults[mockResults.length - 1]?.value;
    expect(mockInstance.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini" }),
    );
  });

  it("handles empty response content", async () => {
    // 重新 mock 返回空 content
    const OpenAI = (await import("openai")).default;
    vi.mocked(OpenAI).mockImplementationOnce(function (this: any, _config: any) {
      return {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: null } }],
              usage: { prompt_tokens: 10, completion_tokens: 0 },
              model: "gpt-4o",
            }),
          },
        },
      };
    } as any);
    const provider = new OpenAICompatibleProvider({ apiKey: "sk-test", model: "gpt-4o" });
    const result = await provider.generate([{ role: "user", content: "test" }]);
    expect(result.content).toBe("");
  });
});
