/**
 * L2DrillService —— 「辨析训练」会话编排（l2-drill spec §一/§六）。
 *
 * 队列源 = findDueL2Cards（L2 到期口径），与 L1 队列零耦合。
 * 会话内至多两步：辨析（客观判分，写 L2 轨）→ 达阈后产出（自评，零 FSRS）。
 * 失败是信号不是惩罚：辨析答错即结束，弱信号由 outbox worker 异步评估。
 */

import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type { Json, ReviewRating } from "../domain";
import { noopContextSource, type ContextSnippet, type ContextSource } from "../domain/context-source";
import type { IL2ProgressRepository } from "../repositories/interfaces";
import type { L2VerdictLabel, L3ContextOutcome, Telemetry } from "../observability/telemetry";
import { BusinessRuleError, NotFoundError } from "../errors";
import {
  buildL2ProductionTask,
  generateL2DiscriminationTask,
  judgeL2TaskChoice,
  stripAnswer,
  type L2TaskPayload,
} from "../domain/l2-task";
import {
  L2ReviewService,
  type L2FsrsAdapterFn,
} from "./l2-review.service";

/**
 * M1：L3 语境查询业务超时。L3 查询正常 LIMIT 3 + RLS 索引毫秒级返回；
 * 1.5s 是"慢到必须 fail-fast"的护栏，防止辨析提交的事务行锁被拖长。
 * 超时后参照例句回退 corpus_items，红线语义不变。
 */
const L3_CONTEXT_LOOKUP_TIMEOUT_MS = 1_500;

export interface DrillQueueItem {
  progressId: string;
  stepId: string;
  word: {
    id: string;
    slug: string;
    title: string;
    lemma: string;
    short_definition: string | null;
    pos: string | null;
    ipa: string | null;
    cefr: string | null;
  };
  l2DueAt: string | null;
  l2ReviewCount: number;
  /** true = 辨析不可行，本卡只有产出自评一步 */
  singleStep: boolean;
  task: Omit<L2TaskPayload, "answerIndex">;
}

export interface DrillQueueResult {
  items: DrillQueueItem[];
  session: { id: string; mode: string };
  stats: { total: number; remaining: number };
}

export class L2DrillService {
  private readonly l2Review: L2ReviewService;
  private readonly contextSource: ContextSource;
  /** P2-5: 可选 telemetry，未注入则跳过监控采集（测试默认 noop） */
  private readonly telemetry: Telemetry | null;

  constructor(
    private readonly deps: {
      fsrsAdapter: L2FsrsAdapterFn;
      loadWeights: (wordbookId: string) => Promise<number[] | null>;
      loadL2Weights?: (wordbookId: string) => Promise<number[] | null>;
      defaultLimit?: number;
      /**
       * FR-12 接线2：L3 语境源。默认 noop（不影响任何现有行为）。
       * 注入 L3ContextSourceAdapter 后，产出步的 referenceExample 会优先
       * 取 L3 语境片段，让用户在造句时看到目标词在真实语境中的用法。
       * 红线：只读消费，绝不写 FSRS 字段（spec D7'/ADR-0005）。
       */
      contextSource?: ContextSource;
      /**
       * P2-5: 可选 Prometheus telemetry。生产环境注入全局 telemetry 单例，
       * 采集 L3 命中率/延迟/L2 verdict 真实流量。测试可不注入（默认 null）。
       */
      telemetry?: Telemetry | null;
    },
  ) {
    this.l2Review = new L2ReviewService({
      fsrsAdapter: deps.fsrsAdapter,
      loadWeights: deps.loadWeights,
      loadL2Weights: deps.loadL2Weights,
    });
    this.contextSource = deps.contextSource ?? noopContextSource;
    this.telemetry = deps.telemetry ?? null;
  }

  async getQueue(userId: string, wordbookId: string, limit?: number): Promise<DrillQueueResult> {
    const capped = Math.max(1, Math.min(limit ?? this.deps.defaultLimit ?? 20, 100));
    // 全程单事务 + actorId：RLS 依赖 request.jwt.claim.sub，池直连读不到本用户
    // 行（静默空队列），建步写入也会被拒。读卡与 eager 建步同事务保证一致性。
    return withTransaction(async (tx) => {
      const repos = createRepositories(tx);
      const session = await repos.sessions.getOrCreateToday(userId, wordbookId, "l2_drill");
      const cards = await repos.l2Progress.findDueCards(userId, wordbookId, capped);

      const items: DrillQueueItem[] = [];
      // M8 修复：先扫本会话遗留的 pending 产出步（辨析步已 correct 但产出步未自评），
      // 让前端刷新后能继续走产出。这些步的 progress 已被 FSRS 调度到未来时间，
      // findDueCards 不会返回它们，必须靠 step 表直查补集，否则会 lost-in-session。
      const pendingProduction = await repos.l2Progress.findPendingProductionStepsForResume(
        session.id,
        userId,
      );
      for (const { step, progress, word } of pendingProduction) {
        // paused 卡不应出队（与主循环一致）
        if (progress.l2_paused) continue;
        if (!step.task_payload) continue;
        items.push({
          progressId: progress.id,
          stepId: step.id,
          word: {
            id: word.id,
            slug: word.slug,
            title: word.title,
            lemma: word.lemma,
            short_definition: word.short_definition,
            pos: word.pos,
            ipa: word.ipa,
            cefr: word.cefr,
          },
          l2DueAt: progress.l2_due_at,
          l2ReviewCount: Number(progress.l2_review_count ?? 0),
          // 产出步单独出队，前端只走产出自评这一步
          singleStep: true,
          task: stripAnswer(step.task_payload as unknown as L2TaskPayload),
        });
      }

      for (const card of cards) {
        // M8 修复：若本词已在 pending 产出步补集中出现，跳过重复出队
        // （避免同词既出 pending 产出步又建新辨析步）。
        if (items.some((it) => it.word.id === card.word.id)) continue;
        const task = await this.buildStep0Task(userId, session.id, card.word);
        const step = await repos.l2Progress.insertDrillStepIfAbsent({
          session_id: session.id,
          user_id: userId,
          wordbook_id: card.progress.wordbook_id,
          word_id: card.word.id,
          progress_id: card.progress.id,
          step_index: 0,
          step_type: task.taskType === "production" ? "l2_production" : "l2_discrimination",
          task_id: task.taskId,
          task_type: task.taskType,
          task_payload: task as unknown as Json,
        });
        // 本会话已结算的步（如 again 后间隔到期重现）不再出队，避免
        // "Drill step already settled" 撞到用户脸上。
        if (step.status !== "pending") continue;
        items.push({
          progressId: card.progress.id,
          stepId: step.id,
          word: {
            id: card.word.id,
            slug: card.word.slug,
            title: card.word.title,
            lemma: card.word.lemma,
            short_definition: card.word.short_definition,
            pos: card.word.pos,
            ipa: card.word.ipa,
            cefr: card.word.cefr,
          },
          l2DueAt: card.progress.l2_due_at,
          l2ReviewCount: Number(card.progress.l2_review_count ?? 0),
          singleStep: task.taskType === "production",
          task: stripAnswer(task),
        });
      }

      return {
        items,
        session: { id: session.id, mode: session.mode },
        stats: { total: items.length, remaining: items.length },
      };
    }, { actorId: userId });
  }

  async submitTaskAnswer(
    input: { sessionId: string; stepId: string; choiceIndex: number; idempotencyKey?: string },
    userId: string,
  ): Promise<{
    ok: true;
    // M5 修复：幂等重放命中且原辨析 outcome=correct 时返回产出步入口；
    // 否则按已收尾处理。该路径与正常 correct 分支结构兼容，但缺
    // outcome/mappedRating 等 FSRS 字段（重放不重新跑调度）。
    idempotent?: boolean;
    skipped?: boolean;
    outcome?: "correct" | "incorrect";
    mappedRating?: ReviewRating;
    l2ReviewLogId?: string;
    l2NextDueAt?: string;
    nextStep:
      | { type: "done" }
      | { type: "production"; step: { stepId: string; task: Omit<L2TaskPayload, "answerIndex"> } };
  }> {
    return withTransaction(
      async (tx) => {
        const repos = createRepositories(tx);

        // 幂等：共享 checkIdempotency；重放按已收尾处理。
        // M5 修复：重放命中已结算记录时，需找回原辨析步的 outcome；若为 correct
        // 则查找产出步并返回其任务入口，让前端能继续走产出步。之前重放一律
        // 返回 { type: "done" } 会丢失产出步入口，导致前端卡在辨析反馈页。
        if (input.idempotencyKey) {
          const existing = await repos.reviews.checkIdempotency(userId, input.idempotencyKey);
          if (existing) {
            const discStep = await repos.l2Progress.findDrillStepForUpdate(input.stepId, userId);
            // 辨析步 outcome=correct 才会建产出步；outcome 不存在或不为 correct 直接 done
            if (discStep?.outcome === "correct") {
              const prodStep = await repos.l2Progress.findDrillStepBySessionWordStep(
                input.sessionId,
                userId,
                discStep.word_id,
                1,
              );
              if (prodStep && prodStep.status === "pending" && prodStep.task_payload) {
                return {
                  ok: true as const,
                  idempotent: true as const,
                  nextStep: {
                    type: "production" as const,
                    step: {
                      stepId: prodStep.id,
                      task: stripAnswer(prodStep.task_payload as unknown as L2TaskPayload),
                    },
                  },
                };
              }
            }
            return { ok: true as const, idempotent: true, nextStep: { type: "done" as const } };
          }
        }

        const step = await repos.l2Progress.findDrillStepForUpdate(input.stepId, userId);
        if (!step || step.session_id !== input.sessionId) {
          throw new NotFoundError("Drill step", input.stepId);
        }
        if (step.status !== "pending") {
          throw new BusinessRuleError("Drill step already settled");
        }
        if (step.step_type !== "l2_discrimination") {
          throw new BusinessRuleError("Use self-assessment endpoint for production steps");
        }

        const locked = await repos.l2Progress.findForUpdate(step.progress_id, userId);
        if (!locked) {
          throw new NotFoundError("L2 progress", step.progress_id);
        }

        // 竞态：答题与暂停并发 → 步标 skipped，前端总能收尾（spec §十）
        if (locked.progress.l2_paused) {
          await repos.l2Progress.skipDrillStep(step.id, userId);
          return { ok: true as const, skipped: true, nextStep: { type: "done" as const } };
        }

        const correct = judgeL2TaskChoice(step.task_payload, input.choiceIndex);
        const mappedRating: ReviewRating = correct ? "good" : "again";

        const answer = await this.l2Review.answerWithinTx(
          repos,
          {
            progressId: step.progress_id,
            sessionId: input.sessionId,
            rating: mappedRating,
            idempotencyKey: input.idempotencyKey ?? null,
            logMetadata: {
              mode: "l2_drill",
              step_index: 0,
              taskId: step.task_id,
              taskType: step.task_type,
              outcome: correct ? "correct" : "incorrect",
              choiceIndex: input.choiceIndex,
            },
          },
          userId,
        );

        await repos.l2Progress.completeDrillStep(step.id, userId, {
          outcome: correct ? "correct" : "incorrect",
          mappedRating,
          reviewLogId: answer.reviewLogId,
        });

        if (!correct) {
          return {
            ok: true as const,
            outcome: "incorrect" as const,
            mappedRating,
            l2ReviewLogId: answer.reviewLogId,
            l2NextDueAt: answer.nextDueAt,
            nextStep: { type: "done" as const },
          };
        }

        // 达阈 → 建产出步
        // FR-12 接线2：取 L3 语境片段，让产出步的 referenceExample 优先用 L3 语境
        const contextSnippets = await this.fetchContextSnippets(userId, locked.word.id);
        const production = buildL2ProductionTask({
          sessionId: input.sessionId,
          wordId: locked.word.id,
          stepIndex: 1,
          word: locked.word,
          contextSnippets,
        });
        const prodStep = await repos.l2Progress.insertDrillStepIfAbsent({
          session_id: input.sessionId,
          user_id: userId,
          wordbook_id: locked.progress.wordbook_id,
          word_id: locked.word.id,
          progress_id: locked.progress.id,
          step_index: 1,
          step_type: "l2_production",
          task_id: production.taskId,
          task_type: "production",
          task_payload: production as unknown as Json,
        });

        return {
          ok: true as const,
          outcome: "correct" as const,
          mappedRating,
          l2ReviewLogId: answer.reviewLogId,
          l2NextDueAt: answer.nextDueAt,
          nextStep: {
            type: "production" as const,
            step: { stepId: prodStep.id, task: stripAnswer(production) },
          },
        };
      },
      { actorId: userId },
    );
  }

  async submitSelfAssessment(
    input: { sessionId: string; stepId: string; verdict: "passed" | "weak"; idempotencyKey?: string },
    userId: string,
  ): Promise<{ ok: true; productionStatus: "passed" | "weak" }> {
    return withTransaction(
      async (tx) => {
        const repos = createRepositories(tx);

        // M6 修复：契约 schema 已接受 idempotencyKey，服务层此前未透传导致字段
        // 在响应链路上失真。重放命中幂等记录 → 直接按入参 verdict 返回成功，
        // 不再触达产出步或能力阶段标记（D6' 零 FSRS，重写也是幂等的）。
        if (input.idempotencyKey) {
          const existing = await repos.reviews.checkIdempotency(userId, input.idempotencyKey);
          if (existing) {
            return { ok: true as const, productionStatus: input.verdict };
          }
        }

        const step = await repos.l2Progress.findDrillStepForUpdate(input.stepId, userId);
        if (!step || step.session_id !== input.sessionId) {
          throw new NotFoundError("Drill step", input.stepId);
        }
        if (step.step_type !== "l2_production") {
          throw new BusinessRuleError("Self-assessment applies to production steps only");
        }
        // M6 修复：防御式幂等 —— 步骤已 completed 且 outcome 为 self_passed/self_weak
        // 时，按原 outcome 推出 verdict 返回，而不是抛 BusinessRuleError。
        // 此分支覆盖无 idempotencyKey 的网络重试（前端失忆、跨会话重入等）。
        if (step.status === "completed" && (step.outcome === "self_passed" || step.outcome === "self_weak")) {
          const inferred = step.outcome === "self_passed" ? "passed" : "weak";
          return { ok: true as const, productionStatus: inferred };
        }
        if (step.status !== "pending") {
          throw new BusinessRuleError("Drill step already settled");
        }

        // 零 FSRS 写入（D6'）：只回填步骤 + 能力阶段标记
        await repos.l2Progress.updateProductionStatus(
          userId,
          step.wordbook_id,
          step.word_id,
          input.verdict,
        );
        await repos.l2Progress.completeDrillStep(step.id, userId, {
          outcome: input.verdict === "passed" ? "self_passed" : "self_weak",
        });

        // P2-5 监控：记录产出自评 verdict + 是否带 L3 语境（用于 A/B 质量对比）
        // task_payload 是 JSONB 存的产出步负载，P3-8 后携带 sourceTitle/contextId
        // 字段。无 telemetry 注入时跳过采集（测试默认行为）。
        if (this.telemetry) {
          const payload = step.task_payload as Record<string, unknown> | null;
          const hasL3Context = Boolean(
            payload && (payload.sourceTitle != null || payload.contextId != null),
          );
          this.telemetry.observeL2ProductionVerdict(input.verdict as L2VerdictLabel, hasL3Context);
        }

        return { ok: true as const, productionStatus: input.verdict };
      },
      { actorId: userId },
    );
  }

  async undo(
    sessionId: string,
    userId: string,
    idempotencyKey?: string,
  ): Promise<{ ok: true; idempotent?: boolean }> {
    return withTransaction(
      async (tx) => {
        const repos = createRepositories(tx);

        // M7 修复：撤销幂等。L1 undoReviewLog 通过插审计行 + checkIdempotency
        // 双保险检测重放。此处对齐该模式，避免连点 Undo 触发双重回滚。
        if (idempotencyKey) {
          const existing = await repos.reviews.checkIdempotency(userId, idempotencyKey);
          if (existing) {
            return { ok: true as const, idempotent: true as const };
          }
        }

        const last = await repos.l2Progress.findLastDrillStep(sessionId, userId);
        if (!last) {
          throw new BusinessRuleError("Nothing to undo in this session");
        }
        if (last.status !== "completed") {
          // pending 步无需撤销（用户还没答），直接删
          await repos.l2Progress.deleteDrillStep(last.id, userId);
          return { ok: true as const };
        }

        if (last.step_type === "l2_production") {
          // 产出自评无 FSRS 账目，撤销 = 清标记 + 删步
          await repos.l2Progress.updateProductionStatus(
            userId,
            last.wordbook_id,
            last.word_id,
            null,
          );
          await repos.l2Progress.deleteDrillStep(last.id, userId);
          // 若存在关联产出步则一并清理（辨析步 correct 后建过 step_index=1
          // 的 pending 产出步，但用户撤销辨析步后该步不应再留下）
          await this.cleanupSiblingProductionStep(repos, last, userId);
          // 撤销幂等审计行
          if (idempotencyKey) {
            await repos.l2Progress.insertL2UndoAuditLog({
              userId,
              wordId: last.word_id,
              wordbookId: last.wordbook_id,
              progressId: last.progress_id,
              sessionId,
              reviewLogId: last.review_log_id ?? "",
              restoredState: "l2_production_undo",
              idempotencyKey,
            });
          }
          return { ok: true as const };
        }

        if (last.step_type === "l2_discrimination") {
          // M7 修复：辨析步撤销。撤销 = 回写 L2 progress 快照 + 标 review_log
          // undone + 删 drill step + 删关联产出步（若建过）。比 L1 RPC 更
          // 复杂的是：L2 RPC 硬绑定 user_word_progress 表与 track='l1'，
          // 我们不能复用，只能在应用层对 user_word_l2_progress 做等价回写。
          if (!last.review_log_id) {
            throw new BusinessRuleError(
              "Discrimination step is missing the L2 review log id; cannot undo",
            );
          }
          const logRow = await repos.l2Progress.findReviewLogForL2Undo(
            last.review_log_id,
            userId,
          );
          if (!logRow) {
            throw new BusinessRuleError("L2 review log not found or already undone");
          }
          if (logRow.undone) {
            // 已撤销，幂等返回
            return { ok: true as const, idempotent: true as const };
          }

          // 1) 回写 progress 快照
          const restoredCount = await repos.l2Progress.applyL2UndoSnapshot(
            last.progress_id,
            userId,
            logRow.previousSnapshot,
          );
          if (restoredCount === 0) {
            throw new BusinessRuleError("L2 progress row vanished; cannot undo");
          }
          // 2) 标 review_log undone
          const markedCount = await repos.l2Progress.markL2ReviewLogUndone(
            last.review_log_id,
            userId,
          );
          if (markedCount === 0) {
            throw new BusinessRuleError("L2 review log already undone or not owned");
          }
          // 3) 删辨析 drill step
          await repos.l2Progress.deleteDrillStep(last.id, userId);
          // 4) 删关联 pending 产出步（若建过）
          await this.cleanupSiblingProductionStep(repos, last, userId);
          // 5) 插幂等审计行（与 L1 undoReviewLog 一致：rating=NULL、
          //    metadata={action:'undo', undone_log_id}）
          const restoredState = String(
            (logRow.previousSnapshot as Record<string, unknown> | null)?.l2_state ?? "review",
          );
          await repos.l2Progress.insertL2UndoAuditLog({
            userId,
            wordId: logRow.wordId,
            wordbookId: logRow.wordbookId,
            progressId: last.progress_id,
            sessionId,
            reviewLogId: last.review_log_id,
            restoredState,
            idempotencyKey: idempotencyKey ?? null,
          });

          return { ok: true as const };
        }

        throw new BusinessRuleError(`Undo not supported for step type: ${last.step_type}`);
      },
      { actorId: userId },
    );
  }

  /**
   * M7 辅手：删除与给定 step 同 (session, word) 的 pending 产出步。
   * 仅在撤销辨析步或撤销产出步时调用，避免遗留半截 pending 步。
   * 已 completed 的产出步不动（用户已自评完，不应被撤销链波及）。
   */
  private async cleanupSiblingProductionStep(
    repos: ReturnType<typeof createRepositories>,
    step: { session_id: string; word_id: string; step_index: number; user_id?: string },
    userId: string,
  ): Promise<void> {
    // step_index=0 是辨析步的索引，对应产出步为 1；step_index=1 是产出步，
    // 对应辨析步为 0（但辨析步已 completed 不应被删，所以这里只删 pending）。
    const siblingIndex = step.step_index === 0 ? 1 : 0;
    if (siblingIndex !== 1) return; // 只在撤销辨析步时清理 pending 产出步
    const sibling = await repos.l2Progress.findDrillStepBySessionWordStep(
      step.session_id,
      userId,
      step.word_id,
      siblingIndex,
    );
    if (sibling && sibling.status === "pending") {
      await repos.l2Progress.deleteDrillStep(sibling.id, userId);
    }
  }

  /**
   * FR-12 接线2：best-effort 获取 L3 语境片段（带 source 元数据）。
   * 失败吞掉异常返回 []（不让 L3 故障阻塞 L2 队列建步）。
   *
   * P3-8 扩展：返回 ContextSnippet[]，buildL2ProductionTask 用首条片段的
   * .text 作 referenceExample，附带 .contextId / .sourceTitle 让前端能
   * 渲染来源徽标 + 跳转到 L3 语境编辑器。
   *
   * P2-5 监控：记录 L3 查询的 hit/miss/error + 延迟，注入 telemetry 时生效。
   * 未注入 telemetry 时跳过监控采集（测试默认行为）。
   *
   * M1 修复：业务超时 fail-fast。辨析提交（correct → 建产出步前）在 L2 事务
   * 内持着 l2_progress 的 SELECT FOR UPDATE 行锁，且 L3 独立事务占第二个池
   * 连接——若 L3 慢查询无超时，行锁持有期会被拖到分钟级、连接被无谓占用。
   * 1.5s 封顶后将错误计入 telemetry{outcome=error} 并以 [] 回退（参照例句
   * 回到 corpus_items，语义不变）。
   */
  private async fetchContextSnippets(userId: string, wordId: string): Promise<ContextSnippet[]> {
    const lookup = this.contextSource.getContextSnippets({ userId, wordId });
    // M1：超时后 lookup 仍可能在途（pg 查询无法取消）——挂 noop catch 吞掉
    // 在途拒绝，避免 Promise.race 产生 unhandled rejection。
    lookup.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("L3 context lookup timed out")),
        L3_CONTEXT_LOOKUP_TIMEOUT_MS,
      );
    });
    try {
      if (!this.telemetry) {
        try {
          return await Promise.race([lookup, guard]);
        } catch {
          return [];
        }
      }
      const startedAtMs = Date.now();
      try {
        const snippets = await Promise.race([lookup, guard]);
        const outcome: L3ContextOutcome = snippets.length > 0 ? "hit" : "miss";
        this.telemetry.observeL3ContextLookup(outcome, (Date.now() - startedAtMs) / 1000);
        return snippets;
      } catch {
        this.telemetry.observeL3ContextLookup("error", (Date.now() - startedAtMs) / 1000);
        return [];
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Step-0 任务生成：辨析不可行 → 单步降级为产出自评（spec §一分支矩阵）。
   * FR-12 接线2：async 因为降级路径需要查 L3 语境片段传给 production 生成器。
   *
   * H2 修复：辨析题（cloze/synonym）完全不消费 contextSnippets —— 先尝试
   * 生成辨析题，只有降级为 production 时才拉取 L3。之前每次 getQueue 对每张
   * 卡都 fetch L3，纯属浪费查询 + 把 `l3_context_hits_total{outcome="miss"}`
   * 分母被队列浏览放大（P2-5 命中率监控失真）。
   */
  private async buildStep0Task(
    userId: string,
    sessionId: string,
    word: { id: string } & Parameters<typeof generateL2DiscriminationTask>[0]["word"],
  ): Promise<L2TaskPayload> {
    // 1) 辨析生成不依赖 L3 语境，先走（零额外查询）
    const discrimination = generateL2DiscriminationTask({
      sessionId,
      wordId: word.id,
      stepIndex: 0,
      word,
    });
    if (discrimination) return discrimination;
    // 2) 辨析不可行 → 降级单步产出自评，此时才查 L3 语境富化参照例句
    const contextSnippets = await this.fetchContextSnippets(userId, word.id);
    return buildL2ProductionTask({
      sessionId,
      wordId: word.id,
      stepIndex: 0,
      word,
      contextSnippets,
    });
  }
}
