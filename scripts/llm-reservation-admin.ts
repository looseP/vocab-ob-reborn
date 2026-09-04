import { resetPool } from "../src/db/connection";
import { LlmReservationReaper } from "../src/llm/reservation-reaper";
import { logger } from "../src/observability/logger";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const [command] = process.argv.slice(2);
  const reaper = new LlmReservationReaper();

  if (command === "metrics") {
    console.log(JSON.stringify(await reaper.getMetrics()));
    return;
  }
  if (command === "run-once") {
    console.log(JSON.stringify({ expired: await reaper.processBatch() }));
    return;
  }
  throw new Error("Usage: llm-reservation-admin <metrics|run-once>");
}

main()
  .catch((error) => {
    logger.error("llm-reservation-admin", "Command failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(resetPool);
