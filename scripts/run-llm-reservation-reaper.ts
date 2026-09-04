import { resetPool } from "../src/db/connection";
import { LlmReservationReaper } from "../src/llm/reservation-reaper";
import { logger } from "../src/observability/logger";

const pollIntervalMs = parsePositiveInt("LLM_REAPER_POLL_INTERVAL_MS", 5_000, 100, 300_000);
const batchSize = parsePositiveInt("LLM_REAPER_BATCH_SIZE", 100, 1, 1_000);
let stopping = false;
let wakeWait: (() => void) | undefined;

function parsePositiveInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeWait = undefined;
      resolve();
    }, ms);
    wakeWait = () => {
      clearTimeout(timer);
      wakeWait = undefined;
      resolve();
    };
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const reaper = new LlmReservationReaper(undefined, { batchSize });
  logger.info("llm-reservation-reaper", "Worker started", { batchSize, pollIntervalMs });

  while (!stopping) {
    try {
      const expired = await reaper.processBatch();
      if (expired < batchSize) await wait(pollIntervalMs);
    } catch (error) {
      logger.error("llm-reservation-reaper", "Worker batch failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await wait(pollIntervalMs);
    }
  }
}

function requestShutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  wakeWait?.();
  logger.info("llm-reservation-reaper", "Worker shutdown requested; draining current batch", { signal });
}

process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGINT", () => requestShutdown("SIGINT"));

main()
  .catch((error) => {
    logger.error("llm-reservation-reaper", "Worker failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(resetPool);
