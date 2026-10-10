/**
 * 复习通道的 query 参数解析（2026-10-10 新学/复习隔离）。
 *
 * **为什么单独成文件**：`routes/review.ts` 受路由复杂度棘轮冻结（见
 * `scripts/verify-route-complexity.ts` 的 ROUTE_COMPLEXITY_BOOTSTRAP_LIMITS），
 * 不许增长。这里承载通道参数的全部解析与边界收敛，路由里只留一行调用。
 *
 * **解析纪律**：入参是不可信字符串，一律走**白名单枚举**解析，不透传进服务层。
 * 未知值回落到 `null`（= 不做通道隔离，保持旧行为）而不是抛错 —— 这是读侧参数，
 * 客户端版本落后时不该让整个复习页打不开。
 */
import type { ReviewQueueChannel } from "@/domain";

/**
 * `channel` → 通道。
 *
 * - `review` / `new`：显式两条通道（互斥且完备，见 domain 的 ReviewQueueChannel）。
 * - 缺省、空串、`all`、未知值 → `null`（混流，旧行为）。
 */
export function parseReviewChannel(raw: string | undefined | null): ReviewQueueChannel | null {
  if (raw === "review") return "review";
  if (raw === "new") return "new";
  return null;
}

/** 新卡配额上限上限值：与 MAX_NEW_CARDS_PER_BATCH 同量级，防止单次新学爆量。 */
export const MAX_NEW_CARDS_LIMIT_CAP = 200;

/**
 * `newCardsLimit` → 单次新词会话的新卡配额；非法/缺省 → `undefined`
 * （交给服务层用通道默认值 new 通道 20 / review 通道不受配额约束）。
 */
export function parseNewCardsLimit(raw: string | undefined | null): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, MAX_NEW_CARDS_LIMIT_CAP);
}