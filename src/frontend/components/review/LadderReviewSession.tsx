/**
 * LadderReviewSession —— 阶梯复习会话（ADR-0036，LW-1）。
 *
 * 队列拉取复用 useReview 的 startReview（缓存/会话语义不变），拉到后经
 * sessionScheduler 排三轮队列；逐 visit 渲染，**每词每会话恰好一次
 * POST /review/answer**（产出轮末，rating = 政策 B final + metadata 全量）；
 * 再认轮自评 / 巩固轮跟写 / 词义卡复核全部前端暂存，不 POST。
 * 阶梯模式不接服务端 undo（会话内无中间 answer 可撤），改用两个纯前端容错入口：
 * Esc / 「重测本词」原地重置本词，Ctrl+Z / 「上一词」游标步退重做（见 retryCurrentWord
 * 与 stepBack）。重做已提交的词时复用其幂等键，保证仍满足"每词恰好一次调度"。
 *
 * 拍板⑦：档位菜单常驻于默写视图；R3 词产出完成后词义卡复核入队尾（拍板⑥）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, RotateCcw, Sparkles } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { ReviewCardView } from "@/frontend/components/review/ReviewCardView";
import { FollowCopyView } from "@/frontend/components/review/FollowCopyView";
import { TypingDictationView } from "@/frontend/components/review/TypingDictationView";
import { EncodeCardView } from "@/frontend/components/review/EncodeCardView";
import { useReview, type Rating, type ReviewCard } from "@/frontend/hooks/useReview";
import type { LadderChannel } from "@/frontend/utils/ladderSettings";
import {
  addDailyReviewedCount,
  isDailyLimitReached,
  readDailyNewWordLimit,
  readDailyReviewLimit,
  readDailyReviewedCount,
} from "@/frontend/utils/dailyReviewLimit";
import { buildLadderSession, type LadderSettlementRow } from "@/frontend/reviewFlow/sessionScheduler";
import type { LadderVisit } from "@/frontend/reviewFlow/stageMap";
import { dictMapOf, policyBFinal, TIER_LABEL } from "@/frontend/reviewFlow/stageMap";
import type { DictationTier } from "@/frontend/reviewFlow/stageMap";
import type { LadderRung } from "@/domain/ladder-rung";
import { apiFetch } from "@/frontend/api/client";
import { useToast } from "@/frontend/components/ui/Toast";

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `lad-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const RATING_LABEL: Record<Rating, string> = { again: "重来", hard: "困难", good: "良好", easy: "轻松" };

// ── 会话恢复（ADR-0036 决策 6 / LW-2）：scheduler 游标 + 暂存并入 localStorage ──
// 独立前缀（不进经典 vocab:review:session: 扫描）；TTL 24h 与经典会话同口径，
// 误关浏览器/崩溃后仍可恢复（含 submitKeys，否则重做会重复调度）。
// 缓存键按通道分桶（2026-10-10）：review/learn 各自整场恢复，互不串台。
const LADDER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function ladderCacheKey(channel: LadderChannel): string {
  return `vocab:review:ladder:${channel}`;
}

/** 供入口层（复习页"开始"按钮）在显式开新会话前清对应通道的阶梯缓存。 */
export function clearLadderSessionCache(channel: LadderChannel): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ladderCacheKey(channel));
  } catch {
    /* ignore */
  }
}

/**
 * 已提交词的幂等键，**独立于整场会话缓存**存放（2026-10-11 审查 D2）。
 *
 * 此前 submitKeys 与 visits/游标一起存在 `vocab:review:ladder:<channel>` 里，而该
 * 缓存会被「开始新会话」清掉、且有 24h TTL。一旦清掉，用户对同一 progressId 的
 * 重做会拿到**全新的幂等键** —— 服务端判重只认 key，于是把同一词**二次真实调度**
 * （review_count +1、FSRS 再算一遍、今日计数 +2）。
 *
 * 幂等键的语义是"这个 progressId 今天这次提交已经发生"，它不该比会话活得短。
 * 因此单独落盘、单独清理（结算页"返回"时才清），TTL 与整场缓存一致。
 */
const LADDER_SUBMIT_KEYS_PREFIX = "vocab:review:ladder-keys:";

function submitKeysCacheKey(channel: LadderChannel): string {
  return `${LADDER_SUBMIT_KEYS_PREFIX}${channel}`;
}

function readSubmitKeysCache(channel: LadderChannel): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof window === "undefined") return map;
  try {
    const raw = window.localStorage.getItem(submitKeysCacheKey(channel));
    if (!raw) return map;
    const parsed = JSON.parse(raw) as { keys?: Record<string, string>; savedAt?: number };
    if (Date.now() - (parsed.savedAt ?? 0) > LADDER_CACHE_TTL_MS) {
      window.localStorage.removeItem(submitKeysCacheKey(channel));
      return map;
    }
    for (const [pid, key] of Object.entries(parsed.keys ?? {})) map.set(pid, key);
  } catch {
    /* 坏值按空处理：宁可失去幂等保护，也不让会话打不开 */
  }
  return map;
}

function writeSubmitKeysCache(channel: LadderChannel, map: Map<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      submitKeysCacheKey(channel),
      JSON.stringify({ keys: Object.fromEntries(map), savedAt: Date.now() }),
    );
  } catch {
    /* quota: 静默失败，退化为仅本会话内存内幂等 */
  }
}

/** 整场会话真正结束时清掉该通道的幂等键（结算页「返回」调用）。 */
export function clearLadderSubmitKeys(channel: LadderChannel): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(submitKeysCacheKey(channel));
  } catch {
    /* ignore */
  }
}

/**
 * 未完成阶梯会话的元信息（2026-10-11 审查 B1 的恢复入口数据源）。
 *
 * 此前阶梯缓存**写得进、永远读不到**：唯一读取点在组件挂载 effect 里，而唯一挂载
 * 入口（复习页"开始"按钮）在挂载前先清缓存 ⇒ 刷新/后退/切标签后整场归零，代码注释
 * 承诺的"崩溃后可恢复（含 submitKeys）"实为死代码。本函数让复习页能像经典会话那样
 * 扫出未完成会话并给出「继续上次 / 重新开始」两个出口。
 */
export interface LadderRestoreMeta {
  channel: LadderChannel;
  /** 下一站序号（0 基）：已完成到第几个 visit。 */
  pos: number;
  /** 本场 visit 总数。 */
  total: number;
  savedAt: number;
}

export function readLadderRestoreMeta(channel: LadderChannel): LadderRestoreMeta | null {
  const cached = readLadderCache(channel);
  if (!cached || cached.visits.length === 0) return null;
  // 只有"没走完"的会话才算可恢复：全部 visit 已访问 或 已标记完成 ⇒ 无需恢复。
  if (cached.completed || cached.pos >= cached.visits.length) return null;
  return {
    channel,
    pos: cached.pos,
    total: cached.visits.length,
    savedAt: cached.savedAt ?? 0,
  };
}

interface PersistedLadderSession {
  sessionId: string | null;
  queue: ReviewCard[];
  visits: LadderVisit[];
  pos: number;
  settlement: LadderSettlementRow[];
  completed: boolean;
  /** 会话内暂存（再认自评/巩固跟写/产出默写结果），恢复后逐词还原。 */
  scratchEntries?: Array<[string, WordScratch]>;
  /**
   * 每词已使用的提交幂等键（progressId → idempotencyKey）。
   *
   * 步退/重测会让**已提交**的词再走一遍产出轮。若重做时换一个新 key，服务端会
   * 当成第二次真实作答 → 同一会话内同一词被调度两次（review_count/FSRS 双计）。
   * 复用原 key 让服务端幂等识别，重做只作练习、不重复写库。
   * 必须持久化：刷新后重建 ref 会丢掉旧 key，重新踩中同一个双写洞。
   */
  submitKeys?: Array<[string, string]>;
  savedAt: number;
}

function readLadderCache(channel: LadderChannel): PersistedLadderSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ladderCacheKey(channel));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedLadderSession;
    if (Date.now() - (parsed.savedAt ?? 0) > LADDER_CACHE_TTL_MS || !Array.isArray(parsed.visits)) {
      window.localStorage.removeItem(ladderCacheKey(channel));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeLadderCache(channel: LadderChannel, session: Omit<PersistedLadderSession, "savedAt">): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ladderCacheKey(channel), JSON.stringify({ ...session, savedAt: Date.now() }));
  } catch {
    /* quota / private mode: 静默失败，行为退化为无缓存 */
  }
}

/** 每词的会话内暂存（不 POST 的信号池）。 */
interface WordScratch {
  cardRating: Rating | null;
  hintLevel: number;
  viaH4: boolean;
  startedAt: number;
  followWrong: number | null;
  dictResult: {
    tier: DictationTier;
    wrongTimes: number;
    hintChars: number;
    abandonedChars: number;
    dictMap: ReturnType<typeof dictMapOf>;
  } | null;
}

function emptyScratch(): WordScratch {
  return { cardRating: null, hintLevel: 0, viaH4: false, startedAt: Date.now(), followWrong: null, dictResult: null };
}

/**
 * @param channel 阶梯会话的队列通道（2026-10-10 开关化接线）：
 *   - `"review"`：到期复习的阶梯会话（默认，兼容既有调用方）；
 *   - `"learn"`：学新词的阶梯会话 —— 走 new 通道出卡，answer 计「今日新学」额度。
 * 调用方须以 `key={`${channel}-…`}` 保证通道切换时整体重挂载（复习页已这么做）。
 */
export function LadderReviewSession({ channel = "review", onBack }: { channel?: LadderChannel; onBack: () => void }) {
  // persist:false + autoLoadMore:false —— 阶梯只借用本 hook 拉一次队列（2026-10-11 审查
  // B3/B4/E2）：写经典缓存会留下 `completed:false` 残壳 ⇒ 复习页恢复条假命中、把用户
  // 换回经典速刷并二次调度；预加载会在小队列时静默追加永不学习的卡。
  const { queue, sessionId, loading, error, startReview } = useReview({ persist: false, autoLoadMore: false });
  const { addToast } = useToast();
  /** 是否学新词通道：空态/结算文案与每日计数口径都按它分流。 */
  const isNewLearn = channel === "learn";
  // 每日计数徽标（2026-10-10 开关化接线补账）：阶梯的 answer 绕过了 useReview.answer
  // （它自带计数），必须在这里自己入账 —— 否则学新词额度被架空：阶梯学 20 个新词
  // 「今日新学」仍是 0，闸门形同虚设。
  const [dailyCount, setDailyCount] = useState(() => readDailyReviewedCount(new Date(), channel));
  /**
   * 额度冲刺 override（2026-10-11 审查 S1）：闸门命中时用户点「继续（冲刺）」置 true，
   * 挂载 effect 据此重新拉队列。语义与经典流一致——不动设置、本次会话越过即可。
   */
  const [limitOverride, setLimitOverride] = useState(false);
  /**
   * 提交失败的显式出口（2026-10-11 审查 B2）。见 submitWordAnswer 的 catch 分支说明：
   * 产出轮视图在失败时已无任何可点控件，重试必须由会话层提供，且复用原幂等键。
   */
  const [submitError, setSubmitError] = useState<{ visit: LadderVisit; message: string } | null>(null);
  /**
   * 已入结算表且已计每日额度的 progressId（2026-10-11 审查 D1 的对账依据）。
   * 幂等命中时的「补行 + 补计数」靠它防重复；恢复会话时由缓存里的结算行重建。
   */
  const settlementCountedRef = useRef<Set<string>>(new Set());

  const [visits, setVisits] = useState<LadderVisit[]>([]);
  const [pos, setPos] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const scratchRef = useRef<Map<string, WordScratch>>(new Map());
  /**
   * 每词已用的提交幂等键（见 PersistedLadderSession.submitKeys）。
   * 重做已提交的词时复用同一 key，服务端幂等拦截 → 不重复调度。
   */
  const submitKeysRef = useRef<Map<string, string>>(new Map());
  /**
   * 视图重挂载计数器：重测本词 / 步退上一词时自增，经 cardKey 强制子组件干净重挂载，
   * 清除残留输入与打字错误态（见下方 cardKey 注释）。
   */
  const [retryNonce, setRetryNonce] = useState(0);
  const [settlement, setSettlement] = useState<LadderSettlementRow[]>([]);
  // 会话恢复：挂载时命中缓存则整体还原（进度/暂存/结算一致），不再拉队列
  const restoredRef = useRef(false);

  useEffect(() => {
    // 额度闸门（2026-10-11 S1）：超标且未冲刺时**不拉队列**，等用户明示。
    //
    // ⚠️ 依赖数组必须含 limitOverride（收尾轮 P0-1 修正）：初版依赖为 `[]`，
    // 点「冲刺」只重渲染不重跑本 effect ⇒ 队列永远拉不起来 ⇒ 拦截条之后是
    // 假空态「没有待复习的单词」——冲刺按钮成了死按钮，恢复条承诺的
    // 「回到原轮次与原游标」也在额度达标场景下完全落空。
    if (isDailyLimitReached(
      isNewLearn ? readDailyNewWordLimit() : readDailyReviewLimit(),
      readDailyReviewedCount(new Date(), channel),
    ) && !limitOverride) {
      return;
    }
    // 冲刺后 effect 重跑：会话若已拉起（visits 非空）不得重新恢复/重拉，
    // 否则会把进行中的进度覆盖回缓存快照。
    if (visits.length > 0) return;
    const cached = readLadderCache(channel);
    if (cached && cached.visits.length > 0) {
      restoredRef.current = true;
      setVisits(cached.visits);
      setPos(cached.pos);
      setSettlement(cached.settlement ?? []);
      setCompleted(cached.completed);
      setSessionRestored(cached);
      for (const [pid, s] of cached.scratchEntries ?? []) {
        scratchRef.current.set(pid, s);
      }
      for (const [pid, key] of cached.submitKeys ?? []) {
        submitKeysRef.current.set(pid, key);
      }
      // 幂等键的权威副本在独立键里（D2）：即使整场缓存被清/过期，今天已提交的词
      // 仍能被识别为重复，不会二次调度。
      for (const [pid, key] of readSubmitKeysCache(channel)) {
        submitKeysRef.current.set(pid, key);
      }
      // 对账基线：结算表里已有的行视为已计数（D1 自愈不会重复补）
      for (const row of cached.settlement ?? []) {
        settlementCountedRef.current.add(row.progressId);
      }
      if (cached.queue.length > 0) setRestoredQueue(cached.queue);
    } else {
      // force:true —— 点「开始」必须开新队列/新 sessionId，绝不命中经典流遗留的缓存
      // （否则可能拿到跨天的旧 session，提交时被 assertActiveOwned 404）。
      void startReview(channel, undefined, { force: true });
    }
    // channel 由调用方以 key 保证稳定；limitOverride 变化（点「冲刺」）时重跑以拉起队列。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limitOverride]);

  // 恢复路径的 queue/sessionId 来源（不经 useReview，避免覆盖经典缓存语义）
  const [restored, setSessionRestored] = useState<{ sessionId: string | null } | null>(null);
  const [restoredQueue, setRestoredQueue] = useState<ReviewCard[]>([]);

  useEffect(() => {
    if (queue.length === 0 || visits.length > 0 || restoredRef.current) return;
    setVisits(buildLadderSession(queue));
  }, [queue, visits.length]);

  // 会话核心进度变化 → 写缓存（scheduler 游标 + 暂存 + 结算）
  const activeQueue = restoredQueue.length > 0 ? restoredQueue : queue;
  const activeSessionId = restored?.sessionId ?? sessionId;
  useEffect(() => {
    if (activeQueue.length === 0) return;
    if (!activeSessionId) return;
    writeLadderCache(channel, {
      sessionId: activeSessionId,
      queue: activeQueue,
      visits,
      pos,
      settlement,
      completed,
      scratchEntries: [...scratchRef.current.entries()],
      submitKeys: [...submitKeysRef.current.entries()],
    });
  }, [channel, visits, pos, settlement, completed, activeSessionId, activeQueue]);

  const cardsByProgressId = useMemo(() => {
    const map = new Map<string, ReviewCard>();
    for (const card of activeQueue) map.set(card.progressId, card);
    return map;
  }, [activeQueue]);

  const scratchFor = (progressId: string): WordScratch => {
    let s = scratchRef.current.get(progressId);
    if (!s) {
      s = emptyScratch();
      scratchRef.current.set(progressId, s);
    }
    return s;
  };

  const current = !completed && pos < visits.length ? visits[pos] : null;
  const currentCard = current ? cardsByProgressId.get(current.progressId) ?? null : null;
  /**
   * 视图重挂载键：换卡或换 stage 必须重挂载，否则各视图的本地 useState 会跨卡残留。
   *
   * 曾经没有 key，React 按位置复用组件实例，导致四类污染（P0 卡死 + 调度污染）：
   * - `FollowCopyView` / `TypingDictationView`：`finished` 与 `useTypingFlow` 的
   *   `typedLength`/`doneRef` 残留 → 上一卡已 completed 的卡进到下一卡时输入框消失、
   *   `onDone` 因 `doneRef` 已置位永不重触发 → **会话死锁，无任何按钮可点**。
   * - `ReviewCardView`：`hintLevel`/`viaH4` 残留 → 上一卡用了几级提示就带进下一卡，
   *   评分上限被无理由压低（每用一级降一档），污染 FSRS 调度；`revealed`/`shown` 残留
   *   还会让释义提前出现（剧透）。
   * - `EncodeCardView`：`revealed` 残留 → 同上剧透。
   *
   * stage 也要进 key：最后一个 else 分支被多个 stage 共用（`card` / `card-no-hints` …），
   * 换 stage 时同为 ReviewCardView、位置不变，仅靠 progressId 不足以触发重挂载。
   */
  const cardKey = current ? `${current.progressId}:${current.stage}:${retryNonce}` : "ladder-empty";

  /**
   * 游标前进一格；「是否到达队尾」由下方 effect 判定，**不在 updater 内 setState**。
   *
   * 2026-10-11 审查（S2）修正：完成判定曾放在 `setPos` 的 updater 里
   * （`if (next >= visits.length) setCompleted(true)`），两种写法都会丢站：
   *  1. 闭包捕获 `visits.length` —— R3 词的 `setVisits`（追加词义卡复核）与
   *     `advance()` 同批次时读到的是追加前的长度 ⇒ 提前 completed ⇒ 队尾复核静默丢弃；
   *  2. 改读 ref 仍不够 —— React 18 的 **eager evaluation** 会在 dispatch 阶段就
   *     尝试求值 updater（此时渲染尚未发生，ref 还是旧值）⇒ 同样误判完成。
   * 因此改为：updater 只做纯算术，完成判定放到渲染后的 effect（此时 length 已是最新）。
   */
  const advance = useCallback(() => {
    setPos((p) => p + 1);
  }, []);

  // 游标到达队尾 ⇒ 会话完成。visits.length 变化（含 meaning 复核入队）同样触发，
  // 因此「刚追加的复核站」不会被尾判定吃掉。
  useEffect(() => {
    if (completed) return;
    if (visits.length > 0 && pos >= visits.length) setCompleted(true);
  }, [pos, visits.length, completed]);

  /**
   * 原地重测当前词：清掉本词的会话暂存并强制视图重挂载。
   *
   * 纯前端内存重置，不碰服务端——再认轮自评 / 巩固轮跟写 / 产出轮的默写结果
   * 都只存在 scratch 里（产出轮末才 POST），所以重置零数据库风险。
   * 已提交过的词重做时，submitWordAnswer 会复用原幂等键，不会二次调度。
   */
  const retryCurrentWord = useCallback(() => {
    if (!current || submitting) return;
    // 收尾轮 P1-3（场景 A）：Esc 重测会清掉本词 scratch——若残留的 submitError 还
    // 指向本词，再点「重试提交」会走 !scratch.dictResult 的防御分支直接 advance()，
    // 本词永远不被提交（默写结果已丢、幂等键已落盘却未用）。重测即放弃旧失败出口。
    setSubmitError(null);
    scratchRef.current.delete(current.progressId);
    setRetryNonce((n) => n + 1);
    addToast("info", "已重置本词，请重新作答");
  }, [current, submitting, addToast]);

  /**
   * 步退上一词：游标回退一格并清掉目标词的暂存，让用户重新作答。
   *
   * 与 retryCurrentWord 同为零风险内存操作；退到已提交的词时靠幂等键防重复调度。
   */
  const stepBack = useCallback(() => {
    // 注意守卫里**不排除 completed**：末站提交后（或结算页上）用户仍要能退回重做，
    // 这正是容错入口存在的意义（旧守卫会让最需要它的一次失效）。
    if (pos <= 0 || submitting) return;
    const target = visits[pos - 1];
    if (!target) return;
    // 收尾轮 P1-3（场景 B）：步退到上一词后，旧 submitError 指向的词已不在当前站——
    // 残留的重试条再点会让 advance() 越过步退目标词。步退即放弃旧失败出口。
    setSubmitError(null);
    scratchRef.current.delete(target.progressId);
    setRetryNonce((n) => n + 1);
    setPos((p) => Math.max(0, p - 1));
    // 步退 = 继续做：必须把「已完成」拉回来。
    // 2026-10-11 审查（S2）连带修正：此前 completed 一旦置真就再没人复位，
    // 末站提交后步退的用户会**停在结算页**、点不动上一词（容错入口在最坏情况下失效）。
    setCompleted(false);
    const lemma = cardsByProgressId.get(target.progressId)?.word.lemma;
    addToast("info", lemma ? `已退回「${lemma}」，请重新作答` : "已退回上一词，请重新作答");
  }, [pos, completed, submitting, visits, cardsByProgressId, addToast]);

  /**
   * 键盘容错入口：Esc = 原地重测本词，Ctrl/Cmd+Z = 步退上一词。
   *
   * 阶梯模式**没有**可撤销的评分日志（每词每会话只 POST 一次，且撤销语义由
   * ReviewCardView 的 Ctrl+Z 负责，在阶梯里 canUndo 恒为 false），所以 Ctrl+Z
   * 在这里改绑"游标步退"这个纯前端动作，不与任何服务端撤销冲突。
   *
   * 输入控件内不豁免：各打字视图的 onKeyDown 只接管可打印字符（且要求无修饰键），
   * Esc / Ctrl+Z 本就会冒泡到这里；输入框 value 恒为空串，浏览器原生撤销无事可做。
   * 唯一例外是划词翻译浮层——Esc 在那边是"关闭浮层"，若同时重置本词会误伤用户
   * 已键入的进度，故浮层存在时让路。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 输入控件豁免（2026-10-11 审查 D3）：跟写/默写的输入框、卡背的笔记
      // textarea 里按 Esc/Ctrl+Z，不该被会话级快捷键劫持 —— 否则正在写的笔记草稿
      // 会无声消失（重测本词会整棵重挂载并清空 quickDraft），默写打到一半的进度
      // 也被清零。原注释"输入框 value 恒为空串、原生撤销无事可做"只在跟写/默写
      // 成立，卡背 textarea 上不成立。与 ReviewCardView 的同类豁免保持一致。
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "Escape") {
        if (document.querySelector("[data-selection-translate]")) return;
        e.preventDefault();
        retryCurrentWord();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        stepBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [retryCurrentWord, stepBack]);

  /** 产出轮末：组装唯一一次 answer 提交（rating = 政策 B final + metadata 全量）。 */
  const submitWordAnswer = useCallback(async (visit: LadderVisit) => {
    const card = cardsByProgressId.get(visit.progressId);
    const scratch = scratchFor(visit.progressId);
    if (!card || !activeSessionId || !scratch.dictResult) {
      // 无会话/无默写结果：跳过调度（防御分支，正常流不触达）
      advance();
      return;
    }
    const rung = (card.ladderRung ?? 1) as LadderRung;
    const dictMap = scratch.dictResult.dictMap;
    const rating = policyBFinal({ ladderRung: rung, cardRating: scratch.cardRating, dictMap });
    const durationMs = Math.max(0, Date.now() - scratch.startedAt);
    const downgraded = scratch.dictResult.tier !== "dictation";
    // 每词固定一个幂等键：步退/重测导致的重做提交会被服务端识别为重复请求而跳过，
    // 避免同一会话内同一词被调度两次（见 PersistedLadderSession.submitKeys）。
    let idempotencyKey = submitKeysRef.current.get(visit.progressId);
    if (!idempotencyKey) {
      idempotencyKey = newIdempotencyKey();
      submitKeysRef.current.set(visit.progressId, idempotencyKey);
      writeSubmitKeysCache(channel, submitKeysRef.current);
    }
    setSubmitting(true);
    try {
      const result = await apiFetch<{ ok: boolean; reviewLogId?: string; idempotent?: boolean }>("/review/answer", {
        method: "POST",
        body: JSON.stringify({
          progressId: visit.progressId,
          sessionId: activeSessionId,
          // 通道跟随会话形态（2026-10-10）：learn 阶梯的评分计入「今日新学」
          // （服务端按 mode 分桶计数），与 useReview.answer 的口径一致。
          mode: channel,
          rating,
          idempotencyKey,
          hintLevel: scratch.hintLevel,
          ...(scratch.viaH4 ? { viaH4: true } : {}),
          source: "typing" as const,
          tier: scratch.dictResult.tier,
          wrongTimes: scratch.dictResult.wrongTimes,
          durationMs,
          downgraded,
          ...(scratch.cardRating ? { cardRating: scratch.cardRating } : {}),
          abandonedChars: scratch.dictResult.abandonedChars,
        }),
      });
      // 重做已提交的词：服务端幂等命中，本次作答**未**写入调度（原评分仍然有效）。
      // 结算表保留首次那条，如实反映"实际被调度的是什么"；不追加第二行，
      // 也不重复排词义卡复核。
      if (result?.idempotent) {
        // 2026-10-11 审查（D1）对账自愈：幂等键在 POST **之前**就落盘，而结算行与
        // 每日计数在 POST 成功**之后**才落 —— 于是「服务端已提交、但响应在途中丢失
        // （超时/连接重置）」这一种情形下，本地缓存里有幂等键却没有结算行、今日额度
        // 永久少 +1（结算页「N 词已调度」比真实调度数少 1）。用户重做该词命中幂等时，
        // 在此按 progressId 对账补齐：缺行补行、缺计数补计数（服务端那边确实已计过）。
        setSettlement((prev) => (prev.some((r) => r.progressId === visit.progressId)
          ? prev
          : [...prev, {
            progressId: visit.progressId,
            lemma: card.word.lemma,
            cardRating: scratch.cardRating,
            tier: scratch.dictResult!.tier,
            wrongTimes: scratch.dictResult!.wrongTimes,
            dictMap,
            finalRating: rating,
            isFirstRating: card.state === "new",
          }]));
        if (!settlementCountedRef.current.has(visit.progressId)) {
          settlementCountedRef.current.add(visit.progressId);
          setDailyCount(addDailyReviewedCount(1, new Date(), channel));
        }
        addToast("info", `「${card.word.lemma}」本词已提交过，本次重做仅作练习（不重复调度）`);
        // 收尾轮 P1-2：不清 submitError 的话，多词会话里重试条会跨站残留（文案指错词），
        // 再点会拿旧 visit 幂等命中 → advance() → 当前词被静默跳过。
        setSubmitError(null);
        setSubmitting(false);
        advance();
        return;
      }
      settlementCountedRef.current.add(visit.progressId);
      setSettlement((prev) => [...prev, {
        progressId: visit.progressId,
        lemma: card.word.lemma,
        cardRating: scratch.cardRating,
        tier: scratch.dictResult!.tier,
        wrongTimes: scratch.dictResult!.wrongTimes,
        dictMap,
        finalRating: rating,
        isFirstRating: card.state === "new",
      }]);
      // 每日上限计数入账（幂等命中分支在上面已提前 return，不会重复计）：
      // learn 记「今日新学」（占新词额度），review 记「今日复习」。
      setDailyCount(addDailyReviewedCount(1, new Date(), channel));
      // 拍板⑥：R3 词产出完成后词义卡复核入队尾（无调度语义，不再 POST）
      if (rung >= 3) {
        setVisits((prevVisits) =>
          prevVisits.some((v) => v.meaningReview && v.progressId === visit.progressId)
            ? prevVisits
            : [...prevVisits, { qi: visit.qi, progressId: visit.progressId, pass: 3, stage: "meaning", meaningReview: true }],
        );
        addToast("info", `「${card.word.lemma}」词义卡复核已排入队尾`);
      }
    } catch (err) {
      // 2026-10-11 审查（B2）：此前只 toast + 停在原地，而产出轮视图此刻
      // `finished=true` ⇒ 输入框已卸载、档位按钮全禁，**没有任何按钮能再次触发提交**，
      // 用户丢失已完成的默写结果且只能整词重打（必然再次失败 ⇒ 整场死锁）。
      // 现在把失败显式渲染成可重试出口：重试复用**原幂等键** —— 若首次其实已落库
      // （响应超时/连接重置），服务端会命中幂等并跳过二次调度；若确实没落库，则正常提交。
      setSubmitError({ visit, message: err instanceof Error ? err.message : "评分提交失败" });
      addToast("error", err instanceof Error ? err.message : "评分提交失败");
      setSubmitting(false);
      return;
    }
    setSubmitError(null);
    setSubmitting(false);
    advance();
  }, [cardsByProgressId, activeSessionId, advance, addToast, channel]);

  const onCardAnswer = (rating: Rating, hint?: { hintLevel: number; viaH4?: boolean }) => {
    if (!current) return;
    const scratch = scratchFor(current.progressId);
    scratch.cardRating = rating;
    scratch.hintLevel = hint?.hintLevel ?? scratch.hintLevel;
    scratch.viaH4 = hint?.viaH4 ?? scratch.viaH4;
    advance();
  };

  const onDictationDone = (r: { tier: DictationTier; wrongTimes: number; hintChars: number; abandonedChars: number }) => {
    if (!current) return;
    const scratch = scratchFor(current.progressId);
    const card = cardsByProgressId.get(current.progressId);
    scratch.dictResult = {
      tier: r.tier,
      wrongTimes: r.wrongTimes,
      hintChars: r.hintChars,
      abandonedChars: r.abandonedChars,
      dictMap: dictMapOf({ wrongTimes: r.wrongTimes, hintChars: r.hintChars, tier: r.tier }),
    };
    void submitWordAnswer(current);
  };

  if (loading && activeQueue.length === 0) {
    return (
      <Card className="flex items-center justify-center py-20">
        <span className="text-[var(--color-ink-soft)]">正在加载阶梯会话…</span>
      </Card>
    );
  }
  if (error && !currentCard) {
    return (
      <Card>
        <EmptyState
          title="无法加载复习队列"
          description={error}
          action={<Button onClick={() => void startReview(channel, undefined, { force: true })}><RotateCcw className="h-4 w-4" />重试</Button>}
        />
      </Card>
    );
  }

  // 每日计数徽标：上限 0 = 不限，只显示累计数。进行中的轮次与结算页都显示，
  // 让用户学完一轮就能看见今日额度消耗。
  const dailyLimit = isNewLearn ? readDailyNewWordLimit() : readDailyReviewLimit();
  const dailyCountLabel = isNewLearn
    ? `今日新词 ${dailyCount}${dailyLimit > 0 ? `/${dailyLimit}` : ""}`
    : `今日复习 ${dailyCount}${dailyLimit > 0 ? `/${dailyLimit}` : ""}`;
  const dailyCountBadge = (
    <Badge tone={isDailyLimitReached(dailyLimit, dailyCount) ? "warm" : undefined}>{dailyCountLabel}</Badge>
  );

  /**
   * 每日额度闸门（2026-10-11 审查 S1）。
   *
   * 阶梯不走 useReview 的分页续载，而**闸门的唯一实现在 loadMore 里**，因此此前
   * 「设置页把新词上限调成 5，阶梯一次仍拉 20 张并全部真实调度」——上限对阶梯
   * 完全无效（徽标变暖色但从不阻止）。这里改为**会话入口前置闸门**：达标即不拉队列，
   * 渲染拦截条；「冲刺」是明示动作（与经典流同语义：不动设置、本次越过即可），
   * 点它才 override 并重新拉队列。
   *
   * ⚠️ 必须在空态分支**之前**（收尾轮 P0-1 修正）：首帧 visits=[] 时空态会先命中，
   * 闸门分支不可达 ⇒ 额度达标场景显示假空态「没有待复习的单词」而非拦截条 ⇒
   * 冲刺按钮不存在 ⇒ 用户被误导"今天没卡"。
   */
  const limitReached = isDailyLimitReached(dailyLimit, dailyCount);
  // 拦截条只拦「尚未拉起」的会话（收尾轮 P1-1）：进行中达标（本会话提交使计数
  // 达到上限）**不得整页替换做题界面** —— 软上限语义是"已加载的卡照常做完，绝不
  // 打断当前这张"（dailyReviewLimit.ts 头注），经典流的提示条也是与卡并列渲染。
  // 进行中达标只靠徽标变暖色提示即可。
  const sessionNotStarted = visits.length === 0 && activeQueue.length === 0;

  if (!limitOverride && limitReached && sessionNotStarted) {
    return (
      <Card className="border-[var(--color-accent)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--color-ink)]">
              {isNewLearn
                ? `今天已学 ${dailyCount} 个新词，达到每日上限（${dailyLimit} 个/天）`
                : `今天已复习 ${dailyCount} 张，达到每日上限（${dailyLimit} 张/天）`}
            </p>
            <p className="text-xs text-[var(--color-ink-soft)]">
              阶梯会话不会自动续卡，但一次会拉完整批队列，因此开课前先在此拦一道。
              {isNewLearn ? "（今日复习额度未受影响，两条通道独立计数。）" : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" onClick={() => setLimitOverride(true)}>
              {isNewLearn ? "继续学词（冲刺）" : "继续复习（冲刺）"}
            </Button>
            <Link to="/settings">
              <Button size="sm" variant="secondary">调整上限</Button>
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  if (!loading && activeQueue.length === 0 && visits.length === 0) {
    return (
      <Card>
        <EmptyState
          title={isNewLearn ? "没有待学的新词" : "没有待复习的单词"}
          description={isNewLearn ? "所有入队的词都学过一遍了。导入更多单词，或去复习通道巩固记忆。" : "导入更多单词或稍后再来"}
        />
      </Card>
    );
  }

  if (completed) {
    return (
      <Card className="space-y-4" data-testid="ladder-settlement">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-[var(--color-accent)]" />
          <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">
            {isNewLearn ? "学新词 · 阶梯会话结算" : "阶梯会话结算"}
          </h2>
          <Badge tone="accent">{settlement.length} 词已调度</Badge>
          {dailyCountBadge}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-ink-soft)]">
                <th className="py-2 pr-3">词</th>
                <th className="py-2 pr-3">卡面</th>
                <th className="py-2 pr-3">默写</th>
                <th className="py-2 pr-3">最终</th>
                <th className="py-2 pr-3">起步档</th>
              </tr>
            </thead>
            <tbody>
              {settlement.map((row) => (
                <tr key={row.progressId} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2 pr-3 font-semibold text-[var(--color-ink)]">{row.lemma}</td>
                  <td className="py-2 pr-3 text-[var(--color-ink-soft)]">{row.isFirstRating ? "首评" : (row.cardRating ? RATING_LABEL[row.cardRating] : "—")}</td>
                  <td className="py-2 pr-3 text-[var(--color-ink-soft)]">
                    {TIER_LABEL[row.tier]}{row.wrongTimes != null ? ` · 错键 ${row.wrongTimes}` : ""}
                    {row.dictMap ? ` → ${RATING_LABEL[row.dictMap]}` : ""}
                  </td>
                  <td className="py-2 pr-3 font-medium text-[var(--color-ink)]">{RATING_LABEL[row.finalRating]}</td>
                  <td className="py-2 pr-3 text-[var(--color-ink-soft)]">{row.isFirstRating ? "新词首学 → R1" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-[var(--color-ink-soft)]">
          评分 = 政策 B：min(卡面自评, 默写映射)，客观只降不升；FSRS 调度与起步档进退由服务端结算。
        </p>
        <div className="flex justify-end">
          <Button
            variant="secondary"
            onClick={() => {
              // 整场真正结束：清阶梯缓存，并清掉本通道的幂等键（D2 —— 键的有效期是
              // 「今天这个 progressId 提交过」，会话结束即可，下一轮自会是新的一天/新调度）
              clearLadderSessionCache(channel);
              clearLadderSubmitKeys(channel);
              onBack();
            }}
          >
            返回
          </Button>
        </div>
      </Card>
    );
  }

  if (!current || !currentCard) return null;

  const passLabel = current.pass === 1 ? "再认轮" : current.pass === 2 ? "巩固轮" : "产出轮";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">{isNewLearn ? "学新词 · " : ""}阶梯会话 · {passLabel}</Badge>
          <Badge>{pos + 1} / {visits.length}</Badge>
          {dailyCountBadge}
        </div>
        <div className="flex items-center gap-1">
          {/* 容错入口（纯前端内存操作，零数据库风险）：
              步退 = 游标回退一格重做上一词；重测 = 清掉本词暂存原地重来。
              已提交过的词重做时复用幂等键，不会二次调度。 */}
          <Button
            variant="ghost"
            size="sm"
            disabled={pos <= 0 || submitting}
            onClick={stepBack}
            title="退回上一词重新作答（Ctrl/Cmd+Z）"
            data-testid="ladder-step-back"
          >
            <ArrowLeft className="h-4 w-4" />
            上一词
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={retryCurrentWord}
            title="清空本词进度，重新作答（Esc）"
            data-testid="ladder-retry-word"
          >
            <RotateCcw className="h-4 w-4" />
            重测本词
          </Button>
          <Button variant="ghost" size="sm" onClick={onBack}>退出</Button>
        </div>
      </div>

      {/* 提交失败出口（2026-10-11 审查 B2）：产出轮视图在失败时已无可点控件，
          整个会话唯一能让用户脱困的地方。重试复用原幂等键，不会二次调度。
          渲染守卫 `visit === current`（收尾轮 P1-2/P1-3 双保险）：失败词必须仍是
          当前站才显示——步退/重测/推进后旧错误条自动消失，避免再点时 advance()
          跳过别的词。 */}
      {submitError && submitError.visit === current && (
        <Card className="border-[var(--color-accent-2)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--color-ink)]">评分提交失败，会话已停在当前词</p>
              <p className="text-xs text-[var(--color-ink-soft)]">
                {submitError.message} · 本词的默写结果仍在（不会丢），重试不会重复调度
              </p>
            </div>
            <Button size="sm" disabled={submitting} onClick={() => void submitWordAnswer(submitError.visit)}>
              重试提交
            </Button>
          </div>
        </Card>
      )}

      {current.stage === "follow" ? (
        <FollowCopyView
          key={cardKey}
          lemma={currentCard.word.lemma}
          definition={currentCard.word.short_definition}
          ipa={currentCard.word.ipa}
          disabled={submitting}
          onDone={(r) => {
            scratchFor(current.progressId).followWrong = r.wrongTimes;
            advance();
          }}
        />
      ) : current.stage === "dictation" ? (
        <TypingDictationView
          key={cardKey}
          lemma={currentCard.word.lemma}
          definition={currentCard.word.short_definition}
          ipa={currentCard.word.ipa}
          disabled={submitting}
          onDone={onDictationDone}
        />
      ) : current.stage === "card-encode" ? (
        <EncodeCardView
          key={cardKey}
          card={currentCard}
          disabled={submitting}
          onRate={onCardAnswer}
        />
      ) : current.stage === "meaning" ? (
        <div key={cardKey} data-testid="meaning-review">
          <Badge tone="accent">词义卡复核（无调度语义）</Badge>
          <ReviewCardView
            key={cardKey}
            card={currentCard}
            loading={loading}
            error={null}
            preview={false}
            onAnswer={() => advance()}
            onSkip={() => advance()}
            hintLadderHidden={false}
          />
        </div>
      ) : (
        <ReviewCardView
          key={cardKey}
          card={currentCard}
          loading={loading}
          error={null}
          preview={false}
          onAnswer={onCardAnswer}
          onSkip={() => advance()}
          hintLadderHidden={current.stage === "card-no-hints"}
        />
      )}
    </div>
  );
}
