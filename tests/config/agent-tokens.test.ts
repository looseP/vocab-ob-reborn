import { describe, expect, it } from "vitest";
import {
  AGENT_ID_PATTERN,
  AgentTokenConfigError,
  parseAgentTokens,
} from "@/config/agent-tokens";

describe("parseAgentTokens", () => {
  it("treats unset and empty as no agents", () => {
    expect(parseAgentTokens(undefined)).toEqual([]);
    expect(parseAgentTokens("")).toEqual([]);
    expect(parseAgentTokens("   ")).toEqual([]);
  });

  it("parses `agentId:token` pairs and preserves order", () => {
    expect(parseAgentTokens("ci-runner:aaaa1111,review-bot:bbbb2222")).toEqual([
      { agentId: "ci-runner", token: "aaaa1111" },
      { agentId: "review-bot", token: "bbbb2222" },
    ]);
  });

  it("tolerates surrounding whitespace around the single colon", () => {
    expect(parseAgentTokens(" bot : token123 ")).toEqual([{ agentId: "bot", token: "token123" }]);
  });

  it("rejects a bare legacy token with a migration hint", () => {
    expect(() => parseAgentTokens("legacy-token")).toThrow(AgentTokenConfigError);
    expect(() => parseAgentTokens("legacy-token")).toThrow(/agentId:token/);
  });

  it("rejects entries with more than one colon (token must be hex/base64url)", () => {
    expect(() => parseAgentTokens("a:b:c")).toThrow(/more than one ":"/);
  });

  it("rejects empty entries", () => {
    expect(() => parseAgentTokens("a:1,")).toThrow(/empty entry/);
    expect(() => parseAgentTokens("a:1,,b:2")).toThrow(/empty entry/);
  });

  it("enforces the agentId lexical pattern", () => {
    expect(AGENT_ID_PATTERN.test("bot-1")).toBe(true);
    expect(() => parseAgentTokens("Bot:1")).toThrow(/agentId/);
    expect(() => parseAgentTokens("-bot:1")).toThrow(/agentId/);
    expect(() => parseAgentTokens("bot_1:1")).toThrow(/agentId/);
    expect(() => parseAgentTokens(`${"a".repeat(33)}:1`)).toThrow(/agentId/);
  });

  it("rejects an empty token", () => {
    expect(() => parseAgentTokens("bot:")).toThrow(/empty token/);
    expect(() => parseAgentTokens("bot:  ")).toThrow(/empty token/);
  });

  it("rejects duplicate agentIds", () => {
    expect(() => parseAgentTokens("bot:1,bot:2")).toThrow(/duplicate agentId/);
  });

  it("rejects an agent token equal to OWNER_API_TOKEN", () => {
    expect(() => parseAgentTokens("bot:owner-token", "owner-token")).toThrow(/must differ from OWNER_API_TOKEN/);
    expect(parseAgentTokens("bot:agent-token", "owner-token")).toEqual([{ agentId: "bot", token: "agent-token" }]);
  });
});
