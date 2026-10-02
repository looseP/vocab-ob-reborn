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
const LADDER_CACHE_KEY = "vocab:review:ladder:review";
const LADDER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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

function readLadderCache(): PersistedLadderSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LADDER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedLadderSession;
    if (Date.now() - (parsed.savedAt ?? 0) > LADDER_CACHE_TTL_MS || !Array.isArray(parsed.visits)) {
      window.localStorage.removeItem(LADDER_CACHE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeLadderCache(session: Omit<PersistedLadderSession, "savedAt">): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LADDER_CACHE_KEY, JSON.stringify({ ...session, savedAt: Date.now() }));
  } catch {
    /* quota / private mode: 静默失败，行为退化为无缓存 */
  }
}

function clearLadderCache(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LADDER_CACHE_KEY);
  } catch {
    /* ignore */
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

export function LadderReviewSession({ onBack }: { onBack: () => void }) {
  const { queue, sessionId, loading, error, startReview } = useReview();
  const { addToast } = useToast();

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
    const cached = readLadderCache();
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
      if (cached.queue.length > 0) setRestoredQueue(cached.queue);
    } else {
      void startReview("review");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    writeLadderCache({
      sessionId: activeSessionId,
      queue: activeQueue,
      visits,
      pos,
      settlement,
      completed,
      scratchEntries: [...scratchRef.current.entries()],
      submitKeys: [...submitKeysRef.current.entries()],
    });
  }, [visits, pos, settlement, completed, activeSessionId, activeQueue]);

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

  const advance = useCallback(() => {
    setPos((p) => {
      const next = p + 1;
      if (next >= visits.length) setCompleted(true);
      return next;
    });
  }, [visits.length]);

  /**
   * 原地重测当前词：清掉本词的会话暂存并强制视图重挂载。
   *
   * 纯前端内存重置，不碰服务端——再认轮自评 / 巩固轮跟写 / 产出轮的默写结果
   * 都只存在 scratch 里（产出轮末才 POST），所以重置零数据库风险。
   * 已提交过的词重做时，submitWordAnswer 会复用原幂等键，不会二次调度。
   */
  const retryCurrentWord = useCallback(() => {
    if (!current || submitting) return;
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
    if (pos <= 0 || completed || submitting) return;
    const target = visits[pos - 1];
    if (!target) return;
    scratchRef.current.delete(target.progressId);
    setRetryNonce((n) => n + 1);
    setPos((p) => Math.max(0, p - 1));
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
    }
    setSubmitting(true);
    try {
      const result = await apiFetch<{ ok: boolean; reviewLogId?: string; idempotent?: boolean }>("/review/answer", {
        method: "POST",
        body: JSON.stringify({
          progressId: visit.progressId,
          sessionId: activeSessionId,
          mode: "review",
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
        addToast("info", `「${card.word.lemma}」本词已提交过，本次重做仅作练习（不重复调度）`);
        setSubmitting(false);
        advance();
        return;
      }
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
      addToast("error", err instanceof Error ? err.message : "评分提交失败");
      // 提交失败停在当前 visit（重试语义：再次完成默写动作重新组装提交）
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    advance();
  }, [cardsByProgressId, activeSessionId, advance, addToast]);

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
    void submitWordAnswer({ ...current, ...(card ? {} : {}) });
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
          action={<Button onClick={() => void startReview("review", undefined, { force: true })}><RotateCcw className="h-4 w-4" />重试</Button>}
        />
      </Card>
    );
  }
  if (!loading && activeQueue.length === 0 && visits.length === 0) {
    return (
      <Card>
        <EmptyState title="没有待复习的单词" description="导入更多单词或稍后再来" />
      </Card>
    );
  }

  if (completed) {
    return (
      <Card className="space-y-4" data-testid="ladder-settlement">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-[var(--color-accent)]" />
          <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">阶梯会话结算</h2>
          <Badge tone="accent">{settlement.length} 词已调度</Badge>
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
          <Button variant="secondary" onClick={() => { clearLadderCache(); onBack(); }}>返回</Button>
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
          <Badge tone="accent">阶梯会话 · {passLabel}</Badge>
          <Badge>{pos + 1} / {visits.length}</Badge>
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
