import { getPool } from "./connection";
import { logger } from "../observability/logger";

const FSRS_WEIGHTS_MIN_LENGTH = 17;

/**
 * 从 wordbooks.settings jsonb 读取 FSRS weights。
 * 失败时返回 null（回退默认权重），不抛错——weights 是非关键路径。
 */
export async function loadWordbookWeights(
  wordbookId: string,
): Promise<number[] | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT settings->'review'->'fsrs_weights'->'weights' AS weights
       FROM wordbooks WHERE id = $1`,
      [wordbookId],
    );
    const weights = rows[0]?.weights;
    if (!Array.isArray(weights) || weights.length < FSRS_WEIGHTS_MIN_LENGTH) {
      return null;
    }
    return weights;
  } catch (err) {
    logger.warn("weights-loader", "Failed to load FSRS weights", {
      message: (err as Error).message,
      wordbookId,
    });
    return null;
  }
}
