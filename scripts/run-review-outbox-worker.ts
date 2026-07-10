import { randomUUID } from "node:crypto";
import { resetPool } from "../src/db/connection";
import { logger } from "../src/observability/logger";
import { ReviewOutboxWorker } from "../src/outbox/review-outbox.worker";

const pollIntervalMs = parsePositiveInt("OUTBOX_POLL_INTERVAL_MS", 1_000, 100, 60_000);
const batchSize = parsePositiveInt("OUTBOX_BATCH_SIZE", 20, 1, 100);
const leaseSeconds = parsePositiveInt("OUTBOX_LEASE_SECONDS", 60, 5, 3_600);
const workerId = process.env.OUTBOX_WORKER_ID ?? `review-outbox-${process.pid}-${randomUUID()}`;

let stopping = false;

function parsePositiveInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const worker = new ReviewOutboxWorker(undefined, { workerId, batchSize, leaseSeconds });
  logger.info("review-outbox", "Worker started", { workerId, batchSize, leaseSeconds, pollIntervalMs });

  while (!stopping) {
    try {
      const processed = await worker.processBatch();
      if (processed === 0) await wait(pollIntervalMs);
    } catch (error) {
      logger.error("review-outbox", "Worker batch failed", {
        workerId,
        error: error instanceof Error ? error.message : String(error),
      });
      await wait(pollIntervalMs);
    }
  }
}

function requestShutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info("review-outbox", "Worker shutdown requested; draining current batch", { workerId, signal });
}

process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGINT", () => requestShutdown("SIGINT"));

main()
  .catch((error) => {
    logger.error("review-outbox", "Worker failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await resetPool();
  });
