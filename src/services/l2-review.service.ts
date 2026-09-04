/**
 * L2ReviewService —— L2 轨应答内核（双轨 spec §11 漏洞5 / l2-drill spec §六）。
 *
 * submitL2Answer 是独立于 ReviewService.submitAnswer 的入口：progress 表、
 * repo、校验逻辑都不同，但复用同一 fsrsAdapter（传入 L2 的
 * l2_scheduler_payload + l2_desired_retention(0.900) + weights 回退链
 * fsrs_l2_weights → fsrs_weights）。
 *
 * payload 断路读侧兜底（spec §四）：l2_scheduler_payload 缺失/为空时，
 * 从行上权威标量列重建初始卡片，绝不让继承卡退化成 New 卡。
 */

import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type { UserWordL2ProgressRow } from "../domain";
import type {
  IL2ProgressRepository,
  IOutboxRepository,
  ISessionRepository,
  IReviewRepository,
} from "../repositories/interfaces";
import { BusinessRuleError, NotFoundError } from "../errors";
import type { Json, ReviewRating } from "../domain";
import type { FsrsAdapterFn, FsrsScheduling } from "./review.service";
import {
  REVIEW_ANSWER_RECORDED,
  asJson,
  buildReviewAnswerRecordedPayload,
  reviewOutboxDedupeKey,
} from "../outbox/review-answer.event";

export type L2FsrsScheduling = FsrsScheduling;

export type L2FsrsAdapterFn = FsrsAdapterFn;

export interface SubmitL2AnswerInput {
  progressId: string;
  sessionId: string;
  rating: ReviewRating;
  idempotencyKey?: string | null;
  /** 任务证据等附加信息，合并进 review_logs.metadata */
  logMetadata?: Record<string, unknown>;
}

export interface SubmitL2AnswerResult {
  ok: true;
  /** 幂等重放时为既有日志 id；正常路径为本答日志 id */
  reviewLogId: string;
  idempotent?: boolean;
  mappedRating: ReviewRating;
  nextDueAt: string;
  state: string;
}

/** answerWithinTx 需要的最小事务内仓库面。 */
export interface L2TxRepos {
  l2Progress: IL2ProgressRepository;
  reviews: IReviewRepository;
  sessions: ISessionRepository;
  outbox: IOutboxRepository;
}

export class L2ReviewService {
  constructor(
    private readonly deps: {
      fsrsAdapter: L2FsrsAdapterFn;
      loadWeights: (wordbookId: string) => Promise<number[] | null>;
      /** 缺省回退 loadWeights（双轨 spec §十） */
      loadL2Weights?: (wordbookId: string) => Promise<number[] | null>;
    },
  ) {}

  async submitL2Answer(input: SubmitL2AnswerInput, userId: string): Promise<SubmitL2AnswerResult> {
    return withTransaction(
      async (tx) => this.answerWithinTx(createRepositories(tx) as unknown as L2TxRepos, input, userId),
      { actorId: userId },
    );
  }

  async answerWithinTx(
    repos: L2TxRepos,
    input: SubmitL2AnswerInput,
    userId: string,
  ): Promise<SubmitL2AnswerResult> {
    // 1. 幂等检查（共享 checkIdempotency，全局唯一不限 track）
    if (input.idempotencyKey) {
      const existingLogId = await repos.reviews.checkIdempotency(userId, input.idempotencyKey);
      if (existingLogId) {
        return {
          ok: true,
          reviewLogId: existingLogId,
          idempotent: true,
          mappedRating: input.rating,
          nextDueAt: "",
          state: "",
        };
      }
    }

    // 2. 锁定 L2 行（SELECT FOR UPDATE + JOIN words 内容缓存）
    const locked = await repos.l2Progress.findForUpdate(input.progressId, userId);
    if (!locked) {
      throw new NotFoundError("L2 progress", input.progressId);
    }
    const progress = locked.progress;

    // 3. 暂停中的卡不可答
    if (progress.l2_paused) {
      throw new BusinessRuleError("Cannot answer a paused L2 card");
    }

    // 4. 会话归属绑定
    await repos.sessions.assertActiveOwned(input.sessionId, userId, progress.wordbook_id);

    // 5. weights 回退链：fsrs_l2_weights → fsrs_weights → 默认
    let weights: number[] | null = null;
    const loader = this.deps.loadL2Weights ?? this.deps.loadWeights;
    try {
      weights = await loader(progress.wordbook_id);
    } catch {
      weights = null;
    }
    if (weights === null || weights.length === 0) {
      try {
        weights = await this.deps.loadWeights(progress.wordbook_id);
      } catch {
        weights = null;
      }
    }

    // 6. FSRS 调度计算（空 payload 读侧兜底重建，spec §四）
    const payload = rebuildSchedulerPayloadIfEmpty(progress) as Json;
    const now = new Date();
    const scheduling = this.deps.fsrsAdapter(
      payload,
      input.rating,
      now,
      Number(progress.l2_desired_retention),
      weights,
    );

    // 7. 持久化：全 l2_* 字段 + recent_ratings + 计数器 + hash snapshot + review_logs(track='l2')
    const previousSnapshot: Json = {
      l2_stability: progress.l2_stability,
      l2_difficulty: progress.l2_difficulty,
      l2_state: progress.l2_state,
      l2_due_at: progress.l2_due_at,
      recent_ratings: progress.recent_ratings ?? [],
    };
    const contentHashSnapshot =
      progress.l2_content_hash_snapshot ?? `l2:${progress.word_id}:${progress.id}`;
    const { reviewLogId } = await repos.l2Progress.saveL2Answer({
      progressId: progress.id,
      userId,
      wordbookId: progress.wordbook_id,
      wordId: progress.word_id,
      rating: input.rating,
      state: String(scheduling.state),
      stability: scheduling.stability,
      difficulty: scheduling.difficulty,
      retrievability: scheduling.retrievability ?? null,
      dueAt: scheduling.dueAt,
      lastReviewedAt: now.toISOString(),
      intervalDays:
        scheduling.scheduledDays == null ? null : Math.round(Number(scheduling.scheduledDays)),
      scheduledDays: scheduling.scheduledDays == null ? null : Number(scheduling.scheduledDays),
      // H3 修复：传入真实的 elapsed_days（距上次复习的流逝天数），
      // 之前 INSERT 把 scheduledDays 错填到 elapsed_days 列。L1 路径
      // （review.repository.ts）已正确传入 scheduling.elapsedDays，L2 对齐。
      elapsedDays: scheduling.elapsedDays,
      nextPayload: scheduling.nextPayload,
      contentHashSnapshot,
      previousSnapshot,
      logMetadata: {
        ...(input.logMetadata ?? {}),
        track: "l2",
        desired_retention: Number(progress.l2_desired_retention),
        retrievability: scheduling.retrievability,
      },
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    // 8. outbox：worker 'l2' 分支 → checkL2FailureCascade 首次通电；cards_seen 不递增
    const eventPayload = buildReviewAnswerRecordedPayload({
      version: 1,
      reviewLogId,
      progressId: progress.id,
      sessionId: input.sessionId,
      userId,
      wordbookId: progress.wordbook_id,
      wordId: progress.word_id,
      track: "l2",
    });
    await repos.outbox.enqueue({
      aggregateType: "review_log",
      aggregateId: reviewLogId,
      eventType: REVIEW_ANSWER_RECORDED,
      payload: asJson(eventPayload),
      dedupeKey: reviewOutboxDedupeKey(reviewLogId),
    });

    return {
      ok: true,
      reviewLogId,
      mappedRating: input.rating,
      nextDueAt: scheduling.dueAt,
      state: String(scheduling.state),
    };
  }
}

function isUsableSchedulerPayload(payload: unknown): boolean {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const rec = payload as Record<string, unknown>;
  if (!("due" in rec)) return false;
  return !Number.isNaN(new Date(String(rec.due)).getTime());
}

/** spec §四读侧兜底：从行上权威标量列重建初始卡片（state=Review）。 */
export function rebuildSchedulerPayloadIfEmpty(row: UserWordL2ProgressRow): unknown {
  if (isUsableSchedulerPayload(row.l2_scheduler_payload)) {
    return row.l2_scheduler_payload;
  }
  if (!row.l2_due_at) {
    throw new BusinessRuleError("L2 card missing due date and scheduler payload");
  }
  return {
    difficulty: row.l2_difficulty == null ? 5 : Number(row.l2_difficulty),
    due: new Date(row.l2_due_at).toISOString(),
    elapsed_days: 0,
    lapses: 0,
    learning_steps: 0,
    last_review: row.l2_last_reviewed_at ? new Date(row.l2_last_reviewed_at).toISOString() : null,
    reps: Number(row.l2_review_count ?? 0),
    scheduled_days: 0,
    stability: row.l2_stability == null ? 1 : Number(row.l2_stability),
    state: 2, // ts-fsrs State.Review
  };
}
