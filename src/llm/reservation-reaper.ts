import { logger } from "../observability/logger";
import { LlmUsageRepository } from "../repositories/llm-usage.repository";
import type { ILlmUsageRepository, LlmReservationReaperMetrics } from "../repositories/interfaces";

export interface ReservationReaperOptions {
  batchSize: number;
}

export class LlmReservationReaper {
  constructor(
    private readonly repository: ILlmUsageRepository = new LlmUsageRepository(),
    private readonly options: ReservationReaperOptions = { batchSize: 100 },
  ) {
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1_000) {
      throw new Error("LLM reservation reaper batchSize must be an integer between 1 and 1000");
    }
  }

  async processBatch(): Promise<number> {
    const expired = await this.repository.expireReservations(this.options.batchSize);
    if (expired > 0) {
      logger.info("llm-reservation-reaper", "Expired stale LLM reservations", { expired });
    }
    return expired;
  }

  getMetrics(): Promise<LlmReservationReaperMetrics> {
    return this.repository.getReservationMetrics();
  }
}
