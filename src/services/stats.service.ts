/**
 * StatsService — dashboard analytics.
 *
 * Thin service that delegates to StatsRepository for aggregation queries.
 * Adds lightweight business logic (e.g., forecast calculation) on top.
 */

import type { PoolClient } from "pg";
import type { IRepositories, IStatsRepository } from "../repositories/interfaces";
import type {
  DashboardSummary,
  RatingDistribution,
  DueForecastBucket,
  DailyCount,
  DayScope,
  DayWordBrief,
} from "../repositories/interfaces";
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
   * M2（2026-10-08）：日历**未来侧** —— `due_at` 按显示时区日历日分桶。
   * 与 `dueToday` 同一个日历日口径；`state = 'suspended'` 不计（与队列一致）。
   * 同时带回 `todayDate`（显示时区今天键），调用方不用自己算时区。
   */
  async getDailyDueCounts(
    userId: string,
    wordbookId: string,
    days: number,
  ): Promise<{ todayDate: string; buckets: DailyCount[] }> {
    return this.withActorStats(
      userId,
      (stats) => stats.getDailyDueCounts(userId, wordbookId, days),
    );
  }

  /** M2：日历**单日列词**（只读）—— 该日到期 / 该日复习过。 */
  async getDayWords(
    userId: string,
    wordbookId: string,
    date: string,
    scope: DayScope,
    limit: number,
  ): Promise<{ total: number; items: DayWordBrief[] }> {
    return this.withActorStats(
      userId,
      (stats) => stats.getDayWords(userId, wordbookId, date, scope, limit),
    );
  }

  /**
   * 契约的两个预测窗口（`ReviewForecast` 只有这两个字段）。
   */
  static readonly FORECAST_HORIZONS: readonly number[] = [7, 14];

  /**
   * M1（2026-10-07）：真实到期预测 —— 查 `due_at` 的日历日累计桶，再交纯函数组装。
   *
   * 为什么签名里带 `summary`：`dueNow` 沿用调用方已取的 `summary.dueToday`
   * （口径与数值都不变），这样路由只需把同一份 summary 传进来，**不必改结构、也不必
   * 多取一次 summary**（`src/http/routes/review.ts` 受路由棘轮按基线冻结，不能增行）。
   */
  async getForecast(
    summary: DashboardSummary,
    userId: string,
    wordbookId: string,
  ): Promise<ReviewForecast> {
    const buckets = await this.withActorStats(
      userId,
      (stats) => stats.getDueForecast(userId, wordbookId, StatsService.FORECAST_HORIZONS),
    );
    return this.computeForecast(summary, buckets);
  }

  /**
   * 由**真实**到期桶组装预测（纯函数，不打开事务 —— 取数在 `getForecast`）。
   *
   * `dueNow` = `summary.dueToday`；`due7d` / `due14d` = 对应 horizon 的桶计数。
   * 桶缺失按 0 计（查不到行 = 该窗口确实没有到期词）。`buckets` **必填**：
   * 让它有默认值会在调用方漏传时静默给出 0，那正是本轮要消灭的假数字。
   */
  computeForecast(
    summary: DashboardSummary,
    buckets: readonly DueForecastBucket[],
  ): ReviewForecast {
    const atHorizon = (days: number): number =>
      buckets.find((bucket) => bucket.horizonDays === days)?.count ?? 0;
    return {
      dueNow: summary.dueToday,
      due7d: atHorizon(7),
      due14d: atHorizon(14),
    };
  }
}
