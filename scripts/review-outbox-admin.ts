import { z } from "zod";
import { resetPool } from "../src/db/connection";
import { logger } from "../src/observability/logger";
import { OutboxRepository } from "../src/repositories/outbox.repository";

const eventIdSchema = z.string().uuid();

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const [command, rawEventId] = process.argv.slice(2);
  const repository = new OutboxRepository();

  if (command === "metrics") {
    console.log(JSON.stringify(await repository.getMetrics()));
    return;
  }
  if (command === "replay") {
    const eventId = eventIdSchema.parse(rawEventId);
    const replayed = await repository.replayDeadLetter(eventId);
    if (!replayed) throw new Error(`Dead-letter event not found: ${eventId}`);
    logger.info("review-outbox-admin", "Dead-letter event replayed", { eventId });
    return;
  }
  throw new Error("Usage: review-outbox-admin <metrics|replay EVENT_UUID>");
}

main()
  .catch((error) => {
    logger.error("review-outbox-admin", "Command failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  })
  .finally(resetPool);
