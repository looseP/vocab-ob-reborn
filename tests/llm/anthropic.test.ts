import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn(function (this: any, _config: any) {
    return {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: '{"phrase":"abundant evidence"}' }],
          usage: { input_tokens: 50, output_tokens: 20 },
          model: "claude-sonnet-4-20250514",
        }),
      },
    };
  }),
}));

import { AnthropicProvider } from "@/llm/providers/anthropic";

describe("AnthropicProvider", () => {
  it("generate returns LlmResult with content + usage", async () => {
    const provider = new AnthropicProvider({
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-20250514",
    });
    const result = await provider.generate([
      { role: "system", content: "You are a vocabulary teacher." },
      { role: "user", content: "Generate collocations for 'abundant'" },
    ]);
    expect(result.content).toBe('{"phrase":"abundant evidence"}');
    expect(result.promptTokens).toBe(50);
    expect(result.completionTokens).toBe(20);
    expect(result.model).toBe("claude-sonnet-4-20250514");
  });

  it("handles multiple text blocks in response", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    vi.mocked(Anthropic).mockImplementationOnce(function (this: any) {
      return {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [
              { type: "text", text: '{"phrase":' },
              { type: "text", text: '"abundant evidence"}' },
            ],
            usage: { input_tokens: 50, output_tokens: 20 },
            model: "claude-sonnet-4-20250514",
          }),
        },
      };
    } as any);
    const provider = new AnthropicProvider({ apiKey: "sk-test", model: "claude-sonnet-4-20250514" });
    const result = await provider.generate([{ role: "user", content: "test" }]);
    expect(result.content).toBe('{"phrase":"abundant evidence"}');
  });

  it("passes system message separately from user messages", async () => {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const provider = new AnthropicProvider({ apiKey: "sk-test", model: "claude-sonnet-4-20250514" });
    await provider.generate([
      { role: "system", content: "System prompt here" },
      { role: "user", content: "User message" },
    ]);
    const results = vi.mocked(Anthropic).mock.results;
    const mockInstance = results[results.length - 1]?.value;
    expect(mockInstance.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "System prompt here",
        max_tokens: 2048,
        messages: expect.not.arrayContaining([
          expect.objectContaining({ role: "system" }),
        ]),
      }),
      expect.objectContaining({ timeout: 30000 }),
    );
  });
});
