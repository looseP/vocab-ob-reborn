/**
 * L2TransitionService — promotes an L1 (primary FSRS) card into the L2
 * (second-pass) scheduling loop once L1 reaches a stable plateau.
 *
 * Transition conditions:
 *   L1_stability      ≥ 21d
 *   L1_review_count   ≥ 5
 *   L1_last_rating    ∈ {good, easy}
 *   no existing L2 progress  (idempotent)
 *
 * Inherited values:
 *   inherit_ratio = 0.5 × L1_S / (L1_S + 21)
 *   L2_S          = max(L1_S × ratio, 1.0)   ← vuln-1 fix: absolute floor 1.0d
 *   L2_difficulty = min(10, L1_difficulty + 2.0)
 *   L2_state      = 'review'
 *   L2_desired_retention = 0.9               ← decision-1
 *
 * Failure handling:
 *   catch swallows only PG unique-violation (23505) for idempotency;
 *   all other errors are re-thrown.          ← vuln-2 fix
 */

import type { Json } from "../domain";
import type { IL2ProgressRepository } from "../repositories/interfaces";
import { logger } from "../observability/logger";

export interface L1ProgressSnapshot {
  user_id: string;
  /** Wordbook scope — L2 progress is wordbook-scoped in V2, so the idempotency
   *  check and insert must be scoped to (user_id, wordbook_id, word_id). */
  wordbook_id: string;
  word_id: string;
  stability: number | string;
  difficulty: number | string | null;
  review_count: number;
  last_rating: string | null;
}

/**
 * 提前升级（ADR-0018 §3）的 seed 来源：他书最佳 L2 行的一次性快照。
 * 只取 S/D/payload 三个初值；seed ≠ merge——不持续同步、不改写来源行。
 */
export interface L2SeedSource {
  /** 来源 user_word_l2_progress.id（写进 review_log.metadata.seeded_from）。 */
  progressId: string;
  /** 来源词书 id（同上）。 */
  wordbookId: string;
  stability: number | string | null;
  difficulty: number | string | null;
  schedulerPayload: Json | null;
}

const TRANSITION_STABILITY_THRESHOLD = 21;
const TRANSITION_REVIEW_COUNT_THRESHOLD = 5;
const L2_STABILITY_FLOOR = 1.0;
const L2_DIFFICULTY_CEILING = 10;
const L2_DIFFICULTY_INHERIT_DELTA = 2.0;
const TRANSITION_ALLOWED_RATINGS = new Set(["good", "easy"]);
const MS_PER_DAY = 86_400_000;

/**
 * PG timestamp 字符串（如 "2026-09-08 23:33:12.275+00"）→ ISO 8601。
 * 契约里 datetime 字段保持同一形态，前端 new Date() 可直接解析。
 * 导出供 L2ContentService（候选池 createdAt）复用。
 */
export function toIsoNullable(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * P2-6: L2 复习节奏调优 — desired_retention 可通过环境变量调整。
 *
 * 仅作用于 *新创建* 的 L2 progress 行（在 L1→L2 跃迁时写入
 * l2_desired_retention 列）；已存在的行保留其持久化值，需通过 SQL 迁移
 * 调整。设计原点：decision-1 默认 0.9，DB CHECK 强制 [0.900, 0.990]。
 *
 * 调优触发条件：P2-5 监控指标（l2_production_verdict / l2_weak_signal）
 * 显示通过率偏低或弱信号过密时，可上调 retention 至 0.920~0.950 提升记忆
 * 间隔；过松时下调（但不得低于 DB CHECK 下限 0.900）。
 *
 * Bounds enforced: [0.900, 0.990] —— 与 src/db/schema.ts 中
 * user_word_l2_progress.l2_retention_check 完全一致。非法值回退默认 0.9
 * 并 warn，避免 DB INSERT 失败导致跃迁链路中断。
 */
const L2_DESIRED_RETENTION = resolveL2DesiredRetention();

function resolveL2DesiredRetention(): number {
  const raw = process.env.L2_DESIRED_RETENTION;
  if (raw === undefined || raw === "") return 0.9;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0.9 || parsed > 0.99) {
    logger.warn(
      "l2-transition",
      "L2_DESIRED_RETENTION out of bounds [0.900, 0.990]; falling back to 0.9",
      { raw, fallback: 0.9 },
    );
    return 0.9;
  }
  // 与 DB schema 一致：保留 3 位小数（NUMERIC(4,3)）
  const rounded = Math.round(parsed * 1000) / 1000;
  logger.info("l2-transition", "L2_DESIRED_RETENTION configured", { value: rounded });
  return rounded;
}

/** seed 标量 → 正数 number；缺失/非有限/非正数一律 null（回退 L1 派生值）。 */
function toPositiveNumber(value: number | string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** seed 标量 → number；缺失/非有限一律 null（回退 L1 派生值）。 */
function toFiniteNumber(value: number | string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** seed payload 可用性判据：必须含可解析的 due（同 l2-progress 的 payload 兜底判据）。 */
function isUsableSeedPayload(payload: Json | null): payload is Record<string, Json> {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const due = (payload as Record<string, unknown>).due;
  return due != null && !Number.isNaN(new Date(String(due)).getTime());
}

export class L2TransitionService {
  /**
   * @param l2ProgressRepo L2 progress repository. Injected so tests can
   *   substitute a mock; production code passes the real instance from
   *   `createRepositories()`.
   */
  constructor(
    private readonly l2ProgressRepo: IL2ProgressRepository,
    /**
     * Phase F：actor 事务执行器（HTTP 主动晋升入口注入）。user_word_l2_progress
     * 的 INSERT 带 WITH CHECK RLS——裸池写入会被静默拒绝（row-level security）。
     * worker 的实例在自身 actor 事务内构造，单参直调即可，故为可选。
     */
    private readonly txRunner?: <T>(
      run: (repo: IL2ProgressRepository) => Promise<T>,
      opts: { actorId: string },
    ) => Promise<T>,
  ) {}

  /** 用注入的事务执行器（若有）在 actor 上下文里跑 promoteNow 主体。 */
  private runWithActor<T>(progress: L1ProgressSnapshot, run: (repo: IL2ProgressRepository) => Promise<T>): Promise<T> {
    if (this.txRunner) return this.txRunner(run, { actorId: progress.user_id });
    return run(this.l2ProgressRepo);
  }

  /**
   * Evaluate the transition conditions for a single L1 progress snapshot
   * and, if eligible, insert an inherited L2 progress row. Idempotent.
   *
   * @param options.force 主动晋升入口（Phase F）：跳过三条门槛检查，保留
   *   幂等与继承语义（低 S 触底 1.0d floor；自动链路调用方不受影响）。
   */
  async checkAndTransition(progress: L1ProgressSnapshot, options?: { force?: boolean }): Promise<void> {
    const force = options?.force === true;
    const l1S = Number(progress.stability);

    // ── Transition conditions ────────────────────────────────────────────
    if (!force) {
      if (l1S < TRANSITION_STABILITY_THRESHOLD) return;
      if (progress.review_count < TRANSITION_REVIEW_COUNT_THRESHOLD) return;
      if (!TRANSITION_ALLOWED_RATINGS.has(progress.last_rating ?? "")) return;
    }
    // Phase F：worker（无 txRunner，实例本身在 actor 事务内）直调注入 repo；
    // HTTP 主动晋升（有 txRunner）在携带 request.jwt.claim.sub 的事务里执行。
    await this.runWithActor(progress, (repo) => this.transitionInto(repo, progress));
  }

  /**
   * 晋升主体：幂等检查 + 继承算术 + 插入。repo 由调用方决定
   * （worker=tx-scoped 实例；HTTP=actor 事务仓库），本方法不感知连接上下文。
   */
  private async transitionInto(repo: IL2ProgressRepository, progress: L1ProgressSnapshot): Promise<void> {
    const l1S = Number(progress.stability);

    // ── Idempotency check (wordbook-scoped) ──────────────────────────────
    // Same user+word in a DIFFERENT wordbook must NOT block this transition —
    // each wordbook gets its own independent L2 progress row.
    const existing = await repo.findByWordbookWordAndUser(
      progress.user_id,
      progress.wordbook_id,
      progress.word_id,
    );
    if (existing) return;

    // ── Inherited values ─────────────────────────────────────────────────
    // inherit_ratio = 0.5 × L1_S / (L1_S + 21)
    const inheritRatio = (0.5 * l1S) / (l1S + TRANSITION_STABILITY_THRESHOLD);
    // vuln-1 fix: absolute floor of 1.0d
    const l2Stability = Math.max(l1S * inheritRatio, L2_STABILITY_FLOOR);
    const l1Difficulty =
      progress.difficulty == null ? 5 : Number(progress.difficulty);
    const l2Difficulty = Math.min(
      L2_DIFFICULTY_CEILING,
      l1Difficulty + L2_DIFFICULTY_INHERIT_DELTA,
    );
    const l2DueAt = new Date(Date.now() + l2Stability * MS_PER_DAY);

    // 2026-08-24 l2-drill spec §四（payload 断路修复·写侧）：继承行必须携带
    // 初始 StoredSchedulerCard。否则 toCard({}) 因 Invalid Date 返回
    // createEmptyCard()，首次作答会按全新 New 卡调度，继承 S/D 全部丢失。
    const l2_scheduler_payload = {
      difficulty: l2Difficulty,
      due: l2DueAt.toISOString(),
      elapsed_days: 0,
      lapses: 0,
      learning_steps: 0,
      last_review: null,
      reps: 0,
      scheduled_days: l2Stability,
      stability: l2Stability,
      state: 2, // ts-fsrs State.Review —— 继承行天生是天级 review 态
    };

    try {
      await repo.insert({
        user_id: progress.user_id,
        wordbook_id: progress.wordbook_id,
        word_id: progress.word_id,
        l2_stability: l2Stability,
        l2_difficulty: l2Difficulty,
        l2_state: "review",
        l2_desired_retention: L2_DESIRED_RETENTION,
        l2_due_at: l2DueAt.toISOString(),
        l2_inherited_from_l1: true,
        l2_weights_source: "inherited",
        l2_scheduler_payload,
      });
    } catch (err: unknown) {
      // vuln-2 fix: swallow ONLY 23505 (unique violation) for idempotency;
      // re-throw every other error so silent data loss cannot hide here.
      if (err != null && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "23505") {
        logger.warn(
          "l2-transition",
          "L2 transition skipped: progress already exists (23505)",
          {
            userId: progress.user_id,
            wordbookId: progress.wordbook_id,
            wordId: progress.word_id,
          },
        );
        return;
      }
      throw err;
    }
  }

  /**
   * 主动晋升（Phase F）：用户从词条详情页一键晋升，跳过 L1 稳定高原门槛。
   * 幂等：已有 L2 行时直接返回既有到期时间，不重复插入。
   * 继承语义与自动晋升完全一致（ratio/floor/D+2/state=review/DR）。
   */
  async promoteNow(progress: L1ProgressSnapshot): Promise<{
    alreadyPromoted: boolean;
    l2DueAt: string | null;
  }> {
    return this.runWithActor(progress, async (repo) => {
      const existing = await repo.findByWordbookWordAndUser(
        progress.user_id,
        progress.wordbook_id,
        progress.word_id,
      );
      if (existing) {
        return { alreadyPromoted: true, l2DueAt: toIsoNullable(existing.l2_due_at) };
      }
      // 已处于 actor 事务上下文（runWithActor），直接走晋升主体，避免嵌套事务
      await this.transitionInto(repo, progress);
      const row = await repo.findByWordbookWordAndUser(
        progress.user_id,
        progress.wordbook_id,
        progress.word_id,
      );
      return { alreadyPromoted: false, l2DueAt: toIsoNullable(row?.l2_due_at ?? null) };
    });
  }

  /**
   * 提前升级（ADR-0018 §3）：升级工单"完成"的落地入口，用户显式触发。
   *
   * 与 promoteNow 同结构（runWithActor → 幂等预检 → 晋升主体 → 回读），
   * 唯一差异是初值来源：
   *   - seed != null：L2 初值取自他书最佳行（stability / difficulty /
   *     scheduler_payload），provenance 写进 review_log.metadata.seeded_from；
   *   - seed == null：回退 transitionInto 的 L1 继承算术（该词无他书记录）。
   *
   * 取舍（ADR-0018 §3 + ADR-0002 质量护栏）：seed 可能来自停留很久的弱行
   * （S 很小 / D 很高），直接落库会产生"次地板行"——提前升级的 L2 卡比自动
   * 晋升卡更差、due 更密集，与"降低换书成本"的目标相反。因此沿用自动晋升
   * 同一套 L2_STABILITY_FLOOR / L2_DIFFICULTY_CEILING 对 seed 也做钳制：
   * 宁可抬高弱种子，也不让提前升级行跌破自动晋升行的质量地板。
   */
  async promoteWithSeed(
    progress: L1ProgressSnapshot,
    seed: L2SeedSource | null,
  ): Promise<{ alreadyPromoted: boolean; l2DueAt: string | null; seeded: boolean }> {
    return this.runWithActor(progress, async (repo) => {
      const existing = await repo.findByWordbookWordAndUser(
        progress.user_id,
        progress.wordbook_id,
        progress.word_id,
      );
      if (existing) {
        return { alreadyPromoted: true, l2DueAt: toIsoNullable(existing.l2_due_at), seeded: false };
      }
      if (seed) {
        await this.transitionIntoWithSeed(repo, progress, seed);
      } else {
        await this.transitionInto(repo, progress);
      }
      const row = await repo.findByWordbookWordAndUser(
        progress.user_id,
        progress.wordbook_id,
        progress.word_id,
      );
      return {
        alreadyPromoted: false,
        l2DueAt: toIsoNullable(row?.l2_due_at ?? null),
        seeded: seed != null,
      };
    });
  }

  /** seed 版晋升主体：与 transitionInto 同结构，初值改取 seed（含 floor/ceiling 钳制）。 */
  private async transitionIntoWithSeed(
    repo: IL2ProgressRepository,
    progress: L1ProgressSnapshot,
    seed: L2SeedSource,
  ): Promise<void> {
    const l1S = Number(progress.stability);

    const existing = await repo.findByWordbookWordAndUser(
      progress.user_id,
      progress.wordbook_id,
      progress.word_id,
    );
    if (existing) return;

    // L1 派生兜底（seed 字段缺失/非法时使用，与 transitionInto 完全同式）。
    const l1Difficulty = progress.difficulty == null ? 5 : Number(progress.difficulty);
    const inheritRatio = (0.5 * l1S) / (l1S + TRANSITION_STABILITY_THRESHOLD);
    const l1DerivedStability = Math.max(l1S * inheritRatio, L2_STABILITY_FLOOR);

    // floor/ceiling 守卫同样作用于 seed（见方法注释的取舍）。
    const l2Stability = Math.max(
      toPositiveNumber(seed.stability) ?? l1DerivedStability,
      L2_STABILITY_FLOOR,
    );
    const l2Difficulty = Math.min(
      L2_DIFFICULTY_CEILING,
      toFiniteNumber(seed.difficulty) ?? (l1Difficulty + L2_DIFFICULTY_INHERIT_DELTA),
    );
    const l2DueAt = new Date(Date.now() + l2Stability * MS_PER_DAY);

    // 以 seed payload 为基底（保留 reps/lapses/last_review 等经历），但把被钳制
    // 的标量强制写回，保证 payload 与行上 S/D/due 一致（toCard 不退化为 New 卡）。
    const basePayload: Record<string, Json> = {
      difficulty: l2Difficulty,
      due: l2DueAt.toISOString(),
      elapsed_days: 0,
      lapses: 0,
      learning_steps: 0,
      last_review: null,
      reps: 0,
      scheduled_days: l2Stability,
      stability: l2Stability,
      state: 2, // ts-fsrs State.Review —— 继承行天生是天级 review 态
    };
    const l2_scheduler_payload: Json = isUsableSeedPayload(seed.schedulerPayload)
      ? {
          ...basePayload,
          ...seed.schedulerPayload,
          difficulty: l2Difficulty,
          due: l2DueAt.toISOString(),
          scheduled_days: l2Stability,
          stability: l2Stability,
          state: 2,
        }
      : basePayload;

    try {
      const row = await repo.insert({
        user_id: progress.user_id,
        wordbook_id: progress.wordbook_id,
        word_id: progress.word_id,
        l2_stability: l2Stability,
        l2_difficulty: l2Difficulty,
        l2_state: "review",
        l2_desired_retention: L2_DESIRED_RETENTION,
        l2_due_at: l2DueAt.toISOString(),
        // provenance 标记：此行由他书 seed 继承而来。l2_inherited_from_l1 保持
        // true —— 它同样是"未经 L2 作答即诞生"的行，读侧既有不变量不变；
        // l2_weights_source='seeded' 才是 seed 的显式标记（ADR-0018 §3）。
        l2_inherited_from_l1: true,
        l2_weights_source: "seeded",
        l2_scheduler_payload,
      });
      // seed 审计行：只有真正插入时才写；幂等命中（既有行 / 23505）不写。
      await repo.insertL2SeedAuditLog({
        userId: progress.user_id,
        wordId: progress.word_id,
        wordbookId: progress.wordbook_id,
        progressId: row.id,
        seededFromProgressId: seed.progressId,
        seededFromWordbookId: seed.wordbookId,
        state: "review",
        dueAt: l2DueAt.toISOString(),
        stability: l2Stability,
        difficulty: l2Difficulty,
      });
    } catch (err: unknown) {
      if (err != null && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "23505") {
        logger.warn(
          "l2-transition",
          "L2 seeded transition skipped: progress already exists (23505)",
          {
            userId: progress.user_id,
            wordbookId: progress.wordbook_id,
            wordId: progress.word_id,
          },
        );
        return;
      }
      throw err;
    }
  }
}
