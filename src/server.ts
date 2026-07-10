/**
 * Server bootstrap 入口 —— v2 HTTP 服务启动点
 *
 * Phase 0：最小骨架，只提供 /health
 * Phase 1：接线 createServices + 完整 API 路由
 *
 * 跑法：npm run dev（tsx watch src/server.ts）
 */
import { serve } from "@hono/node-server";
import { createApp } from "./http/server";
import { createServices, type FsrsAdapterFn, type FsrsScheduling } from "./services";
import { applyReviewAnswer } from "./fsrs/adapter";
import type { StoredSchedulerCard } from "./fsrs/types";
import { loadWordbookWeights } from "./db/weights-loader";
import { createLlmProvider } from "./llm";
import { UsageTracker } from "./llm/usage-tracker";
import type { LlmProviderConfig } from "./llm/provider";
import { LlmUsageRepository } from "./repositories/llm-usage.repository";
import { DatamuseProvider } from "./dictionary";
import type { DictionaryProvider } from "./dictionary/provider";
import { logger } from "./observability/logger";

const port = parseInt(process.env.PORT ?? "3001", 10);

/**
 * Adapter bridge: ReviewService stores scheduler_payload as Json (jsonb),
 * but applyReviewAnswer expects the structured StoredSchedulerCard shape.
 * The casts are safe — the payload is always written by this same adapter,
 * and SchedulerUpdate is structurally compatible with FsrsScheduling
 * (StoredSchedulerCard lacks only the Json index signature).
 */
const fsrsAdapter: FsrsAdapterFn = (schedulerPayload, rating, now, desiredRetention, weights) =>
  applyReviewAnswer(
    (schedulerPayload ?? null) as StoredSchedulerCard | null,
    rating,
    now,
    desiredRetention,
    weights as readonly number[] | null,
  ) as unknown as FsrsScheduling;

/**
 * LLM provider assembly — optional. Reads provider/model/apiKey/baseURL from
 * env. When LLM_PROVIDER is unset, the L2 draft/confirm routes respond 503.
 */
function buildLlmDeps():
  | { llmProvider: ReturnType<typeof createLlmProvider>; usageTracker: UsageTracker }
  | undefined {
  const provider = process.env.LLM_PROVIDER;
  const model = process.env.LLM_MODEL;
  if (!provider || !model) return undefined;

  const config: LlmProviderConfig = {
    provider: provider as "openai" | "anthropic",
    apiKey: process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL,
    model,
    timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS ?? "30000", 10),
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? "2048", 10),
    maxConcurrency: parseInt(process.env.LLM_MAX_CONCURRENCY ?? "4", 10),
  };

  return {
    llmProvider: createLlmProvider(config),
    // Phase 2B: UsageTracker receives the repository (DB access stays at the
    // repository boundary). The daily budget is read from env inside the
    // tracker by default.
    usageTracker: new UsageTracker(new LlmUsageRepository()),
  };
}

const llmDeps = buildLlmDeps();
if (llmDeps) {
  logger.info("server", `LLM provider configured: ${process.env.LLM_PROVIDER} / ${process.env.LLM_MODEL}`);
} else {
  logger.info("server", "LLM provider not configured — L2 draft/confirm routes will 503");
}

/**
 * Dictionary provider assembly — optional. Currently only Datamuse is wired.
 * Enabled when `DATAMUSE_ENABLED` is truthy ("1"/"true"). The Datamuse API is
 * free and needs no key, so this is the default candidate source for B3's
 * dictionary-grounded collocation drafts. When disabled, collocation drafts
 * return NO_DICTIONARY_CANDIDATES.
 */
function buildDictionaryProvider(): DictionaryProvider | undefined {
  const enabled = process.env.DATAMUSE_ENABLED?.toLowerCase();
  if (enabled === "1" || enabled === "true") {
    logger.info("server", "Dictionary provider configured: Datamuse");
    return new DatamuseProvider();
  }
  logger.info("server", "Dictionary provider not configured — collocation drafts will return NO_DICTIONARY_CANDIDATES");
  return undefined;
}

const dictionaryProvider = buildDictionaryProvider();

const services = createServices({
  fsrsAdapter,
  loadWeights: loadWordbookWeights,
  ...(llmDeps ?? {}),
  ...(dictionaryProvider ? { dictionaryProvider } : {}),
});

const app = createApp(services);

serve({ fetch: app.fetch, port }, (info) => {
  logger.info("server", `v2-http listening on :${info.port}`);
  logger.info("server", `Health check: http://localhost:${info.port}/health`);
});
