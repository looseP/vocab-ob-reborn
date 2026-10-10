import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/frontend/api/client";
import { useToast } from "@/frontend/components/ui/Toast";
import type { ReviewL3ContextItem } from "@/frontend/components/review/L3ContextsFold";
import {
  addDailyReviewedCount,
  isDailyLimitReached,
  readDailyNewWordLimit,
  readDailyReviewLimit,
  readDailyReviewedCount,
} from "@/frontend/utils/dailyReviewLimit";
import type { DailyCountBucket } from "@/frontend/utils/dailyReviewLimit";

export interface ReviewNoteEntry {
  id: string;
  content_md: string;
  created_at: string;
}

export interface ReviewCard {
  progressId: string;
  word: {
    id: string;
    slug: string;
    title: string;
    lemma: string;
    short_definition: string | null;
    ipa: string | null;
    pos: string | null;
    cefr: string | null;
    // ── T3 Hint 阶梯（2026-09-25）：queue 方案 A 直载。可选 = 兼容旧
    // 会话缓存（TTL 内的会话恢复可能不含新字段）──
    /** H1 例句（未回灌批次为空数组）。exam 扩展见 @/domain/word-exam。 */
    examples?: unknown[];
    /** H2 原型意象原文（前端遮罩 + isSpoiler）。 */
    prototype_text?: string | null;
    /** H3 助记锚（words.metadata 派生）。 */
    mnemonic_text?: string | null;
    mnemonic_type?: string | null;
    /** H1′ 语义场降级链（无例句时的 H1 降级内容）。 */
    semantic_chain?: string | null;
  };
  state: string;
  dueAt: string | null;
  lastRating: string | null;
  reviewCount: number;
  l1WeakSignal?: boolean;
  /** Phase E 晋升可视化：L1 stability（天），晋升门 S≥21d ∧ reviewCount≥5。 */
  stability?: number | null;
  /** 阶梯起步档（ADR-0036）：1=全阶梯 / 2=撤提示面板 / 3=仅产出轮。可选 = 兼容旧缓存。 */
  ladderRung?: number;
  /**
   * P3-①(条目制 2026-09-06):复习卡附带可见笔记条目,创建时间正序;
   * 无笔记为空数组。卡背提供折叠入口 + 快记。
   */
  note_entries: ReviewNoteEntry[];
  /** L3 语境条目（Tier 2 折叠，grill 2026-09-07）。无语境为空数组。 */
  l3_contexts?: ReviewL3ContextItem[];
  /** 队列优先级元数据（review/zen 模式，P1）。 */
  queueBucket?: string;
  queueLabel?: string;
  queueReason?: string;
  retrievability?: number | null;
}

interface QueueResponse {
  items: ReviewCard[];
  session: { id: string; mode: string; cardsSeen: number };
  stats: { total: number; remaining: number; deferredNewCards?: number };
  /** 是否还有更多卡片可继续分页加载（P2 加载更多）。 */
  hasMore: boolean;
}

export type Rating = "again" | "hard" | "good" | "easy";

const STATE_LABELS: Record<string, string> = {
  new: "新词",
  learning: "学习中",
  review: "复习中",
  relearning: "重新学习",
  suspended: "已停用",
};

export function labelReviewState(state: string): string {
  return STATE_LABELS[state] ?? state;
}

/** 幂等键：防评分请求快速连点/网络重试导致 review_logs 双写。 */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 已提交评分（撤销目标）。undo RPC 仅支持带 previous_snapshot 的 answer 日志。 */
export interface LastAnswer {
  card: ReviewCard;
  rating: Rating;
  reviewLogId: string;
  /** 提交前的 currentIndex，撤销后回退到这里。 */
  indexBefore: number;
}

/**
 * 撤销栈深度上限。
 *
 * 栈里每项都握着一张完整 `ReviewCard`（含 examples / note_entries），而整个栈会被
 * 序列化进 localStorage。上限既防内存与配额无界增长，也把"连续撤销"限制在一个
 * 人类可理解的范围内（撤回十几步之前的评分通常意味着该重开会话，而不是继续点撤销）。
 */
export const MAX_UNDO_DEPTH = 10;

/**
 * 会话级缓存 key：避免"查看详情 → 返回"后复习队列被重置。
 * 按 (mode, wordIds) 分桶，不同模式/勾选集合的会话互不污染。
 * TTL = 24h：localStorage 不随标签页关闭清空，误关浏览器/崩溃后可恢复进度；
 * 过期靠 sweepExpiredCache + 读写时校验清理，避免长期堆积。
 */
const STORAGE_PREFIX = "vocab:review:session:";
const STORAGE_TTL_MS = 24 * 60 * 60 * 1000;

interface PersistedSession {
  mode: string;
  wordIdsKey: string; // "" 或逗号分隔的 wordIds
  sessionId: string | null;
  queue: ReviewCard[];
  currentIndex: number;
  stats: { reviewed: number; again: number; hard: number; good: number; easy: number };
  deferredNewCards: number;
  completed: boolean;
  /** 本会话跳过的卡数（完成页区分"已评分/跳过/挂起"）。旧缓存无此字段时按 0 处理。 */
  skipped?: number;
  suspended?: number;
  /** 队列是否还有更多卡片可继续分页加载。旧缓存无此字段时按 false 处理（到末尾再探测）。 */
  hasMore?: boolean;
  /**
   * 撤销栈（栈顶在前）。刷新/误关浏览器后仍能连续撤销。
   * 旧缓存无此字段时按空栈处理——旧格式里的 `lastAnswer` 已随本次升级废弃。
   */
  undoStack?: LastAnswer[];
  savedAt: number;
}

/**
 * mode → 服务端通道（2026-10-10 新学/复习隔离）。
 *
 * **为什么用独立 mode 而不是给 startReview 加参数**：会话缓存按 `cacheKey(mode)`
 * 分桶（见下），新通道若与`review` 共用 mode，两条通道的进度会互相覆盖 ——
 * 复习到第 8 张时切去学新词，回来会读到新词通道的队列与 currentIndex。
 * 走独立 mode 后缓存天然隔离，且 localStorage 里的旧 `review` 会话仍可正常恢复。
 *
 * - `learn` → `new` 通道（只出从未作答的新卡）
 * - `review` / `zen` → `review` 通道（只出该复习的卡，**永不含新卡**）
 * - `cram` / `preview` → 不隔离（练习模式按定义就是要混着来）
 */
export function channelForMode(mode: string): "review" | "new" | null {
  if (mode === "learn") return "new";
  if (mode === "review" || mode === "zen") return "review";
  return null;
}

function cacheKey(mode: string, wordIds?: string[]): string {
  const idsKey = (wordIds ?? []).join(",");
  return `${STORAGE_PREFIX}${mode}::${idsKey}`;
}

function readCache(mode: string, wordIds?: string[]): PersistedSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(cacheKey(mode, wordIds));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSession;
    if (Date.now() - (parsed.savedAt ?? 0) > STORAGE_TTL_MS) {
      localStorage.removeItem(cacheKey(mode, wordIds));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(session: Omit<PersistedSession, "savedAt"> & { wordIds?: string[] }): void {
  if (typeof window === "undefined") return;
  try {
    const key = cacheKey(session.mode, session.wordIds);
    const payload: PersistedSession = { ...session, savedAt: Date.now() };
    delete (payload as { wordIds?: string[] }).wordIds;
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    /* quota / private mode: 静默失败，行为退化为无缓存 */
  }
}

function clearCache(mode: string, wordIds?: string[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(cacheKey(mode, wordIds));
  } catch {
    /* ignore */
  }
}

/** 清除所有过期的复习会话缓存，避免 localStorage 长期堆积碎片。 */
function sweepExpiredCache(): void {
  if (typeof window === "undefined") return;
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as PersistedSession;
      if (now - (parsed.savedAt ?? 0) > STORAGE_TTL_MS) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    /* ignore */
  }
}

export function useReview() {
  const [queue, setQueue] = useState<ReviewCard[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<string>("review");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 });
  const [deferredNewCards, setDeferredNewCards] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [suspended, setSuspended] = useState(0);
  const [completed, setCompleted] = useState(false);
  /**
   * 撤销栈（栈顶在前，上限 MAX_UNDO_DEPTH）。
   *
   * 为什么是栈而不是单个 `lastAnswer`：撤销本身也写 review_logs（一条 rating=NULL 的
   * 审计行），它**不**带 previous_snapshot，因此不可再撤销；而栈里每个元素对应一条
   * 真实评分日志。连续撤销 = 依次弹出栈顶，各自独立可撤，互不干扰。
   *
   * 后端 `undo_review_log` 的"仅最新一条可撤"约束是**按 progress_id 分组**判定的，
   * 与栈的严格 LIFO 顺序天然一致：栈顶元素必是该词最新未撤销的评分。
   */
  const [undoStack, setUndoStack] = useState<LastAnswer[]>([]);
  /** 队列是否还有更多卡片可继续分页加载（P2）。 */
  const [hasMore, setHasMore] = useState(false);
  /** 正在加载下一页。 */
  const [loadingMore, setLoadingMore] = useState(false);
  /** 本次会话对应的 wordIds（startReview 时记录），用于缓存分桶。 */
  const wordIdsRef = useRef<string[] | undefined>(undefined);
  const { addToast } = useToast();

  /**
   * 每日复习上限（2026-10-10 接线）—— 此前是纯摆设的设置，现在是**续载闸门**：
   * 今日累计评分达到上限后停止**自动**续卡，复习页提示并给出冲刺入口。
   * `0` = 不限。计数按本地日历日累计（边界说明见 utils/dailyReviewLimit.ts）。
   * 已加载进队列的卡不受影响（软上限：绝不打断当前这张）。
   */
  const [dailyLimit, setDailyLimit] = useState(() => readDailyReviewLimit());
  const [dailyReviewedToday, setDailyReviewedToday] = useState(() => readDailyReviewedCount());
  /**
   * 新词通道的今日已学张数（2026-10-10 隔离）。
   *
   * 与复习计数**分桶**：学新词不消耗复习额度，反之亦然。若共用一个计数器，
   * 早上学一批新词就会把白天的复习额度耗尽 —— 那等于把隔离前的病根搬到限额上。
   */
  const [dailyNewLearnedToday, setDailyNewLearnedToday] = useState(() =>
    readDailyReviewedCount(new Date(), "learn"),
  );
  /** 新词通道每日上限；0 = 不限。设置页与复习页共用（见 dailyReviewLimit.ts）。 */
  const [dailyNewWordLimit, setDailyNewWordLimit] = useState(() => readDailyNewWordLimit());
  /** 本次会话内用户显式点了「继续复习（冲刺）」⇒ 不再拦自动续卡（不改设置）。 */
  const [dailyLimitOverride, setDailyLimitOverride] = useState(false);
  /** 是否因达每日上限而停止了自动续卡（复习页据此渲染提示条）。 */
  const [dailyLimitBlocked, setDailyLimitBlocked] = useState(false);
  // 闸门读 ref：loadMore 被预加载 effect 高频调用，塞 state 进依赖会让它反复重建
  const dailyLimitRef = useRef(dailyLimit);
  dailyLimitRef.current = dailyLimit;
  const dailyReviewedRef = useRef(dailyReviewedToday);
  dailyReviewedRef.current = dailyReviewedToday;
  const dailyOverrideRef = useRef(dailyLimitOverride);
  dailyOverrideRef.current = dailyLimitOverride;
  const dailyNewLimitRef = useRef(dailyNewWordLimit);
  dailyNewLimitRef.current = dailyNewWordLimit;
  const dailyNewLearnedRef = useRef(dailyNewLearnedToday);
  dailyNewLearnedRef.current = dailyNewLearnedToday;

  const currentCard = !completed && currentIndex < queue.length ? queue[currentIndex] : null;
  const remaining = Math.max(0, queue.length - currentIndex);

  const startReview = useCallback(async (mode: string = "review", wordIds?: string[], options?: { force?: boolean }) => {
    // 设置页可能刚改过上限 ⇒ 每次开新会话都重读；冲刺开关不跨会话（新会话 = 新闸门）
    // 两个通道各自重读各自的额度（2026-10-10 隔离：额度与计数都分桶）。
    const bucket: DailyCountBucket = mode === "learn" ? "learn" : "review";
    setDailyLimit(bucket === "learn" ? readDailyNewWordLimit() : readDailyReviewLimit());
    setDailyReviewedToday(readDailyReviewedCount(new Date(), bucket));
    setDailyNewLearnedToday(readDailyReviewedCount(new Date(), "learn"));
    setDailyNewWordLimit(readDailyNewWordLimit());
    setDailyLimitOverride(false);
    setDailyLimitBlocked(false);
    // 先尝试命中缓存：同 mode + 同 wordIds 分桶，且 TTL 内有效。
    // force=true 时绕过缓存（用户主动"开始/重启"）。
    wordIdsRef.current = wordIds;
    sweepExpiredCache();
    if (!options?.force) {
      const cached = readCache(mode, wordIds);
      if (cached && cached.queue.length > 0) {
        setMode(cached.mode);
        setQueue(cached.queue);
        setSessionId(cached.sessionId);
        setCurrentIndex(cached.currentIndex);
        setStats(cached.stats);
        setDeferredNewCards(cached.deferredNewCards);
        setSkipped(cached.skipped ?? 0);
        setSuspended(cached.suspended ?? 0);
        setCompleted(cached.completed);
        setHasMore(cached.hasMore ?? false);
        setLoadingMore(false);
        setError(null);
        setUndoStack(cached.undoStack ?? []);
        addToast("info", `已恢复复习会话（进度 ${cached.stats.reviewed}/${cached.queue.length}）`);
        return;
      }
    }
    setLoading(true);
    setError(null);
    setCompleted(false);
    setMode(mode);
    setCurrentIndex(0);
    setDeferredNewCards(0);
    setSkipped(0);
    setSuspended(0);
    setHasMore(false);
    setLoadingMore(false);
    setUndoStack([]);
    setStats({ reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 });
    clearCache(mode, wordIds);
    try {
      const params = new URLSearchParams({ limit: "20", mode });
      if (wordIds && wordIds.length > 0) {
        params.set("wordIds", wordIds.join(","));
      }
      // 通道隔离（2026-10-10）：`learn` 走 new 通道、`review`/`zen` 走 review 通道，
      // 练习模式（cram/preview）不下通道参数（保持混流）。
      const channel = channelForMode(mode);
      if (channel) params.set("channel", channel);
      const result = await apiFetch<QueueResponse>(`/review/queue?${params.toString()}`);
      if (!result.items || result.items.length === 0) {
        // 队列为空不是错误：不设 error，让完成/空态分支渲染"没有待复习的单词"，
        // 避免禅模式空队列被误判为"无法加载复习队列"。
        setQueue([]);
        setSessionId(null);
        return;
      }
      setQueue(result.items);
      setSessionId(result.session.id);
      setHasMore(Boolean(result.hasMore));
      if (typeof result.stats?.deferredNewCards === "number") {
        setDeferredNewCards(result.stats.deferredNewCards);
      }
      addToast("info", `已加载 ${result.items.length} 张复习卡片`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载复习队列失败");
      setQueue([]);
      setSessionId(null);
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  // toast action 的 onClick 在创建时闭包固定，用 ref 保证拿到最新 undoLast（见下方 undoLast）
  const undoRef = useRef<() => void>(() => {});

  /**
   * 忙碌锁（ref 级）：串行化会推进队列/写服务器状态的互斥操作。
   * 评分/撤销/跳过/挂起/清弱信号必须互斥执行，否则快速连点会在同一事件循环内
   * 绕过 state 的 loading 判断（setState 异步），导致同卡双写评分等数据污染。
   * 忙碌期间的后续调用直接丢弃（不是排队）。
   */
  const busyRef = useRef(false);

  const answer = useCallback(async (rating: Rating, hint?: { hintLevel: number; viaH4?: boolean }) => {
    if (!currentCard || !sessionId) return;
    if (busyRef.current) return;
    busyRef.current = true;
    const idempotencyKey = newIdempotencyKey();
    setLoading(true);
    try {
      const result = await apiFetch<{ ok: boolean; reviewLogId?: string; idempotent?: boolean }>("/review/answer", {
        method: "POST",
        body: JSON.stringify({
          rating,
          progressId: currentCard.progressId,
          sessionId,
          mode,
          idempotencyKey,
          // T3 Hint 阶梯埋点：hintLevel=0（直翻验证）也上报，缺省仅旧缓存路径
          ...(hint !== undefined ? { hintLevel: hint.hintLevel, ...(hint.viaH4 ? { viaH4: true } : {}) } : {}),
        }),
      });
      // cram 返回合成 reviewLogId，服务端无日志可撤销；仅真实评分记录撤销目标
      if (typeof result.reviewLogId === "string" && !result.reviewLogId.startsWith("cram-")) {
        const entry: LastAnswer = { card: currentCard, rating, reviewLogId: result.reviewLogId, indexBefore: currentIndex };
        setUndoStack((prev) => [entry, ...prev].slice(0, MAX_UNDO_DEPTH));
      }
      setStats((prev) => ({
        reviewed: prev.reviewed + 1,
        again: prev.again + (rating === "again" ? 1 : 0),
        hard: prev.hard + (rating === "hard" ? 1 : 0),
        good: prev.good + (rating === "good" ? 1 : 0),
        easy: prev.easy + (rating === "easy" ? 1 : 0),
      }));
      if (mode !== "cram") {
        // 每日上限的计数入账（cram 是零 FSRS 的练习模式，不算复习）。
        // 按通道分桶（2026-10-10 隔离）：learn 记「今日新学」，review/zen 记「今日复习」。
        if (mode === "learn") {
          setDailyNewLearnedToday(addDailyReviewedCount(1, new Date(), "learn"));
        } else {
          setDailyReviewedToday(addDailyReviewedCount(1, new Date(), "review"));
        }
      }
      const next = currentIndex + 1;
      if (next >= queue.length) {
        setCompleted(true);
        addToast("success", mode === "cram" ? "练习完成！本次评分未写入复习数据" : "复习完成！FSRS 调度已更新");
      } else {
        setCurrentIndex(next);
        if (mode !== "cram") {
          addToast("info", `已记录「${currentCard.word.lemma}」评分`, {
            duration: 8000,
            action: { label: "撤销", onClick: () => void undoRef.current() },
          });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "评分失败");
      addToast("error", "评分提交失败");
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [currentCard, sessionId, currentIndex, queue.length, addToast, mode]);

  /**
   * 撤销栈顶评分：服务端恢复 FSRS 快照，前端把卡片退回提交前的位置并回滚统计。
   * 可连续调用——每次弹出栈顶一条，逐级回退。
   */
  const undoLast = useCallback(async () => {
    const target = undoStack[0];
    if (!target || !sessionId) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    try {
      await apiFetch("/review/undo", {
        method: "POST",
        body: JSON.stringify({
          reviewLogId: target.reviewLogId,
          sessionId,
          idempotencyKey: newIdempotencyKey(),
        }),
      });
      // 只有服务端确认撤销成功才弹栈，避免把不可撤销的目标从栈里抹掉
      setUndoStack((prev) => prev.slice(1));
      setCompleted(false);
      setCurrentIndex(target.indexBefore);
      // 卡片通常仍在队列里（评分只推进游标、不移除元素）；分页续载等路径下若已不在，
      // 按提交前的位置插回，保证撤销后一定能重新看到这张卡。
      setQueue((prev) => {
        if (prev.some((c) => c.progressId === target.card.progressId)) return prev;
        const next = [...prev];
        next.splice(Math.min(target.indexBefore, next.length), 0, target.card);
        return next;
      });
      setStats((prev) => ({
        reviewed: Math.max(0, prev.reviewed - 1),
        again: Math.max(0, prev.again - (target.rating === "again" ? 1 : 0)),
        hard: Math.max(0, prev.hard - (target.rating === "hard" ? 1 : 0)),
        good: Math.max(0, prev.good - (target.rating === "good" ? 1 : 0)),
        easy: Math.max(0, prev.easy - (target.rating === "easy" ? 1 : 0)),
      }));
      // 撤销 = 今日计数回退（否则撤销后仍被上限拦住，越撤越堵）
      // 回退**当前会话所属通道**的桶：撤销学新词不能扣掉今日复习的计数。
      if (mode === "learn") {
        setDailyNewLearnedToday(addDailyReviewedCount(-1, new Date(), "learn"));
      } else {
        setDailyReviewedToday(addDailyReviewedCount(-1, new Date(), "review"));
      }
      addToast("success", `已撤销「${target.card.word.lemma}」的评分，可重新作答`);
    } catch (err) {
      // 已被撤销过/非最新日志等情况：目标不再有效，弹出避免死循环重试
      setUndoStack((prev) => prev.slice(1));
      addToast("error", err instanceof Error ? err.message : "撤销失败");
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [undoStack, sessionId, addToast]);

  // 每次渲染刷新 ref，使 toast action 永远调到最新闭包
  undoRef.current = () => void undoLast();

  /**
   * 消费侧栏"历史记录"中某条撤销请求（已在 ReviewHistoryDrawer 中发过 /review/undo），
   * 前端做本地状态回滚：卡片进度、统计、撤销栈。
   * 约定：允许在栈为空时调用（例如从详情返回撤销栈被清，但服务端仍可撤回该日志）。
   *
   * 侧栏可撤销任意条目（不再限最新一条），因此这里**不能**假设被撤的就是栈顶：
   * 命中栈内任意一条都按它的 indexBefore 精确回退，并把该条从栈中摘除——
   * 否则后续 undoLast 会拿一个已撤销的 reviewLogId 去请求，必然失败。
   */
  const applyHistoryUndo = useCallback(async (entry: { rating: string; reviewLogId: string; word_slug: string; word_lemma: string }) => {
    // 重要：ReviewHistoryDrawer 自己先 POST 了 /review/undo，然后才调用这个回调。
    // 因此这里绝对不能再次调用 undoLast()（会重复撤销，后端报错，stats 回滚也会 skip）。
    // 只需做本地状态回滚：递减 reviewed 与对应 rating；若命中栈内条目则使用其 indexBefore 精确回退。
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const rating = entry.rating as typeof entry.rating & ("again" | "hard" | "good" | "easy");
      const matched = undoStack.find((a) => a.reviewLogId === entry.reviewLogId);
      const prevCard = matched ? matched.card.word.lemma : entry.word_lemma;
      setUndoStack((prev) => prev.filter((a) => a.reviewLogId !== entry.reviewLogId));
      setCompleted(false);
      setCurrentIndex((prev) => (matched ? matched.indexBefore : Math.max(0, prev - 1)));
      setStats((prev) => ({
        reviewed: Math.max(0, prev.reviewed - 1),
        again: Math.max(0, prev.again - (rating === "again" ? 1 : 0)),
        hard: Math.max(0, prev.hard - (rating === "hard" ? 1 : 0)),
        good: Math.max(0, prev.good - (rating === "good" ? 1 : 0)),
        easy: Math.max(0, prev.easy - (rating === "easy" ? 1 : 0)),
      }));
      // 与 undoLast 同口径：撤销后今日计数回退（同样按当前通道的桶）
      if (mode === "learn") {
        setDailyNewLearnedToday(addDailyReviewedCount(-1, new Date(), "learn"));
      } else {
        setDailyReviewedToday(addDailyReviewedCount(-1, new Date(), "review"));
      }
      addToast("success", matched
        ? `已撤销「${prevCard}」的评分，可重新作答`
        : `已撤销「${entry.word_lemma}」的评分，可重新评分`);
    } finally {
      busyRef.current = false;
    }
  }, [undoStack, addToast]);

  /** 跳过当前卡：持久化 skip 日志（幂等），再本地推进。 */
  const skip = useCallback(() => {
    if (!currentCard) return;
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      if (sessionId && mode !== "cram") {
        void apiFetch("/review/skip", {
          method: "POST",
          body: JSON.stringify({
            progressId: currentCard.progressId,
            sessionId,
            idempotencyKey: newIdempotencyKey(),
          }),
        }).catch(() => addToast("warning", "跳过未能同步到服务器"));
      }
      setUndoStack([]);
      setSkipped((prev) => prev + 1);
      const next = currentIndex + 1;
      if (next >= queue.length) {
        setCompleted(true);
      } else {
        setCurrentIndex(next);
      }
    } finally {
      busyRef.current = false;
    }
  }, [currentCard, sessionId, mode, currentIndex, queue.length, addToast]);

  /** 挂起当前卡：该词退出复习调度（state=suspended），本地推进。 */
  const suspendCurrent = useCallback(async () => {
    if (!currentCard) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    try {
      await apiFetch("/review/suspend", {
        method: "POST",
        body: JSON.stringify({
          progressId: currentCard.progressId,
          ...(sessionId ? { sessionId } : {}),
          idempotencyKey: newIdempotencyKey(),
        }),
      });
      setUndoStack([]);
      setSuspended((prev) => prev + 1);
      addToast("success", `已挂起「${currentCard.word.lemma}」，不再进入复习队列`);
      const next = currentIndex + 1;
      if (next >= queue.length) {
        setCompleted(true);
      } else {
        setCurrentIndex(next);
      }
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "挂起失败");
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [currentCard, sessionId, currentIndex, queue.length, addToast]);

  // Preview (自由浏览) navigation — pure browsing, no rating, no persistence.
  const browseNext = useCallback(() => {
    setCurrentIndex((index) => Math.min(index + 1, queue.length - 1));
  }, [queue.length]);

  const browsePrev = useCallback(() => {
    setCurrentIndex((index) => Math.max(index - 1, 0));
  }, []);

  const clearWeakSignal = useCallback(async (wordId: string) => {
    if (!currentCard) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    try {
      await apiFetch("/review/weak-signal/clear", {
        method: "POST",
        body: JSON.stringify({ wordId }),
      });
      setQueue((prev) => prev.map((c) =>
        c.word.id === wordId ? { ...c, l1WeakSignal: false } : c,
      ));
      addToast("success", "已清除弱信号标记");
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "清除弱信号失败");
    } finally {
      busyRef.current = false;
      setLoading(false);
    }
  }, [currentCard, addToast]);

  /**
   * 加载更多（P2 分页）：按当前已加载的卡片数作为 offset 拉取下一页并追加。
   * 返回是否实际追加了新卡片（false = 已无更多）。
   */
  const loadMore = useCallback(async (): Promise<boolean> => {
    if (busyRef.current || loadingMore) return false;
    if (!sessionId) return false;
    // 每日上限闸门（软上限，2026-10-10）：达限后不再「自动」续卡。
    // 走 ref 读取，避免把上限/计数塞进本回调依赖（预加载 effect 会跟着抖动）。
    // **按通道各判各的**（隔离后额度分桶）：learn 通道看新词额度，review/zen 看复习额度，
    // 否则「早上学新词把复习额度花光」会在闸门处复现混流病。
    const limitForMode = mode === "learn" ? dailyNewLimitRef.current : dailyLimitRef.current;
    const countForMode = mode === "learn" ? dailyNewLearnedRef.current : dailyReviewedRef.current;
    if (
      !dailyOverrideRef.current &&
      isDailyLimitReached(limitForMode, countForMode)
    ) {
      setDailyLimitBlocked(true);
      return false;
    }
    busyRef.current = true;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "20", mode, offset: String(queue.length) });
      if (wordIdsRef.current && wordIdsRef.current.length > 0) {
        params.set("wordIds", wordIdsRef.current.join(","));
      }
      // 续卡必须带同一通道，否则第 2 页起会混流（首批隔离、后续不隔离 = 更难查的bug）。
      const channel = channelForMode(mode);
      if (channel) params.set("channel", channel);
      const result = await apiFetch<QueueResponse>(`/review/queue?${params.toString()}`);
      const newItems = result.items ?? [];
      setHasMore(Boolean(result.hasMore));
      if (newItems.length === 0) {
        return false;
      }
      setQueue((prev) => [...prev, ...newItems]);
      return true;
    } catch {
      addToast("warning", "加载更多卡片失败");
      return false;
    } finally {
      busyRef.current = false;
      setLoadingMore(false);
    }
  }, [mode, sessionId, queue.length, loadingMore, addToast]);

  /**
   * 冲刺：本次会话内越过每日上限并立即续卡。
   *
   * 为什么不是「改设置」：冲刺是临时行为（今天想多刷），不该让用户去设置页把上限
   * 永久改高、之后忘了改回来。这里只解除本次会话的闸门，设置值原样不动。
   */
  const allowDailyLimitOverride = useCallback(async (): Promise<boolean> => {
    dailyOverrideRef.current = true;
    setDailyLimitOverride(true);
    setDailyLimitBlocked(false);
    return loadMore();
  }, [loadMore]);

  /** 预加载阈值：剩余卡片 ≤ 该值时提前拉取下一页，避免到达末尾时的"完成"闪现。 */
  const LOAD_MORE_THRESHOLD = 5;

  // 预加载：剩余较少且有更多时提前拉取下一页（无缝续卡）。
  useEffect(() => {
    if (completed || !hasMore || loadingMore) return;
    if (remaining <= LOAD_MORE_THRESHOLD) {
      void loadMore();
    }
  }, [completed, hasMore, loadingMore, remaining, loadMore]);

  // 续载兜底：已到达当前批末尾（completed）但仍有更多卡片时，拉取下一页并恢复进行。
  // 无更多且为禅模式时，交由 ReviewPage 的 zen-restart 逻辑重新拉取（无限循环）。
  useEffect(() => {
    if (!completed || !hasMore || loadingMore) return;
    let cancelled = false;
    void loadMore().then((ok) => {
      if (!cancelled && ok) setCompleted(false);
    });
    return () => {
      cancelled = true;
    };
  }, [completed, hasMore, loadingMore, loadMore]);

  /**
   * 每当会话的核心进度变化，同步写入 localStorage。
   * 缓存只在真实加载过队列后才写；未开始会话（queue 空）不写。
   * undoStack 一并落盘：刷新/误关浏览器后撤销历史不丢（栈本身有 10 深度上限）。
   */
  useEffect(() => {
    if (!queue.length && !sessionId) return;
    writeCache({
      mode,
      wordIds: wordIdsRef.current,
      wordIdsKey: (wordIdsRef.current ?? []).join(","),
      sessionId,
      queue,
      currentIndex,
      stats,
      deferredNewCards,
      skipped,
      suspended,
      completed,
      hasMore,
      undoStack,
    });
  }, [mode, sessionId, queue, currentIndex, stats, deferredNewCards, skipped, suspended, completed, hasMore, undoStack]);

  return {
    currentCard,
    queue,
    mode,
    sessionId,
    loading,
    error,
    stats,
    deferredNewCards,
    skipped,
    suspended,
    completed,
    currentIndex,
    remaining,
    /** 队列是否还有更多卡片可继续分页加载（P2）。 */
    hasMore,
    /** 正在加载下一页。 */
    loadingMore,
    /** 最近一次可撤销的评分（null = 无可撤销项）。等价于 undoStack 栈顶。 */
    lastAnswer: undoStack[0] ?? null,
    /** 撤销栈（栈顶在前）；`canUndo` 即 length > 0。 */
    undoStack,
    /** 是否还有可撤销的评分（撤销栈非空）。 */
    canUndo: undoStack.length > 0,
    startReview,
    answer,
    skip,
    suspendCurrent,
    undoLast,
    applyHistoryUndo,
    browseNext,
    browsePrev,
    clearWeakSignal,
    loadMore,
    /** 今日已复习（本地日历日累计，含本会话增量；cram 练习不计）。 */
    dailyReviewedToday,
    /** 每日复习上限；0 = 不限。 */
    dailyLimit,
    /** 今日已学新词张数（与今日已复习分桶，见 dailyReviewLimit.ts）。 */
    dailyNewLearnedToday,
    /** 新词通道每日上限；0 = 不限。 */
    dailyNewWordLimit,
    /** 因达每日上限而停止自动续卡（复习页据此提示）。 */
    dailyLimitBlocked,
    /** 继续复习（冲刺）：本次会话内越过上限并立即续卡，不改设置。 */
    allowDailyLimitOverride,
  };
}
