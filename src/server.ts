/**
 * Server bootstrap 入口 —— v2 HTTP 服务启动点
 *
 * Phase 0：最小骨架，只提供 /health
 * Phase 1：接线 createServices + 完整 API 路由
 *
 * 跑法：npm run dev（tsx watch src/server.ts）
 */
import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./http/server";
import { createServices, type FsrsAdapterFn, type FsrsScheduling } from "./services";
import { applyReviewAnswer } from "./fsrs/adapter";
import { parseSchedulerPayload, SchedulerPayloadParseError } from "./fsrs/schema";
import type { StoredSchedulerCard } from "./fsrs/types";
import { ValidationError } from "./errors";
import type { Json } from "./domain";
import { loadWordbookWeights } from "./db/weights-loader";
import { checkPoolHealth, resetPool } from "./db/connection";
import { createLlmProvider } from "./llm";
import { UsageTracker } from "./llm/usage-tracker";
import type { LlmProviderConfig } from "./llm/provider";
import { LlmUsageRepository } from "./repositories/llm-usage.repository";
import { DatamuseProvider } from "./dictionary";
import type { DictionaryProvider } from "./dictionary/provider";
import { logger } from "./observability/logger";
import { loadRuntimeConfig } from "./config/runtime";

const config = loadRuntimeConfig();
const port = config.PORT;
const readinessTimeoutMs = config.READINESS_TIMEOUT_MS;
const shutdownGraceMs = config.SHUTDOWN_GRACE_MS;

/**
 * Serialize a structured scheduler card into the Json type used by the
 * persistence layer. The JSON round-trip guarantees a JSON-compatible value,
 * so this is a safe single cast (not an `as unknown as` force-cast).
 */
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

/**
 * Adapter bridge: ReviewService stores scheduler_payload as Json (jsonb).
 * We validate it against the StoredSchedulerCard schema at the boundary so a
 * corrupted payload is rejected with a 422 instead of being silently coerced
 * into a fresh card (which would wipe the learner's scheduling progress).
 * No force-cast crosses the persistence boundary.
 */
const fsrsAdapter: FsrsAdapterFn = (schedulerPayload, rating, now, desiredRetention, weights) => {
  let card: StoredSchedulerCard;
  try {
    card = parseSchedulerPayload(schedulerPayload);
  } catch (err) {
    if (err instanceof SchedulerPayloadParseError) {
      throw new ValidationError(
        "Corrupt scheduler_payload prevented review scheduling",
        "scheduler_payload",
        schedulerPayload,
      );
    }
    throw err;
  }

  const update = applyReviewAnswer(card, rating, now, desiredRetention, weights);

  return {
    difficulty: update.difficulty,
    dueAt: update.dueAt,
    logDueAt: update.logDueAt,
    elapsedDays: update.elapsedDays,
    scheduledDays: update.scheduledDays,
    retrievability: update.retrievability,
    stability: update.stability,
    state: update.state,
    nextPayload: toJson(update.nextPayload),
  };
};

/**
 * LLM provider assembly — optional. Reads provider/model/apiKey/baseURL from
 * env. When LLM_PROVIDER is unset, the L2 draft/confirm routes respond 503.
 */
function buildLlmDeps():
  | { llmProvider: ReturnType<typeof createLlmProvider>; usageTracker: UsageTracker }
  | undefined {
  const provider = config.LLM_PROVIDER;
  const model = config.LLM_MODEL;
  if (!provider || !model) return undefined;

  const providerConfig: LlmProviderConfig = {
    provider,
    apiKey: config.LLM_API_KEY,
    baseURL: config.LLM_BASE_URL,
    model,
    timeoutMs: config.LLM_TIMEOUT_MS,
    maxTokens: config.LLM_MAX_TOKENS,
    maxConcurrency: config.LLM_MAX_CONCURRENCY,
  };

  return {
    llmProvider: createLlmProvider(providerConfig),
    // Phase 2B: UsageTracker receives the repository (DB access stays at the
    // repository boundary). The daily budget is read from env inside the
    // tracker by default.
    usageTracker: new UsageTracker(new LlmUsageRepository()),
  };
}

const llmDeps = buildLlmDeps();
if (llmDeps) {
  logger.info("server", `LLM provider configured: ${config.LLM_PROVIDER} / ${config.LLM_MODEL}`);
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
  if (config.DATAMUSE_ENABLED) {
    logger.info("server", "Dictionary provider configured: Datamuse");
    return new DatamuseProvider();
  }
  logger.info("server", "Dictionary provider not configured — collocation drafts will return NO_DICTIONARY_CANDIDATES");
  return undefined;
}

const dictionaryProvider = buildDictionaryProvider();

const services = createServices({
  fsrsAdapter,
  checkDatabase: () => checkPoolHealth(Math.max(50, readinessTimeoutMs - 50)),
  readinessTimeoutMs,
  loginRateLimitWindowMs: config.LOGIN_RATE_LIMIT_WINDOW_MS,
  loginRateLimitAttempts: config.LOGIN_RATE_LIMIT_ATTEMPTS,
  loadWeights: loadWordbookWeights,
  ...(llmDeps ?? {}),
  ...(dictionaryProvider ? { dictionaryProvider } : {}),
});

const app = createApp(services);
if (config.SERVE_FRONTEND) {
  app.use("/*", serveStatic({ root: "./dist/frontend" }));
  app.get("/*", serveStatic({ root: "./dist/frontend", path: "index.html" }));
}

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info("server", `v2-http listening on :${info.port}`);
  logger.info("server", `Liveness: http://localhost:${info.port}/healthz`);
  logger.info("server", `Readiness: http://localhost:${info.port}/readyz`);
});
const drainableServer = server as HttpServer;

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  services.runtimeStatus.setDraining();
  logger.info("server", "Shutdown requested; readiness disabled", { signal });

  const deadline = setTimeout(() => {
    logger.error("server", "Graceful shutdown deadline exceeded", { signal, shutdownGraceMs });
    process.exitCode = 1;
    drainableServer.closeAllConnections?.();
  }, shutdownGraceMs);
  deadline.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      drainableServer.close((error) => error ? reject(error) : resolve());
      drainableServer.closeIdleConnections?.();
    });
    await resetPool();
    logger.info("server", "Graceful shutdown completed", { signal });
  } catch (error) {
    logger.error("server", "Graceful shutdown failed", {
      signal,
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
