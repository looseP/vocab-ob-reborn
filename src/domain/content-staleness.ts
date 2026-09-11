/**
 * 内容陈旧度派生（needs_recheck 懒计算）—— 纯函数、零出向、零 IO、零时间依赖。
 *
 * 背景（ADR-0021）：队列的"重新核对"能力（提权 / 分桶 / 新卡配额排除）早已建好，
 * 但唯一的写时标记写入端（`markStaleForRecheck` / `markL1StaleForRecheck`）没有任何
 * 生产调用方，标记永远拿不到 true。本函数把它改成**读时派生**：零写入，只影响
 * 队列分桶/排序。
 *
 * 判定契约（ADR-0021 §Decision）：
 *   1. 优先比 **L1 专属对**：`words.l1_content_hash` ↔ `progress.l1_content_hash_snapshot`
 *      （两侧都可用时）—— 只有 L1 内容变更才让 L1 卡"重新核对"，符合 ADR-0002 双轨隔离。
 *   2. 否则**降级比全量对**：`words.content_hash` ↔ `progress.content_hash_snapshot`。
 *   3. 被判定的那一对里任一侧缺失（NULL / undefined / 空串）→ 不派生（false）：
 *      新卡 / 未作答的行没有快照，不得被标成"内容已更新"。
 *   4. 派生结果绝不写回 due_at / state / 任何 FSRS 字段（ADR-0004 §6 红线）。
 *
 * 降级原因（P2 跟进项）：运行时没有 `words.l1_content_hash` 的产出链
 * （`computeL1Hash` 在 src/ 零调用），且 `saveAnswer` 把**全量** hash 同时写进两个
 * snapshot 列（`review.repository.ts` 的 `content_hash_snapshot = $11` /
 * `l1_content_hash_snapshot = $11`，$11 = `words.content_hash`），所以第 1 条当前恒
 * 不成立 → 一律走第 2 条全量比对。补齐 L1 hash 产出链（import/精修写入 + 作答改填
 * L1 快照 + 存量回填）后，**同一行代码自动升级为 L1 专属判定，无需改动**。
 */

/** 派生所需的两对 (当前 hash, 进度快照)。 */
export interface ContentStalenessInput {
  /** 词条全量 hash（`words.content_hash`）。 */
  contentHash: string | null | undefined;
  /** 词条 L1 专属 hash（`words.l1_content_hash`）；当前运行时无写入者，恒为空。 */
  l1ContentHash: string | null | undefined;
  /** 进度行的全量快照（`user_word_progress.content_hash_snapshot`）。 */
  contentHashSnapshot: string | null | undefined;
  /** 进度行的 L1 专属快照（`user_word_progress.l1_content_hash_snapshot`）。 */
  l1ContentHashSnapshot: string | null | undefined;
}

/** NULL / undefined / 空串一律视为"不可用"：没有可比对的另一侧就不派生。 */
function isUsableHash(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * 词条内容是否在最近一次作答之后发生了变化（needs_recheck 的派生值）。
 * 同输入恒同输出（无随机、无时间、无 IO）。
 */
export function deriveContentStaleness(input: ContentStalenessInput): boolean {
  // 1. L1 专属对可用 → 只比 L1（L2 内容变更不打扰 L1 卡）。
  if (isUsableHash(input.l1ContentHash) && isUsableHash(input.l1ContentHashSnapshot)) {
    return input.l1ContentHash !== input.l1ContentHashSnapshot;
  }
  // 2. 降级：全量对（L1 + L2）。L2 内容变更在此路径下也会触发 L1 卡的重新核对
  //    —— ADR-0021 §Consequences (a) 明确接受，直到 P2 补齐 L1 hash 产出链。
  if (isUsableHash(input.contentHash) && isUsableHash(input.contentHashSnapshot)) {
    return input.contentHash !== input.contentHashSnapshot;
  }
  // 3. 任一侧缺失（新卡 / 未作答）→ 不派生。
  return false;
}
