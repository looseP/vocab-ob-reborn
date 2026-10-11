/**
 * DailyCaptureService — 每日捕获（2026-10-10，M1 捕获侧）。
 *
 * 职责（设计定稿 §3 三段节奏）：**只管「先记录」**——秒级追加、零查询等待、
 * 不做任何整理。回顾复盘（M2）与 agent 吸收（M3，proposal-only）另行接线。
 *
 * - 条目是唯一真相；「一天一文件」由 domain 纯函数按 (entry_date, seq)
 *   确定性投影，getDayFile 随时可重生成。
 * - 类型注册表懒 seed：首条追加时幂等落 seed 六类（phrase/sentence/method/
 *   question/idea/note）；`GET /types` **零写**（回空即回空，前端有内置兜底）。
 * - 时区口径：entry_date 缺省 = 显示时区（Asia/Shanghai）今天，与复习日历/
 *   连胜同源（src/db/timezone.ts，经仓储层 re-export——services 禁 import db/*）。
 *
 * 事务：两表均 owner-RLS，一个方法 = 一个事务（withTransaction + actorId）。
 */

import type { PoolClient } from "pg";
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from "../errors";
import { withTransaction } from "../db/transaction";
import { createRepositories } from "../repositories/factory";
import type { IRepositories } from "../repositories/interfaces";
import { formatEntryClock, todayEntryDateKey } from "../repositories/daily-capture.repository";
import { buildL3TrioInputs } from "./l3-trio";
import { L1_DEFAULT_DESIRED_RETENTION } from "./review.service";
import {
  REVIEW_CARD_ENQUEUED,
  buildReviewCardEnqueuedPayload,
  enqueuePayloadAsJson,
  reviewCardEnqueuedDedupeKey,
} from "../outbox/review-card-enqueued.event";
import type { WordRow } from "../domain";
import type { Json } from "../domain";
import {
  canTransitionEntryStatus,
  DAILY_CAPTURE_ABSORB_ACTIONS,
  CUSTOM_TYPE_DEFAULT_HINT,
  DAILY_CAPTURE_VISIBLE_TYPE_CAP,
  renderDailyCaptureFile,
  type DailyCaptureAbsorbAction,
  type DailyCaptureAbsorptionReceipt,
  type DailyCaptureDaySummary,
  type DailyCaptureEntryMeta,
  type DailyCaptureEntryRow,
  type DailyCaptureEvidencePack,
  type DailyCaptureTypeRow,
} from "../domain/daily-capture";

type TxRunner = typeof withTransaction;
type RepositoryFactory = (tx?: PoolClient) => IRepositories;

const ENTRY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** seq 唯一索引并发兜底重试上限（单用户场景近乎不可达，防御性一次即可）。 */
const SEQ_RETRY_LIMIT = 2;

export interface DailyCaptureAppendInput {
  userId: string;
  /** 类型注册表 key（未知类型 → 422 UNKNOWN_ENTRY_TYPE）。 */
  entryType: string;
  content: string;
  meta?: DailyCaptureEntryMeta | null;
  /** 缺省 = 显示时区今天（YYYY-MM-DD）。 */
  entryDate?: string;
}

export interface DailyCaptureAbsorbInput {
  userId: string;
  id: string;
  action: DailyCaptureAbsorbAction;
  wordSlug?: string;
  payload?: { contextText?: string; translation?: string; sourceUrl?: string };
  reason?: string;
  /** add_word / enqueue_review 必填（路由缺省解析默认词书）。 */
  wordbookId?: string;
}

export class DailyCaptureService {
  constructor(
    private readonly txRunner: TxRunner = withTransaction,
    private readonly repositoryFactory: RepositoryFactory = createRepositories,
  ) {}

  /** 追加一条（缺省落今天；类型未知 422）。返回完整行（含分配的 seq）。 */
  async appendEntry(input: DailyCaptureAppendInput): Promise<DailyCaptureEntryRow> {
    const content = input.content.trim();
    if (!content) {
      throw new ValidationError("content must not be empty", "content");
    }
    const entryType = input.entryType.trim();
    if (!entryType || entryType.length > 40) {
      throw new ValidationError("entryType must be 1..40 characters", "entryType");
    }
    const entryDate = input.entryDate ?? todayEntryDateKey();
    if (!ENTRY_DATE_PATTERN.test(entryDate)) {
      throw new ValidationError("entryDate must be YYYY-MM-DD", "entryDate");
    }

    // seq 由 INSERT..SELECT 原子分配；唯一索引冲突时**重开事务**重试
    //（Postgres 在 23505 后 abort 当前事务，同事务内重试必然失败）。
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.txRunner(
          async (tx) => {
            const repos = this.repositoryFactory(tx);
            // 同事务先幂等 seed（首条追加即注册表就位），再校验类型。
            await repos.dailyCapture.ensureDefaultTypes(input.userId);
            const types = await repos.dailyCapture.listTypes(input.userId);
            const known = types.some((type) => type.type_key === entryType && !type.hidden);
            if (!known) {
              throw new BusinessRuleError(`unknown daily capture entry type "${entryType}"`);
            }
            return repos.dailyCapture.insertEntry({
              user_id: input.userId,
              entry_date: entryDate,
              entry_type: entryType,
              content,
              meta: (input.meta ?? null) as Record<string, unknown> | null,
            });
          },
          { actorId: input.userId },
        );
      } catch (error) {
        if (
          attempt < SEQ_RETRY_LIMIT - 1 &&
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === "23505"
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  /** 类型注册表（零写；未 seed 过返回空数组，前端有内置兜底）。 */
  async listTypes(userId: string): Promise<DailyCaptureTypeRow[]> {
    return this.txRunner(
      async (tx) => this.repositoryFactory(tx).dailyCapture.listTypes(userId),
      { actorId: userId },
    );
  }

  /** 日期流聚合（近 N 天，按日倒序）。 */
  async listDays(userId: string, limit: number): Promise<DailyCaptureDaySummary[]> {
    return this.txRunner(
      async (tx) => this.repositoryFactory(tx).dailyCapture.listDaySummaries(userId, limit),
      { actorId: userId },
    );
  }

  /** 当日条目 + 类型注册表（渲染/复盘面数据源）。 */
  async getDay(
    userId: string,
    entryDate: string,
  ): Promise<{ date: string; types: DailyCaptureTypeRow[]; entries: DailyCaptureEntryRow[] }> {
    if (!ENTRY_DATE_PATTERN.test(entryDate)) {
      throw new ValidationError("entryDate must be YYYY-MM-DD", "entryDate");
    }
    return this.txRunner(
      async (tx) => {
        const repos = this.repositoryFactory(tx);
        const [types, entries] = await Promise.all([
          repos.dailyCapture.listTypes(userId),
          repos.dailyCapture.listDay(userId, entryDate),
        ]);
        return { date: entryDate, types, entries };
      },
      { actorId: userId },
    );
  }

  /** 当日文件投影（确定性；同输入恒同输出）。 */
  async getDayFile(userId: string, entryDate: string): Promise<{ date: string; markdown: string }> {
    const { date, types, entries } = await this.getDay(userId, entryDate);
    return { date, markdown: renderDailyCaptureFile({ date, types, entries, formatClock: formatEntryClock }) };
  }

  // ── M2 回顾面：状态流转 + 置要（§14 拍板①：置要落 meta.important）────────

  /**
   * 回顾动作：status 前向流转（raw→reviewed|archived；reviewed→absorbed|archived；
   * absorbed/archived 终态，同状态 = 幂等 no-op）+ important 独立开关（meta.important，
   * false 时摘除键保持 meta 干净）。archived 行不可再改。
   */
  async patchEntry(
    userId: string,
    id: string,
    input: { status?: DailyCaptureEntryRow["status"]; important?: boolean },
  ): Promise<DailyCaptureEntryRow> {
    if (input.status === undefined && input.important === undefined) {
      throw new ValidationError("nothing to patch: provide status or important", "status");
    }
    return this.txRunner(
      async (tx) => {
        const repos = this.repositoryFactory(tx);
        const entry = await repos.dailyCapture.findEntry(userId, id);
        if (!entry) throw new NotFoundError("Daily capture entry", id);
        if (input.status !== undefined && !canTransitionEntryStatus(entry.status, input.status)) {
          throw new BusinessRuleError(
            `cannot transition entry status ${entry.status} → ${input.status} (archived/absorbed are terminal)`,
          );
        }
        let meta: Record<string, unknown> | undefined;
        if (input.important !== undefined) {
          const base = (entry.meta ?? {}) as Record<string, unknown>;
          if (input.important) {
            meta = { ...base, important: true };
          } else {
            const { important: _dropped, ...rest } = base;
            meta = rest;
          }
        }
        const updated = await repos.dailyCapture.updateEntryFields(userId, id, {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(meta !== undefined ? { meta } : {}),
        });
        if (!updated) throw new NotFoundError("Daily capture entry", id);
        return updated;
      },
      { actorId: userId },
    );
  }

  // ── M3 吸收侧：证据包导出 + proposal-only 采纳执行（§9）────────────────────

  /**
   * 证据包（agent 唯一读面）：markdown（人读）+ 结构化条目（机器读，含稳定 ID
   * `[#seq]`、类型 absorption_hint、关联词释义快照与既有语境计数）。
   * 未入库词不进 words 数组（提案 add_word 会被 422 拦下——先入本再吸收）。
   */
  async getEvidencePack(userId: string, entryDate: string): Promise<DailyCaptureEvidencePack> {
    const { date, types, entries } = await this.getDay(userId, entryDate);
    const markdown = renderDailyCaptureFile({ date, types, entries, formatClock: formatEntryClock });
    const typeByKey = new Map(types.map((t) => [t.type_key, t] as const));
    const slugSet = new Set<string>();
    for (const entry of entries) {
      for (const slug of entry.meta?.wordSlugs ?? []) slugSet.add(slug);
    }
    return this.txRunner(
      async (tx) => {
        const repos = this.repositoryFactory(tx);
        const wordBySlug = new Map<string, {
          slug: string; title: string; lemma: string; ipa: string | null;
          short_definition: string | null; existing_context_count: number;
        }>();
        for (const slug of slugSet) {
          const row = await repos.words.findBySlug(slug);
          if (!row) continue;
          wordBySlug.set(slug, {
            slug,
            title: row.title,
            lemma: row.lemma,
            ipa: row.ipa,
            short_definition: row.short_definition,
            existing_context_count: await repos.l3Context.countWordOccurrences(userId, row.id),
          });
        }
        return {
          version: 1 as const,
          date,
          markdown,
          entries: entries.map((entry) => ({
            seq: entry.seq,
            id: entry.id,
            entry_type: entry.entry_type,
            label: typeByKey.get(entry.entry_type)?.label ?? null,
            absorption_hint: typeByKey.get(entry.entry_type)?.absorption_hint ?? null,
            content: entry.content,
            status: entry.status,
            meta: entry.meta,
            created_at: entry.created_at,
            words: (entry.meta?.wordSlugs ?? [])
              .map((slug) => wordBySlug.get(slug))
              .filter((w): w is NonNullable<typeof w> => w != null),
          })),
        };
      },
      { actorId: userId },
    );
  }

  /**
   * 采纳一条提案并执行（proposal-only 的「执行」半边）：
   *  - bind_l3：同句同词判重（§12-⑥）→ 命中走 deduped 回执；未命中复用
   *    buildL3TrioInputs 写三件套（与 capture 同管道，同事务）；
   *  - add_word：加入词书（wordbookId 由路由缺省解析默认词书）；
   *  - enqueue_review：insertNewCard 原子幂等（duplicate = deduped 回执），
   *    inserted 时同事务补 review.card.enqueued outbox（与 enqueueCard 全同）；
   *  - file_method / rewrite：提案留档（回执即留档），无写入目标；
   *  - none：无需处理 → 归档。
   * 成功后条目置 absorbed（none 置 archived），写 absorption 回执。
   */
  async absorbEntry(input: DailyCaptureAbsorbInput): Promise<{
    entry: DailyCaptureEntryRow;
    receipt: DailyCaptureAbsorptionReceipt;
  }> {
    if (!DAILY_CAPTURE_ABSORB_ACTIONS.includes(input.action)) {
      throw new ValidationError(`unknown absorb action "${input.action}"`, "action");
    }
    const wordSlug = input.wordSlug?.trim();
    const needsWord = input.action === "bind_l3" || input.action === "add_word" || input.action === "enqueue_review";
    if (needsWord && !wordSlug) {
      throw new ValidationError(`action "${input.action}" requires wordSlug`, "wordSlug");
    }
    if (input.action === "bind_l3" && !(input.payload?.contextText ?? "").trim()) {
      throw new ValidationError('action "bind_l3" requires payload.contextText', "payload.contextText");
    }
    if ((input.action === "add_word" || input.action === "enqueue_review") && !input.wordbookId) {
      throw new ValidationError(`action "${input.action}" requires wordbookId`, "wordbookId");
    }

    return this.txRunner(
      async (tx) => {
        const repos = this.repositoryFactory(tx);
        const entry = await repos.dailyCapture.findEntry(input.userId, input.id);
        if (!entry) throw new NotFoundError("Daily capture entry", input.id);
        if (entry.status === "absorbed") {
          throw new ConflictError("entry already absorbed");
        }
        if (entry.status === "archived") {
          throw new BusinessRuleError("archived entries cannot be absorbed");
        }
        let word: WordRow | null = null;
        if (wordSlug) {
          word = await repos.words.findBySlug(wordSlug, { allowAlias: true });
          if (!word) throw new BusinessRuleError(`word "${wordSlug}" is not in the library`);
        }

        const receipt: DailyCaptureAbsorptionReceipt = {
          action: input.action,
          target: null,
          id: null,
          at: new Date().toISOString(),
          word_slug: wordSlug ?? null,
        };
        let nextStatus: DailyCaptureEntryRow["status"] = "absorbed";

        switch (input.action) {
          case "bind_l3": {
            const contextText = input.payload!.contextText!.trim();
            const existing = await repos.l3Context.findWordContextIdByText(input.userId, word!.id, contextText);
            if (existing) {
              receipt.target = "l3_context";
              receipt.id = existing.id;
              receipt.deduped = true;
            } else {
              const trio = buildL3TrioInputs({
                userId: input.userId,
                wordId: word!.id,
                lemma: word!.lemma,
                sentence: contextText,
                sourceUrl: input.payload?.sourceUrl,
              });
              const source = await repos.l3Context.createSource({
                ...trio.source,
                metadata: trio.source.metadata as Json,
              });
              const context = await repos.l3Context.createContext({
                ...trio.context,
                source_id: source.id,
                metadata: trio.context.metadata as Json,
                position: trio.context.position as Json,
              });
              await repos.l3Context.createOccurrence({
                ...trio.occurrence,
                context_id: context.id,
                evidence: trio.occurrence.evidence as Json,
              });
              receipt.target = "l3_context";
              receipt.id = context.id;
            }
            break;
          }
          case "add_word": {
            await repos.wordbooks.addWords(input.wordbookId!, [word!.id]);
            receipt.target = "wordbook";
            receipt.id = input.wordbookId!;
            break;
          }
          case "enqueue_review": {
            const outcome = await repos.reviews.insertNewCard({
              userId: input.userId,
              wordId: word!.id,
              wordbookId: input.wordbookId!,
              desiredRetention: L1_DEFAULT_DESIRED_RETENTION,
            });
            if (outcome.status === "inserted" && outcome.progressId) {
              await repos.outbox.enqueue({
                aggregateType: "user_word_progress",
                aggregateId: outcome.progressId,
                eventType: REVIEW_CARD_ENQUEUED,
                payload: enqueuePayloadAsJson(
                  buildReviewCardEnqueuedPayload({
                    version: 1,
                    progressId: outcome.progressId,
                    userId: input.userId,
                    wordbookId: input.wordbookId!,
                    wordId: word!.id,
                  }),
                ),
                dedupeKey: reviewCardEnqueuedDedupeKey(outcome.progressId),
              });
              receipt.target = "review_card";
              receipt.id = outcome.progressId;
            } else {
              // duplicate（已在队列）/ word_not_found 等不可能（词已解析）——deduped 收尾
              receipt.target = "review_card";
              receipt.id = null;
              receipt.deduped = true;
            }
            break;
          }
          case "file_method":
          case "rewrite":
            // 提案留档：回执记录提案本身（target 为空），条目置 absorbed。
            break;
          case "none":
            // 无需处理 = 处理完归档。
            nextStatus = "archived";
            break;
        }

        const updated = await repos.dailyCapture.appendAbsorption(input.userId, input.id, receipt, nextStatus);
        if (!updated) {
          // 并发重复采纳：读回当前行，已终态则按幂等收尾。
          const current = await repos.dailyCapture.findEntry(input.userId, input.id);
          if (current && (current.status === "absorbed" || current.status === "archived")) {
            return { entry: current, receipt: { ...receipt, deduped: true } };
          }
          throw new NotFoundError("Daily capture entry", input.id);
        }
        return { entry: updated, receipt };
      },
      { actorId: input.userId },
    );
  }

  // ── M2 类型管理：自定义扩展（§14「6 内置 + 用户自定义」）────────────────────

  /** 新建自定义类型。key 冲突 409；可见总数超上限 422（seed 先行，保证上限含内置）。 */
  async createType(
    userId: string,
    input: { typeKey: string; label: string; absorptionHint?: string; sort?: number },
  ): Promise<DailyCaptureTypeRow> {
    const typeKey = input.typeKey.trim();
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(typeKey)) {
      throw new ValidationError("typeKey must match ^[a-z][a-z0-9-]{0,39}$", "typeKey");
    }
    const label = input.label.trim();
    if (!label || label.length > 12) {
      throw new ValidationError("label must be 1..12 characters", "label");
    }
    return this.txRunner(
      async (tx) => {
        const repos = this.repositoryFactory(tx);
        await repos.dailyCapture.ensureDefaultTypes(userId);
        if (await repos.dailyCapture.findTypeByKey(userId, typeKey)) {
          throw new ConflictError(`daily capture type "${typeKey}" already exists`);
        }
        const visible = await repos.dailyCapture.countVisibleTypes(userId);
        if (visible >= DAILY_CAPTURE_VISIBLE_TYPE_CAP) {
          throw new BusinessRuleError(
            `visible type cap reached (${DAILY_CAPTURE_VISIBLE_TYPE_CAP}) — hide unused types first`,
          );
        }
        const types = await repos.dailyCapture.listTypes(userId);
        const maxSort = types.reduce((max, type) => Math.max(max, type.sort), 0);
        return repos.dailyCapture.insertType({
          user_id: userId,
          type_key: typeKey,
          label,
          absorption_hint: input.absorptionHint?.trim() || CUSTOM_TYPE_DEFAULT_HINT,
          sort: input.sort ?? maxSort + 1,
        });
      },
      { actorId: userId },
    );
  }

  /**
   * 更新类型（改名/提示/排序/隐藏）。内置 key 同样走这里（可改名、可隐藏，不可删）；
   * hidden=false 时若超出可见上限 → 422。
   */
  async patchType(
    userId: string,
    typeKey: string,
    input: { label?: string; absorptionHint?: string; sort?: number; hidden?: boolean },
  ): Promise<DailyCaptureTypeRow> {
    if (input.label !== undefined) {
      const label = input.label.trim();
      if (!label || label.length > 12) {
        throw new ValidationError("label must be 1..12 characters", "label");
      }
    }
    if (input.sort !== undefined && (input.sort < 0 || input.sort > 99)) {
      throw new ValidationError("sort must be 0..99", "sort");
    }
    return this.txRunner(
      async (tx) => {
        const repos = this.repositoryFactory(tx);
        const existing = await repos.dailyCapture.findTypeByKey(userId, typeKey);
        if (!existing) throw new NotFoundError("Daily capture type", typeKey);
        if (input.hidden === false && existing.hidden) {
          const visible = await repos.dailyCapture.countVisibleTypes(userId);
          if (visible >= DAILY_CAPTURE_VISIBLE_TYPE_CAP) {
            throw new BusinessRuleError(
              `unhiding would exceed visible type cap (${DAILY_CAPTURE_VISIBLE_TYPE_CAP})`,
            );
          }
        }
        const updated = await repos.dailyCapture.updateType(userId, typeKey, {
          ...(input.label !== undefined ? { label: input.label.trim() } : {}),
          ...(input.absorptionHint !== undefined ? { absorption_hint: input.absorptionHint.trim() || null } : {}),
          ...(input.sort !== undefined ? { sort: input.sort } : {}),
          ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
        });
        if (!updated) throw new NotFoundError("Daily capture type", typeKey);
        return updated;
      },
      { actorId: userId },
    );
  }
}
