# Phase 2B: LLM Provider + L2 扩展闭环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户能为一个词请求 L2 扩展（LLM 生成搭配/例句/同反义草稿），勾选采纳后写入 word_l2_content + 刷新 words JSONB 缓存 + 触发 L2 重卡。

**Architecture:** 官方 SDK（openai + @anthropic-ai/sdk）薄包装成统一 LlmProvider 接口。L2Service 编排：调 LLM 生成草稿 → 返回给用户勾选（不写 DB）→ 用户确认后写 word_l2_content → 刷 words JSONB → 重算 l2_content_hash → markL2StaleForRecheck。HTTP 路由 /api/l2/* 提供 draft + confirm 端点。

**Tech Stack:** openai SDK + @anthropic-ai/sdk（官方）+ Hono + Zod v4 + Vitest 4

**Spec 依据:**
- `docs/superpowers/specs/2026-07-06-self-growing-knowledge-chain.md`（LLM Provider 设计 + L2 扩展闭环）
- `docs/superpowers/specs/2026-07-07-dual-track-fsrs-spec.md`（content_hash 分层 + markL2StaleForRecheck）

**前置条件:**
- ✅ Phase 2A 完成（user_word_l2_progress 表 + content_hash 分层 + L2ProgressRepository + markL2StaleForRecheck）
- ✅ 221 测试全过，arch:check 零违规
- ✅ http-no-llm-direct 规则已预留

---

## File Structure

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/llm/provider.ts` | LlmProvider 接口 + LlmMessage/LlmOptions/LlmResult 类型 |
| `src/llm/providers/openai-compatible.ts` | OpenAICompatibleProvider（覆盖 OpenAI/DeepSeek/Ollama/中转站） |
| `src/llm/providers/anthropic.ts` | AnthropicProvider（Claude 原生） |
| `src/llm/prompts/collocations.ts` | 搭配生成 prompt 模板 |
| `src/llm/prompts/examples.ts` | 例句生成 prompt 模板 |
| `src/llm/prompts/synonyms.ts` | 同反义辨析 prompt 模板 |
| `src/llm/parser.ts` | LLM 响应 JSON 容错解析 |
| `src/llm/usage-tracker.ts` | token 计数 + 每日预算 |
| `src/llm/index.ts` | createLlmProvider(config) 工厂 + barrel |
| `src/repositories/l2-content.repository.ts` | word_l2_content 表 CRUD |
| `src/services/l2-content.service.ts` | L2 扩展闭环（generate draft + confirm + refresh + recheck） |
| `src/http/routes/l2.ts` | /api/l2/* 路由 |
| `tests/llm/provider.test.ts` | provider 接口测试 |
| `tests/llm/parser.test.ts` | JSON 容错解析测试 |
| `tests/llm/usage-tracker.test.ts` | 预算控制测试 |
| `tests/repositories/l2-content.test.ts` | L2 content repo 测试 |
| `tests/services/l2-content.test.ts` | L2 扩展闭环测试 |
| `tests/http/l2.test.ts` | L2 路由测试 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/db/schema.ts` | 新建 word_l2_content 表 |
| `src/domain/index.ts` | 加 L2ContentRow 类型 |
| `src/repositories/interfaces.ts` | 加 IL2ContentRepository |
| `src/repositories/factory.ts` | 注册 l2Content repo |
| `src/services/index.ts` | 加 L2ContentService + LlmProvider 注入 |
| `src/http/server.ts` | 挂载 /api/l2 路由 |
| `src/schemas/http/index.ts` | 加 L2 请求 schema |
| `src/index.ts` | 导出新类型 |
| `package.json` | 加 openai + @anthropic-ai/sdk |
| `.dependency-cruiser.cjs` | 无需改（http-no-llm-direct 已存在） |

---

## Task 1: 安装 LLM SDK 依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装官方 SDK**

```bash
npm install openai @anthropic-ai/sdk
```

- [ ] **Step 2: 验证安装**

```bash
node -e "const {OpenAI}=require('openai'); const {Anthropic}=require('@anthropic-ai/sdk'); console.log('openai:', typeof OpenAI, 'anthropic:', typeof Anthropic)"
```

Expected: `openai: function anthropic: function`

- [ ] **Step 3: 验证 typecheck + arch:check**

```bash
npm run typecheck && npm run arch:check
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add openai + @anthropic-ai/sdk for LLM provider"
```

---

## Task 2: LLM Provider 接口 + 类型（TDD）

**Files:**
- Create: `src/llm/provider.ts`
- Test: `tests/llm/provider.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/llm/provider.test.ts
import { describe, it, expectTypeOf } from "vitest";
import type { LlmProvider, LlmMessage, LlmOptions, LlmResult, LlmProviderConfig } from "@/llm/provider";

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
```

- [ ] **Step 2: 运行测试看失败**（typecheck 失败）

```bash
npm run typecheck
```

- [ ] **Step 3: 写最小实现**

```typescript
// src/llm/provider.ts
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
}
```

- [ ] **Step 4: 运行测试看通过**

```bash
npx vitest run tests/llm/provider.test.ts
```

- [ ] **Step 5: typecheck + arch:check**

- [ ] **Step 6: Commit**

```bash
git add src/llm/provider.ts tests/llm/provider.test.ts
git commit -m "feat(llm): add LlmProvider interface and types"
```

---

## Task 3: OpenAICompatibleProvider（TDD）

**Files:**
- Create: `src/llm/providers/openai-compatible.ts`
- Test: `tests/llm/provider.test.ts`（追加）

- [ ] **Step 1: 追加测试**

```typescript
// 追加到 tests/llm/provider.test.ts
import { OpenAICompatibleProvider } from "@/llm/providers/openai-compatible";

// mock openai SDK
vi.mock("openai", () => ({
  OpenAI: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: '{"phrase":"abundant evidence"}' } }],
          usage: { prompt_tokens: 50, completion_tokens: 20 },
          model: "gpt-4o",
        }),
      },
    },
  })),
}));

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

  it("accepts custom baseURL for DeepSeek/Ollama/中转站", async () => {
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

  it("uses options.model to override default model", async () => {
    const { OpenAI } = await import("openai");
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      model: "gpt-4o",
    });
    await provider.generate(
      [{ role: "user", content: "test" }],
      { model: "gpt-4o-mini" },
    );
    // 验证 SDK 的 create 被调用时 model 是 gpt-4o-mini
    const mockInstance = vi.mocked(OpenAI).mock.results[0]?.value
      ?? vi.mocked(OpenAI).mock.results[1]?.value;
    expect(mockInstance.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini" }),
    );
  });
});
```

- [ ] **Step 2: 运行测试看失败**

- [ ] **Step 3: 写实现**

```typescript
// src/llm/providers/openai-compatible.ts
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
      apiKey: config.apiKey ?? "dummy",  // Ollama 不需要 key，但 SDK 要求有值
      baseURL: config.baseURL,           // 不传则用 OpenAI 默认
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
```

- [ ] **Step 4: 运行测试看通过**

- [ ] **Step 5: typecheck + arch:check**

- [ ] **Step 6: Commit**

```bash
git add src/llm/providers/openai-compatible.ts tests/llm/provider.test.ts
git commit -m "feat(llm): add OpenAICompatibleProvider (OpenAI/DeepSeek/Ollama/中转站)"
```

---

## Task 4: AnthropicProvider（TDD）

**Files:**
- Create: `src/llm/providers/anthropic.ts`
- Test: `tests/llm/provider.test.ts`（追加）

- [ ] **Step 1: 追加测试**

```typescript
// 追加到 tests/llm/provider.test.ts
import { AnthropicProvider } from "@/llm/providers/anthropic";

vi.mock("@anthropic-ai/sdk", () => ({
  Anthropic: vi.fn(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"phrase":"abundant evidence"}' }],
        usage: { input_tokens: 50, output_tokens: 20 },
        model: "claude-sonnet-4-20250514",
      }),
    },
  })),
}));

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
});
```

- [ ] **Step 2: 运行测试看失败**

- [ ] **Step 3: 写实现**

```typescript
// src/llm/providers/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, LlmMessage, LlmOptions, LlmResult } from "../provider";

interface AnthropicConfig {
  apiKey?: string;
  baseURL?: string;
  model: string;
}

/**
 * Anthropic Claude 原生 provider。
 * Anthropic 的 API 格式与 OpenAI 不同（messages.create vs chat.completions.create），
 * system 消息单独传，所以需要独立 provider。
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

    // Anthropic 把 system 消息单独传，其余消息传到 messages 数组
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

    // Anthropic 返回 content 是数组，取第一个 text block
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
```

- [ ] **Step 4: 运行测试看通过**

- [ ] **Step 5: typecheck + arch:check**

- [ ] **Step 6: Commit**

```bash
git add src/llm/providers/anthropic.ts tests/llm/provider.test.ts
git commit -m "feat(llm): add AnthropicProvider (Claude native)"
```

---

## Task 5: LLM 响应 JSON 容错解析（TDD）

**Files:**
- Create: `src/llm/parser.ts`
- Test: `tests/llm/parser.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/llm/parser.test.ts
import { describe, it, expect } from "vitest";
import { parseLlmJson } from "@/llm/parser";

describe("parseLlmJson", () => {
  it("parses clean JSON", () => {
    const result = parseLlmJson('[{"phrase":"abundant evidence"}]');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ phrase: "abundant evidence" }]);
  });

  it("parses JSON wrapped in markdown code block", () => {
    const result = parseLlmJson('```json\n[{"phrase":"abundant evidence"}]\n```');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ phrase: "abundant evidence" }]);
  });

  it("parses JSON with leading/trailing text", () => {
    const result = parseLlmJson('Here are the collocations:\n[{"phrase":"abundant evidence"}]\nDone.');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ phrase: "abundant evidence" }]);
  });

  it("returns failure for non-JSON", () => {
    const result = parseLlmJson("I cannot generate collocations for this word.");
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.raw).toBe("I cannot generate collocations for this word.");
  });

  it("returns failure for malformed JSON", () => {
    const result = parseLlmJson('[{phrase: "missing quotes"}]');
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
  });

  it("extracts JSON object (not just array)", () => {
    const result = parseLlmJson('{"phrase":"abundant evidence","gloss":"充分证据"}');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ phrase: "abundant evidence", gloss: "充分证据" });
  });
});
```

- [ ] **Step 2: 运行测试看失败**

- [ ] **Step 3: 写实现**

```typescript
// src/llm/parser.ts
/**
 * LLM 响应 JSON 容错解析。
 *
 * LLM 经常不严格遵守"只输出 JSON"的指令——可能包裹在 markdown code block 里，
 * 或前后有解释性文字。这个解析器尝试多种策略提取 JSON。
 */

export interface ParseResult<T = unknown> {
  success: boolean;
  data: T | null;
  raw: string;
}

export function parseLlmJson<T = unknown>(raw: string): ParseResult<T> {
  const trimmed = raw.trim();

  // 策略 1：直接解析
  try {
    return { success: true, data: JSON.parse(trimmed) as T, raw };
  } catch {
    // continue
  }

  // 策略 2：从 markdown code block 提取
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return { success: true, data: JSON.parse(codeBlockMatch[1].trim()) as T, raw };
    } catch {
      // continue
    }
  }

  // 策略 3：提取第一个 JSON 数组或对象
  const jsonArrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (jsonArrayMatch) {
    try {
      return { success: true, data: JSON.parse(jsonArrayMatch[0]) as T, raw };
    } catch {
      // continue
    }
  }

  const jsonObjMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonObjMatch) {
    try {
      return { success: true, data: JSON.parse(jsonObjMatch[0]) as T, raw };
    } catch {
      // continue
    }
  }

  return { success: false, data: null, raw };
}
```

- [ ] **Step 4: 运行测试看通过**

- [ ] **Step 5: Commit**

```bash
git add src/llm/parser.ts tests/llm/parser.test.ts
git commit -m "feat(llm): add parseLlmJson with fallback strategies"
```

---

## Task 6: LLM 用量追踪 + 预算控制（TDD）

**Files:**
- Create: `src/llm/usage-tracker.ts`
- Test: `tests/llm/usage-tracker.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/llm/usage-tracker.test.ts
import { describe, it, expect, vi } from "vitest";

// mock db
vi.mock("@/db/connection", () => ({
  getPool: vi.fn(() => ({
    query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: 10000 }] })  // getDailyUsage
      .mockResolvedValueOnce({ rows: [] }),                  // record
  })),
}));

import { UsageTracker } from "@/llm/usage-tracker";

describe("UsageTracker", () => {
  it("getDailyUsage returns today token count", async () => {
    const tracker = new UsageTracker();
    const usage = await tracker.getDailyUsage();
    expect(usage).toBe(10000);
  });

  it("isOverBudget returns true when over limit", async () => {
    const tracker = new UsageTracker();
    const over = await tracker.isOverBudget(5000);
    expect(over).toBe(true);  // 10000 > 5000
  });

  it("isOverBudget returns false when under limit", async () => {
    const tracker = new UsageTracker();
    const over = await tracker.isOverBudget(50000);
    expect(over).toBe(false);  // 10000 < 50000
  });

  it("record writes usage to DB", async () => {
    const tracker = new UsageTracker();
    await tracker.record("openai", "gpt-4o", 50, 20);
    // 验证 pool.query 被调（INSERT）
    const { getPool } = await import("@/db/connection");
    const mockPool = vi.mocked(getPool).mock.results[0].value;
    expect(mockPool.query).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试看失败**

- [ ] **Step 3: 写实现**

```typescript
// src/llm/usage-tracker.ts
import { getPool } from "@/db/connection";

/**
 * LLM 用量追踪 + 每日预算控制。
 * 防止 API 费用失控。
 */
export class UsageTracker {
  async getDailyUsage(): Promise<number> {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total
       FROM llm_usage
       WHERE created_at >= CURRENT DATE`,
    );
    return Number(rows[0]?.total ?? 0);
  }

  async isOverBudget(dailyLimit: number): Promise<boolean> {
    return (await this.getDailyUsage()) >= dailyLimit;
  }

  async record(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): Promise<void> {
    const pool = getPool();
    await pool.query(
      `INSERT INTO llm_usage (provider, model, prompt_tokens, completion_tokens)
       VALUES ($1, $2, $3, $4)`,
      [provider, model, promptTokens, completionTokens],
    );
  }
}
```

- [ ] **Step 4: 运行测试看通过**

- [ ] **Step 5: typecheck + arch:check**

注意：usage-tracker 在 src/llm/ 目录下，import @/db/connection。检查 arch:check 是否报 llm → db 的违规。如果报了，需要把 usage-tracker 移到 src/db/ 或调整 arch 规则。

**如果 arch:check 报违规**：usage-tracker 本质是 DB 操作（读写 llm_usage 表），应该放 `src/db/llm-usage-tracker.ts` 或 `src/repositories/llm-usage.repository.ts`。移到 repositories 层更符合架构。

- [ ] **Step 6: Commit**

```bash
git add src/llm/usage-tracker.ts tests/llm/usage-tracker.test.ts
git commit -m "feat(llm): add UsageTracker for token counting and budget control"
```

---

## Task 7: LLM prompt 模板（TDD）

**Files:**
- Create: `src/llm/prompts/collocations.ts`
- Create: `src/llm/prompts/examples.ts`
- Create: `src/llm/prompts/synonyms.ts`
- Test: `tests/llm/prompts.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/llm/prompts.test.ts
import { describe, it, expect } from "vitest";
import { buildCollocationPrompt } from "@/llm/prompts/collocations";
import { buildExamplePrompt } from "@/llm/prompts/examples";
import { buildSynonymPrompt } from "@/llm/prompts/synonyms";

const WORD_CONTEXT = {
  lemma: "abundant",
  pos: "adj.",
  semanticField: "自然物理",
  shortDefinition: "大量存在的",
  cefrTarget: "雅思",
};

describe("buildCollocationPrompt", () => {
  it("returns system + user messages", () => {
    const messages = buildCollocationPrompt(WORD_CONTEXT, { count: 2, cefrTarget: "雅思" });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });

  it("system prompt specifies JSON output format", () => {
    const messages = buildCollocationPrompt(WORD_CONTEXT, { count: 2, cefrTarget: "雅思" });
    expect(messages[0].content).toContain("JSON");
    expect(messages[0].content).toContain("phrase");
  });

  it("user prompt contains word + semantic field", () => {
    const messages = buildCollocationPrompt(WORD_CONTEXT, { count: 2, cefrTarget: "雅思" });
    expect(messages[1].content).toContain("abundant");
    expect(messages[1].content).toContain("自然物理");
  });
});

describe("buildExamplePrompt", () => {
  it("returns system + user messages with domain preference", () => {
    const messages = buildExamplePrompt(WORD_CONTEXT, {
      domains: ["科技", "商业"],
      difficulty: "雅思7分",
      count: 1,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("JSON");
    expect(messages[1].content).toContain("科技");
    expect(messages[1].content).toContain("商业");
  });
});

describe("buildSynonymPrompt", () => {
  it("returns system + user messages", () => {
    const messages = buildSynonymPrompt(WORD_CONTEXT, { count: 2 });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("semanticDiff");
    expect(messages[0].content).toContain("tone");
  });
});
```

- [ ] **Step 2: 运行测试看失败**

- [ ] **Step 3: 写实现（3 个文件）**

```typescript
// src/llm/prompts/collocations.ts
import type { LlmMessage } from "../provider";

interface WordContext {
  lemma: string;
  pos: string;
  semanticField: string;
  shortDefinition: string;
  cefrTarget: string;
}

interface CollocationPromptConfig {
  count: number;
  cefrTarget: string;
}

export function buildCollocationPrompt(
  word: WordContext,
  config: CollocationPromptConfig,
): LlmMessage[] {
  return [
    {
      role: "system",
      content: `你是一个英语词汇教学专家。为给定单词生成 ${config.count} 个最值得记忆的搭配。
要求：
- 每个搭配配一句简短例句（来自真实语境，不是编造的）
- 搭配要"高频且考试有用"，不要生僻
- 标注每个搭配的语感（formal/neutral/informal）
- 目标考试级别：${config.cefrTarget}
- 严格只输出 JSON 数组，不要任何解释文字：
[{"phrase":"...","gloss":"中文释义","tone":"formal|neutral|informal","example":"英文例句","exampleTranslation":"中文翻译"}]`,
    },
    {
      role: "user",
      content: `单词：${word.lemma}（${word.pos}）
语义场：${word.semanticField}
核心释义：${word.shortDefinition}`,
    },
  ];
}
```

```typescript
// src/llm/prompts/examples.ts
import type { LlmMessage } from "../provider";

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

export function buildExamplePrompt(
  word: WordContext,
  config: ExamplePromptConfig,
): LlmMessage[] {
  return [
    {
      role: "system",
      content: `你是一个英语词汇教学专家。为给定单词生成 ${config.count} 个例句。
要求：
- 领域偏好：${config.domains.join("、")}
- 难度：${config.difficulty}
- 每句配中文翻译
- 优先使用真实语境（不要教科书式无聊例句，要有信息密度）
- 严格只输出 JSON 数组：
[{"text":"英文例句","translation":"中文翻译","source":"generated"}]`,
    },
    {
      role: "user",
      content: `单词：${word.lemma}（${word.pos}）
语义场：${word.semanticField}
核心释义：${word.shortDefinition}`,
    },
  ];
}
```

```typescript
// src/llm/prompts/synonyms.ts
import type { LlmMessage } from "../provider";

interface WordContext {
  lemma: string;
  pos: string;
  semanticField: string;
  shortDefinition: string;
  cefrTarget: string;
}

interface SynonymPromptConfig {
  count: number;
}

export function buildSynonymPrompt(
  word: WordContext,
  config: SynonymPromptConfig,
): LlmMessage[] {
  return [
    {
      role: "system",
      content: `你是一个英语词汇教学专家。为给定单词生成 ${config.count} 个最值得辨析的近义词。
要求：
- 五维辨析：semanticDiff（语义差异）/ tone（语气）/ usage（用法差异）/ delta（核心区别）/ object（适用对象）
- 严格只输出 JSON 数组：
[{"word":"近义词","semanticDiff":"一句话语义差异","tone":"formal|neutral|informal","usage":"用法差异","delta":"核心区别","object":"适用对象"}]`,
    },
    {
      role: "user",
      content: `单词：${word.lemma}（${word.pos}）
语义场：${word.semanticField}
核心释义：${word.shortDefinition}`,
    },
  ];
}
```

- [ ] **Step 4: 运行测试看通过**

- [ ] **Step 5: Commit**

```bash
git add src/llm/prompts/ tests/llm/prompts.test.ts
git commit -m "feat(llm): add prompt templates for collocations/examples/synonyms"
```

---

## Task 8: word_l2_content 表 + repository（TDD）

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/repositories/l2-content.repository.ts`
- Modify: `src/repositories/interfaces.ts`, `src/repositories/factory.ts`
- Modify: `src/domain/index.ts`
- Test: `tests/repositories/l2-content.test.ts`

- [ ] **Step 1: 在 schema.ts 加 word_l2_content 表**

```typescript
export const wordL2Content = pgTable("word_l2_content", {
  id: uuid("id").primaryKey().defaultRandom(),
  wordId: uuid("word_id").notNull().references(() => words.id, { onDelete: "cascade" }),
  field: text("field").notNull(),  // collocation / corpus / synonym / antonym
  content: jsonb("content").notNull(),
  source: text("source").notNull(),  // 考研 / 雅思 / 作文 / 长难句 / manual / agent:xxx
  sourceRef: uuid("source_ref"),     // 关联 learning_assets.id
  approvedBy: text("approved_by").default("user"),
  approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  isActive: boolean("is_active").default(true).notNull(),
}, (table) => [
  index("idx_l2_content_word_field").on(table.wordId, table.field),
  index("idx_l2_content_source").on(table.source),
]);
```

- [ ] **Step 2: 生成 migration**

```bash
npm run db:generate
```

- [ ] **Step 3: 写 domain 类型 + 接口 + repository + factory 注册**

参照 Phase 2A 的 L2ProgressRepository 模式：
- `L2ContentRow` domain 类型
- `IL2ContentRepository` 接口（insert / findByWord / softDelete / refreshL2Cache）
- `L2ContentRepository` 实现
- factory 注册 l2Content

`refreshL2Cache` 方法：聚合 word_l2_content → 更新 words 的 collocations/corpus_items/synonym_items/antonym_items JSONB 列。

- [ ] **Step 4: 写测试 + 运行看通过**

- [ ] **Step 5: typecheck + arch:check + db:generate 零 diff**

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/repositories/ src/domain/ tests/repositories/l2-content.test.ts drizzle/
git commit -m "feat(db): add word_l2_content table + repository"
```

---

## Task 9: L2ContentService — 扩展闭环（TDD）

**Files:**
- Create: `src/services/l2-content.service.ts`
- Modify: `src/services/index.ts`
- Test: `tests/services/l2-content.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
describe("L2ContentService", () => {
  it("generateDraft calls LLM and returns parsed draft", async () => {
    // mock LlmProvider.generate → 返回 JSON
    // mock UsageTracker.isOverBudget → false
    // 调 generateDraft(word, field='collocation', source='manual')
    // 验证返回 { draft: [...], raw: '...' }
  });

  it("generateDraft returns error when over budget", async () => {
    // mock isOverBudget → true
    // 验证返回 { error: 'OVER_BUDGET' }
  });

  it("generateDraft returns error when LLM fails", async () => {
    // mock provider.generate → throw
    // 验证返回 { error: 'LLM_ERROR', message: '...' }
  });

  it("confirmDraft writes to word_l2_content + refreshes cache + triggers recheck", async () => {
    // mock repos + withTransaction
    // 调 confirmDraft(wordId, field, content, source)
    // 验证 l2Content.insert 被调
    // 验证 refreshL2Cache 被调
    // 验证 markL2StaleForRecheck 被调
  });

  it("confirmDraft is transactional", async () => {
    // 验证 withTransaction 包裹了 insert + refresh + recheck
  });
});
```

- [ ] **Step 2: 实现 L2ContentService**

```typescript
export class L2ContentService {
  constructor(
    private llmProvider: LlmProvider,
    private usageTracker: UsageTracker,
    private l2ContentRepo: L2ContentRepository,
    private l2ProgressRepo: L2ProgressRepository,
    private wordsRepo: WordRepository,
  ) {}

  async generateDraft(word: WordContext, field: string, source: string): Promise<GenerateDraftResult> {
    // 1. 检查预算
    if (await this.usageTracker.isOverBudget(DAILY_TOKEN_LIMIT)) {
      return { error: "OVER_BUDGET" };
    }

    // 2. 选 prompt 模板
    const messages = this.buildPrompt(word, field);

    // 3. 调 LLM
    let result: LlmResult;
    try {
      result = await this.llmProvider.generate(messages, { temperature: 0.7 });
    } catch (err) {
      return { error: "LLM_ERROR", message: (err as Error).message };
    }

    // 4. 记录用量
    await this.usageTracker.record(result.model, result.model, result.promptTokens, result.completionTokens);

    // 5. 解析 JSON
    const parsed = parseLlmJson(result.content);
    if (!parsed.success) {
      return { error: "PARSE_FAILED", raw: result.content };
    }

    return { draft: parsed.data, raw: result.content };
  }

  async confirmDraft(wordId: string, field: string, content: unknown, source: string): Promise<void> {
    return withTransaction(async (tx) => {
      const repos = createRepositories(tx);

      // 1. 写 word_l2_content
      await repos.l2Content.insert({ wordId, field, content, source });

      // 2. 刷新 words JSONB 缓存
      await repos.l2Content.refreshL2Cache(wordId);

      // 3. 重算 l2_content_hash
      const word = await repos.words.findById(wordId);
      const l2Hash = computeL2Hash(word as any);

      // 4. 只触发 L2 重卡（不影响 L1）
      await repos.l2Progress.markL2StaleForRecheck(wordId, l2Hash);
    });
  }
}
```

- [ ] **Step 3: 运行测试看通过**

- [ ] **Step 4: typecheck + arch:check**

- [ ] **Step 5: Commit**

```bash
git add src/services/l2-content.service.ts src/services/index.ts tests/services/l2-content.test.ts
git commit -m "feat(services): add L2ContentService for L2 extension loop"
```

---

## Task 10: L2 HTTP 路由（TDD）

**Files:**
- Create: `src/http/routes/l2.ts`
- Modify: `src/http/server.ts`
- Modify: `src/schemas/http/index.ts`
- Test: `tests/http/l2.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
describe("L2 routes", () => {
  it("POST /api/l2/:slug/draft returns generated draft", async () => {
    // mock services.l2content.generateDraft → { draft: [...] }
    // POST /api/l2/abundant/draft { field: "collocation", source: "manual" }
    // 验证 200 + body.draft
  });

  it("POST /api/l2/:slug/draft returns 503 when over budget", async () => {
    // mock generateDraft → { error: "OVER_BUDGET" }
    // 验证 503
  });

  it("POST /api/l2/:slug/confirm writes and returns 200", async () => {
    // mock confirmDraft → success
    // POST /api/l2/abundant/confirm { field, content, source }
    // 验证 200
  });

  it("rejects invalid field name", async () => {
    // POST with field: "invalid"
    // 验证 400
  });
});
```

- [ ] **Step 2: 写路由 + schema + 挂载**

路由模式参照 review.ts：
- POST /api/l2/:slug/draft — 生成草稿（不写 DB）
- POST /api/l2/:slug/confirm — 确认采纳（写 DB + 刷缓存 + L2 重卡）

zod schema：
```typescript
const l2DraftSchema = z.object({
  field: z.enum(["collocation", "corpus", "synonym", "antonym"]),
  source: z.string().default("manual"),
});

const l2ConfirmSchema = z.object({
  field: z.enum(["collocation", "corpus", "synonym", "antonym"]),
  content: z.unknown(),
  source: z.string().default("manual"),
});
```

- [ ] **Step 3: 运行测试看通过**

- [ ] **Step 4: typecheck + arch:check**

- [ ] **Step 5: Commit**

```bash
git add src/http/routes/l2.ts src/http/server.ts src/schemas/http/index.ts tests/http/l2.test.ts
git commit -m "feat(http): add L2 extension routes (draft + confirm)"
```

---

## Task 11: LLM Provider 工厂 + barrel + server.ts 装配

**Files:**
- Create: `src/llm/index.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: 写工厂**

```typescript
// src/llm/index.ts
export type { LlmProvider, LlmMessage, LlmOptions, LlmResult, LlmProviderConfig } from "./provider";
export { OpenAICompatibleProvider } from "./providers/openai-compatible";
export { AnthropicProvider } from "./providers/anthropic";
export { parseLlmJson } from "./parser";
export { UsageTracker } from "./usage-tracker";
export { buildCollocationPrompt } from "./prompts/collocations";
export { buildExamplePrompt } from "./prompts/examples";
export { buildSynonymPrompt } from "./prompts/synonyms";

import type { LlmProvider, LlmProviderConfig } from "./provider";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import { AnthropicProvider } from "./providers/anthropic";

export function createLlmProvider(config: LlmProviderConfig): LlmProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAICompatibleProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
```

- [ ] **Step 2: 在 server.ts 装配 LLM provider + L2ContentService**

```typescript
// 从环境变量读配置
const llmProvider = createLlmProvider({
  provider: (process.env.LLM_PROVIDER ?? "openai") as "openai" | "anthropic",
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL,
  model: process.env.LLM_MODEL ?? "gpt-4o",
});

const services = createServices({
  fsrsAdapter: applyReviewAnswer,
  loadWeights: loadWordbookWeights,
  llmProvider,
});
```

- [ ] **Step 3: typecheck + arch:check**

- [ ] **Step 4: Commit**

```bash
git add src/llm/index.ts src/server.ts
git commit -m "feat(llm): add createLlmProvider factory + wire into server"
```

---

## Task 12: 全量验收

- [ ] **Step 1: 全量测试**

```bash
npm run verify:check
```

- [ ] **Step 2: arch:check**

```bash
npm run arch:check
```

- [ ] **Step 3: db:generate 零 diff**

```bash
npm run db:generate
```

- [ ] **Step 4: 隔离验证**

L2 扩展后 L1 不受影响：
- generateDraft 不写 DB（只调 LLM + 返回草稿）
- confirmDraft 只写 word_l2_content + 刷 words JSONB + markL2StaleForRecheck
- markL2StaleForRecheck 只改 user_word_l2_progress（不改 user_word_progress）

- [ ] **Step 5: Commit + Phase 2B 完成**

```bash
git add -A
git commit -m "chore: Phase 2B complete - LLM provider + L2 extension loop"
```

---

## 验收 Checklist

- [ ] openai + @anthropic-ai/sdk 已安装
- [ ] LlmProvider 接口 + OpenAICompatibleProvider + AnthropicProvider
- [ ] parseLlmJson 容错解析（6 个测试）
- [ ] UsageTracker 用量追踪 + 预算控制
- [ ] 3 个 prompt 模板（collocations/examples/synonyms）
- [ ] word_l2_content 表 + L2ContentRepository（含 refreshL2Cache）
- [ ] L2ContentService（generateDraft + confirmDraft）
- [ ] L2 路由（POST /api/l2/:slug/draft + /confirm）
- [ ] createLlmProvider 工厂 + server.ts 装配
- [ ] **L1 隔离验证**：confirmDraft 后 user_word_progress 不变
- [ ] **预算控制验证**：超预算时返回 503
- [ ] `npm run verify:check` 全绿
- [ ] `npm run arch:check` 零违规
