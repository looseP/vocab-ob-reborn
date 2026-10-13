/**
 * 「到期」相关 SQL 谓词的**唯一定义处**（2026-10-13，深度审查收尾轮）。
 *
 * ## 为什么有这个文件
 *
 * 2026-10-12 出过一次事故：仪表盘说「今日待复习 1」而队列「到期 0」，用户以为调度坏了
 * （查库确认调度没问题——那张卡就是今天 15:43 到点）。根因是**同一个概念在多处各写
 * 一遍**，写着写着就漂了。L3 收敛了 `dueToday` 一条，但「到期」家族还有 5 个概念散在
 * review.repository / word.repository 里，口径两两之间仅有「实践上相等」的默契。
 *
 * 这个文件把 5 个概念各定义一次，并写明它们的关系。**改口径改这里**，别在调用点改。
 *
 * ## 5 个概念（按 alias 参数化，因为各查询的表别名不同：uwp. / p.）
 *
 * | 函数 | 含义 | 用在哪 |
 * | --- | --- | --- |
 * | `matureDueSql` | 成熟卡（`state='review'`）且已到期 | 队列「到期」桶、`countQueueBuckets.due` |
 * | `learningSql` | 学习中 / relearning | 队列「学习中」桶、`countQueueBuckets.learning` |
 * | `matureNotDueSql` | 成熟卡但还没到期 | 队列「已掌握」桶、`countQueueBuckets.review` |
 * | `dueNowSql` | **现在就该复习**（= 学习中 + 成熟且已到期） | `getTodayWorkload.dueNow`、广场 due 统计 |
 * | `dueTodaySql` | **日历日**内到期（含今天稍后到点的与更早积压） | `getTodayWorkload.dueToday/laterToday`、`dueWindow=today` facet |
 *
 * ## 两条不变量（测试锁着，改谓词前先想清楚）
 *
 * 1. **`dueNow` = `matureDue` + `learning`**（当没有 `state='review' AND due_at IS NULL`
 *    的卡时严格相等）。真库实测这种卡 0 张；`dueNowSql` 保留 `due_at IS NULL` 分支是
 *    为了与队列「到期」桶逐字一致——那个桶历来把无到期时间的成熟卡当到期。
 * 2. **`dueToday` = `dueNow` + 今天稍后到点的张数**（`tests/repositories/today-workload.test.ts`
 *    与真库交叉校验都锁着）。所以 `dueTodaySql` 与 `dueNowSql` **必须共用同一条状态口径**
 *    (`state NOT IN ('suspended','new')`)——2026-10-12 的数字打脸正是因为两处口径不同。
 *
 * 新卡（`state='new'`）不算「到期」：它还没开始学。挂起词不进队列，也不计入任何口径。
 */

/** 成熟卡（state='review'）且已到期。队列「到期」桶。 */
export function matureDueSql(alias: string): string {
  return `${alias}.state = 'review' AND (${alias}.due_at IS NULL OR ${alias}.due_at <= now())`;
}

/** 学习中 / relearning。队列「学习中」桶。 */
export function learningSql(alias: string): string {
  return `${alias}.state IN ('learning', 'relearning')`;
}

/** 成熟卡但还没到期。队列「已掌握」桶。 */
export function matureNotDueSql(alias: string): string {
  return `${alias}.state = 'review' AND ${alias}.due_at > now()`;
}

/**
 * 现在就该复习：非挂起、非新卡，且已到期（含无到期时间的成熟卡）。
 * = `matureDueSql` + `learningSql` 的并集（见文件头不变量 1）。
 */
export function dueNowSql(alias: string): string {
  return `${alias}.state NOT IN ('suspended', 'new') AND (${alias}.due_at IS NULL OR ${alias}.due_at <= now())`;
}

/**
 * 日历日（Asia/Shanghai）内到期：非挂起、非新卡，`due_at` 非空且早于明天零点。
 * `todayParam` 是「今日零点」的占位符（调用方传 `startOfTodayIsoInDisplayTz()`）。
 *
 * 与 `dueNowSql` 共用同一句状态口径（不变量 2）——**不要**在这里单独写 state 过滤。
 */
export function dueTodaySql(alias: string, todayParam: string): string {
  return `${alias}.state NOT IN ('suspended', 'new') AND ${alias}.due_at IS NOT NULL AND ${alias}.due_at < ${todayParam}::timestamptz + interval '1 day'`;
}
