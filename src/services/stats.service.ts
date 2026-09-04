/**
 * StatsService — dashboard analytics.
 *
 * Thin service that delegates to StatsRepository for aggregation queries.
 * Adds lightweight business logic (e.g., forecast calculation) on top.
 */

import type { PoolClient } from "pg";
import type { IRepositories, IStatsRepository } from "../repositories/interfaces";
import type { DashboardSummary, RatingDistribution } from "../repositories/interfaces";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

export interface ReviewForecast {
  dueNow: number;
  due7d: number;
  due14d: number;
}

export class StatsService {
  constructor(
    private readonly stats: IStatsRepository,
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  private withActorStats<T>(
    userId: string,
    callback: (stats: IStatsRepository) => Promise<T>,
  ): Promise<T> {
    return this.txRunner(
      async (tx) => callback(this.repositoryFactory(tx).stats),
      { actorId: userId },
    );
  }

  async getDashboardSummary(userId: string, wordbookId: string): Promise<DashboardSummary> {
    return this.withActorStats(
      userId,
      (stats) => stats.getDashboardSummary(userId, wordbookId),
    );
  }

  async getRatingDistribution(
    userId: string,
    wordbookId: string,
    days = 30,
  ): Promise<RatingDistribution> {
    return this.withActorStats(
      userId,
      (stats) => stats.getRatingDistribution(userId, wordbookId, days),
    );
  }

  /**
   * Compute a simple forecast from the dashboard summary.
   * In a full implementation this would query user_word_progress due_at
   * directly, but for now we derive it from dueToday + trackedWords.
   */
  computeForecast(summary: DashboardSummary): ReviewForecast {
    return {
      dueNow: summary.dueToday,
      due7d: Math.round(summary.dueToday * 1.5),
      due14d: Math.round(summary.dueToday * 2),
    };
  }
}
