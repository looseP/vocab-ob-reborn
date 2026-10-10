import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Repeat, Zap, BookOpen, Sparkles, RotateCcw, Infinity as InfinityIcon, Layers, Undo2, History, Sprout } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { ReviewCardView } from "@/frontend/components/review/ReviewCardView";
import { DrillSession } from "@/frontend/components/review/DrillSession";
import { LadderReviewSession } from "@/frontend/components/review/LadderReviewSession";
import { HuluSprintSession } from "@/frontend/components/review/HuluSprintSession";
import { ReviewProgressBar } from "@/frontend/components/review/ReviewProgressBar";
import { CompletionCelebration } from "@/frontend/components/review/CompletionCelebration";
import { ReviewHistoryDrawer, type ReviewHistoryEntry } from "@/frontend/components/review/ReviewHistoryDrawer";
import { useReview } from "@/frontend/hooks/useReview";
import { useUpgradeHints } from "@/frontend/hooks/useUpgradeHints";
import { isReviewReturnNavigation, shouldAutoRestoreSession } from "@/frontend/viewModels/reviewReturnNavigation";
import { fetchReviewQueue } from "@/frontend/api/reviewQueue";

const reviewModes = [
  { key: "review", icon: Repeat, title: "标准复习", desc: "按 FSRS 间隔重复算法安排的到期卡片", variant: "primary" as const },
  { key: "cram", icon: Zap, title: "练习模式", desc: "完形填空 / 词汇填空自测，错题回尾，不写入复习数据", variant: "secondary" as const },
  { key: "preview", icon: BookOpen, title: "自由复习", desc: "自由浏览词汇，不评分、不写入数据", variant: "secondary" as const },
  { key: "zen", icon: InfinityIcon, title: "禅模式", desc: "无限循环复习，巩固记忆", variant: "secondary" as const },
  // 阶梯会话此前是一个**全局布尔开关**（设置页 / 标准复习卡内），开启后会接管
  // 「标准复习」**和**「快速开始」两条路 —— 用户无法预期自己被换了卡片。
  // 2026-10-03 起改为**显式第 5 个模式**（ADR-0036 §4 修订）：
  // 要用就明确选它，不选则阶梯代码路径**分支不可达**。
  { key: "ladder", icon: Layers, title: "阶梯复习（实验）", desc: "三轮制会话：再认 → 巩固 → 产出，含跟写与默写", variant: "secondary" as const },
  // 葫芦冲刺（ADR-0041）：整批词按页推进的**阶段性**多轮冲刺，页级检索闸门、
  // 只记轮次耗时、零 FSRS 写入。与 ladder 同理做成**显式第 6 个模式**——
  // 不选它则葫芦的代码路径分支不可达（构造上保证，不靠约定）。
  { key: "hulu", icon: Sprout, title: "葫芦冲刺", desc: "整批词考前多轮冲刺，只记轮次耗时，不写入复习数据", variant: "secondary" as const },
] as const;

/**
 * 今日两个通道的待办张数（2026-10-10 新学/复习隔离）。
 *
 * 复用队列全景已交付的 `/api/review/queue/list` 计数（`dueNow` = 非挂起非新卡且已到期，
 * `new` = 从未作答），**不新增端点** —— 计数口径与服务端分桶同源，不会出现
 * 「卡片写 14、进度条显示 12」这种自相矛盾。
 *
 * 取数失败静默降级为 `null`（卡片不显示数字、不禁用入口）—— 复习是第一优先路径，
 * 计数挂了不该拦住用户开始复习。
 */
export interface ReviewChannelCounts {
  dueNow: number;
  newCards: number;
}

/**
 * 次级模式卡（2026-10-10 通道隔离后从 reviewModes 中挑出）。
 *
 * `review` 与 `zen` 已各自升级为顶部大卡片（到期复习 / Zen 禅模式），
 * 不在此重复渲染 —— 否则复习页会同时出现「到期复习」和「标准复习」两张语义重叠的卡。
 * 剩余 4 项（cram / preview / ladder / hulu）走这张网格。
 */
const SECONDARY_MODE_KEYS = ["cram", "preview", "ladder", "hulu"] as const;
const secondaryModes = reviewModes.filter((m) =>
  (SECONDARY_MODE_KEYS as readonly string[]).includes(m.key),
);

/** 测试钩子：暴露模式清单，供测试锁住「阶梯/葫芦是显式模式」这两条不变量。 */
export function reviewModesForTest() {
  return reviewModes.map((m) => ({ key: m.key, title: m.title }));
}

/** 测试钩子：次级网格里的模式 key（review/zen 已升级为大卡片，不在其中）。 */
export function secondaryModeKeysForTest() {
  return secondaryModes.map((m) => m.key);
}

/**
 * 会话恢复条的标题（2026-10-10 通道隔离）。
 *
 * `learn` 是通道隔离新增的 mode，**不在 reviewModes 里**（它在顶部大卡片上，
 * 语义是「学新词」而非一种「模式」），所以要单独映射，否则恢复条会退化成
 * 「检测到未完成的复习会话」—— 把学新词的进度说成复习，语义就错了。
 */
const RESTORE_MODE_TITLES: Record<string, string> = {
  learn: "学新词",
  review: "标准复习",
  zen: "Zen 禅模式",
};

function ReviewModeSelector({ onStart, counts }: { onStart: (mode: string) => void; counts: ReviewChannelCounts | null }) {
  const dueCount = counts?.dueNow ?? 0;
  const newCount = counts?.newCards ?? 0;
  return (
    <div className="space-y-6">
      {/*
        两个并列大卡片（2026-10-10 新学/复习隔离）。
        此前只有「快速开始」一张卡通吃全部队列：真库实测 507 行里 483 张是新卡（95.3%），
        于是「开始复习」实际上 95% 在学新词，真正的到期复习被稀释到看不见 ——
        用户以为自己在复习，其实在被新词淹没（且新卡配额每批仅 8 张，483 张要进出 60 次）。
        现在两条通道各占一张卡，各带自己的计数，一眼看出「今天该复习 1 张 / 该学新词 483 张」。
      */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card
          className={`h-full cursor-pointer transition-colors hover:border-[var(--color-border-strong)] ${dueCount === 0 && counts ? "opacity-70" : ""}`}
          onClick={() => onStart("review")}
        >
          <div className="flex h-full flex-col justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[var(--color-surface-muted)]">
                <Sparkles className="h-7 w-7 text-[var(--color-accent)]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-[var(--color-ink)]">到期复习</h3>
                  {counts && (
                    <Badge tone={dueCount > 0 ? "accent" : undefined}>{dueCount} 张</Badge>
                  )}
                </div>
                <p className="text-sm text-[var(--color-ink-soft)]">
                  只过该复习的词，按 FSRS 间隔重复排序。记忆曲线卡在这里。
                </p>
              </div>
            </div>
            <Button size="sm" className="self-start">开始复习</Button>
          </div>
        </Card>

        <Card
          className={`h-full cursor-pointer transition-colors hover:border-[var(--color-border-strong)] ${newCount === 0 && counts ? "opacity-70" : ""}`}
          onClick={() => onStart("learn")}
        >
          <div className="flex h-full flex-col justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[var(--color-surface-muted)]">
                <Sprout className="h-7 w-7 text-[var(--color-accent)]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-[var(--color-ink)]">学新词</h3>
                  {counts && (
                    <Badge tone="warm">{newCount} 张</Badge>
                  )}
                </div>
                <p className="text-sm text-[var(--color-ink-soft)]">
                  录入队列后还没学过的词。与复习互不挤占，各自算各自的上限。
                </p>
              </div>
            </div>
            <Button size="sm" variant="secondary" className="self-start">开始学词</Button>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card
          className="cursor-pointer transition-colors hover:border-[var(--color-border-strong)]"
          onClick={() => onStart("zen")}
        >
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-surface-muted)]">
              <InfinityIcon className="h-7 w-7 text-[var(--color-accent)]" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold text-[var(--color-ink)]">Zen 禅模式</h3>
                <Badge tone="accent">沉浸心流</Badge>
              </div>
              <p className="text-sm text-[var(--color-ink-soft)]">无限循环自动续载，无倒计时焦虑</p>
            </div>
            <Button size="sm" variant="secondary">进入</Button>
          </div>
        </Card>
      </div>

      {/* 4 项模式卡：sm 起两行两张 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {secondaryModes.map((m) => {
          const Icon = m.icon;
          return (
            <Card key={m.key} className="h-full">
              <Icon className="mb-3 h-6 w-6 text-[var(--color-accent)]" />
              <h3 className="mb-1 text-lg font-semibold text-[var(--color-ink)]">{m.title}</h3>
              <p className="mb-4 text-sm text-[var(--color-ink-soft)]">{m.desc}</p>
              <Button size="sm" variant={m.variant} onClick={() => onStart(m.key)}>开始</Button>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function ReviewSession({ reviewMode, wordIds, onBack, force }: { reviewMode: string; wordIds?: string[]; onBack: () => void; force?: boolean }) {
  // 阶梯会话**不再劫持任何模式**（ADR-0036 §4 于 2026-10-03 修订）：
  // 此前这里是 `reviewMode === "review" && !wordIds?.length && isLadderModeEnabled()`，
  // 一个全局布尔开关会悄悄把「标准复习」和「快速开始」换成另一张卡，用户无从预期。
  // 现在阶梯是 `reviewModes` 里的显式第 5 个模式，由上层 `reviewMode === "ladder"` 分支直达，
  // 本函数**只服务现行复习流** ⇒ 不变量从「靠布尔值保证」升级为「分支不可达，构造上保证」。
  const {
    currentCard,
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
    queue,
    hasMore,
    loadingMore,
    canUndo,
    startReview,
    answer,
    skip,
    suspendCurrent,
    undoLast,
    applyHistoryUndo,
    browseNext,
    browsePrev,
    clearWeakSignal,
    // 每日复习上限（2026-10-10 接线）：此前设置页的滑块没有任何消费方
    dailyReviewedToday,
    dailyLimit,
    // 新词通道的独立额度与计数（2026-10-10 隔离）：两通道各判各的
    dailyNewLearnedToday,
    dailyNewWordLimit,
    dailyLimitBlocked,
    allowDailyLimitOverride,
  } = useReview();

  // 从词条库勾选进入（P2）：强制自由复习浏览模式，不评分、不写入数据
  const isFreeSelection = !!wordIds && wordIds.length > 0;
  const apiMode = isFreeSelection ? "preview" : reviewMode === "zen" ? "review" : reviewMode;
  const isZen = reviewMode === "zen";
  const isPreview = reviewMode === "preview" || isFreeSelection;
  /** 学新词通道（2026-10-10 隔离）：空态与上限提示都要说「新词」而不是「复习」。 */
  const isNewLearn = apiMode === "learn";

  // ADR-0018 首学徽标：会话初始化时【一次】批量取当前词书的进行中工单，
  // 建 wordId→档位映射；卡片只读映射（作答链路零新增网络请求）。
  // preview / 自由复习不写数据，也不取升级提示。
  const { hints: upgradeHints, mark: markUpgrade } = useUpgradeHints({ enabled: !isPreview });

  // 历史记录抽屉：快捷键 H 切换。
  // 注意：preview / 自由复习 / 选词浏览 会话不产生评分日志，但仍然允许查看历史（入口 UX 一致）；
  //       条目级"撤销"按钮由抽屉自己根据 sessionId 存在性决定禁/启用。
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "h") {
        e.preventDefault();
        setDrawerOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    void startReview(apiMode, wordIds, force ? { force: true } : undefined);
    // 仅在进入会话时跑一次；重复依赖会导致缓存恢复后立刻被 force 清掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiMode, force]);

  // Zen mode: auto-restart when completed AND no more pages remain.
  // 队列分页（P2）：completed 但仍有更多卡片时由 useReview 自动续载下一页；
  // 只有无更多卡片时禅模式才重新拉取队列，避免无限循环中断。
  // force=true：绕过会话缓存（缓存的已完成会话会让 startReview
  // 反复恢复同一 completed 状态，导致无限"重新加载队列中..."），真实重拉队列。
  useEffect(() => {
    if (completed && isZen && !hasMore) {
      const timer = setTimeout(() => startReview(apiMode, undefined, { force: true }), 800);
      return () => clearTimeout(timer);
    }
  }, [completed, isZen, hasMore, apiMode, startReview]);

  const showCompletion = completed && !isZen;
  const showZenReloading = completed && isZen;
  const showError = Boolean(error && !currentCard);
  const showEmpty = !loading && !currentCard && remaining === 0 && !showCompletion && !showZenReloading && !showError;
  const showCard = !showCompletion && !showZenReloading && !showError && !showEmpty;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">已复习 {stats.reviewed}</Badge>
          {stats.again > 0 && <Badge tone="warm">不会 {stats.again}</Badge>}
          {stats.hard > 0 && <Badge>困难 {stats.hard}</Badge>}
          {stats.good > 0 && <Badge tone="accent">良好 {stats.good}</Badge>}
          {stats.easy > 0 && <Badge tone="accent">简单 {stats.easy}</Badge>}
          {deferredNewCards > 0 && !isPreview && (
            <Badge tone="warm">{deferredNewCards} 张新卡已延迟（新卡配额）</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(true)} title="复习历史记录（H）">
            <History className="h-4 w-4" />
            历史
            <kbd className="ml-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-ink-soft)]">H</kbd>
          </Button>
          {canUndo && !isPreview && (
            <Button variant="ghost" size="sm" disabled={loading} onClick={() => void undoLast()}>
              <Undo2 className="h-4 w-4" />撤销
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onBack}>退出</Button>
        </div>
      </div>

      {showCompletion ? (
        <CompletionCelebration
          stats={stats}
          skipped={skipped}
          suspended={suspended}
          title={isNewLearn ? "今日新词已学完 🎉" : "今日复习已完成 🎉"}
          onRestart={() => startReview(apiMode)}
          onBack={onBack}
        />
      ) : showZenReloading ? (
        <div className="flex h-48 items-center justify-center">
          <div className="text-center">
            <InfinityIcon className="mx-auto mb-3 h-8 w-8 animate-pulse text-[var(--color-accent)]" />
            <p className="text-sm text-[var(--color-ink-soft)]">重新加载队列中...</p>
            <p className="mt-1 text-xs text-[var(--color-ink-soft)]">禅模式 · 已复习 {stats.reviewed} 张</p>
          </div>
        </div>
      ) : showError ? (
        <Card>
          <EmptyState
            title="无法加载复习队列"
            description={error ?? undefined}
            action={<Button onClick={() => startReview(reviewMode)}><RotateCcw className="h-4 w-4" />重试</Button>}
          />
        </Card>
      ) : showEmpty ? (
        <Card>
          <EmptyState
            title={isNewLearn ? "队列里没有新词了" : "没有待复习的单词"}
            description={
              isNewLearn
                ? "所有入队的词都学过一遍了。导入更多单词，或去复习通道巩固记忆。"
                : "当前没有到期的复习卡。可以去学新词，或稍后再来。"
            }
            action={
              isNewLearn ? (
                <Link to="/words">
                  <Button variant="secondary">浏览词条库</Button>
                </Link>
              ) : (
                <Link to="/words">
                  <Button variant="secondary">去学新词</Button>
                </Link>
              )
            }
          />
        </Card>
      ) : (
        <>
          <ReviewProgressBar completed={stats.reviewed} remaining={remaining} />
          {/* 每日上限提示（2026-10-10）：只拦「自动续卡」，不打断当前这张。
              冲刺是明示动作 —— 不动设置，本次会话越过即可。 */}
          {dailyLimitBlocked && (
            <Card className="border-[var(--color-accent)]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--color-ink)]">
                    {isNewLearn ? (
                      <>
                        今天已学 {dailyNewLearnedToday} 个新词，达到每日上限（{dailyNewWordLimit} 个/天）
                      </>
                    ) : (
                      <>
                        今天已复习 {dailyReviewedToday} 张，达到每日上限（{dailyLimit} 张/天）
                      </>
                    )}
                  </p>
                  <p className="text-xs text-[var(--color-ink-soft)]">
                    队列已停止自动续卡，避免过载；当前这张不受影响。
                    {isNewLearn ? "（今日复习额度未受影响，两条通道独立计数。）" : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" onClick={() => void allowDailyLimitOverride()}>
                    {isNewLearn ? "继续学词（冲刺）" : "继续复习（冲刺）"}
                  </Button>
                  <Link to="/settings">
                    <Button size="sm" variant="secondary">调整上限</Button>
                  </Link>
                </div>
              </div>
            </Card>
          )}
          {/* key 必需：ReviewCardView 的 hintLevel/revealed/shown 等本地状态只对当前卡有效。
              缺 key 时 React 按位置复用实例，跨卡残留会导致「上一卡用了几级提示 → 下一卡
              未用提示就被压低评分上限」，污染 FSRS 调度；onUndo 回退到上一张卡时同样中招。 */}
          <ReviewCardView
            key={currentCard?.progressId ?? "review-no-card"}
            card={currentCard}
            loading={loading}
            error={error}
            preview={isPreview}
            onAnswer={answer}
            onSkip={skip}
            onSuspend={isPreview ? undefined : suspendCurrent}
            onUndo={isPreview ? undefined : undoLast}
            canUndo={!isPreview && canUndo}
            onPrev={browsePrev}
            onNext={browseNext}
            onClearWeakSignal={clearWeakSignal}
            reviewContext={{ mode: apiMode, wordIds }}
            reviewProgress={{ reviewed: stats.reviewed, total: queue.length }}
            upgradeHint={!isPreview ? (upgradeHints[currentCard?.word.id ?? ""] ?? null) : null}
            onMarkUpgrade={!isPreview ? markUpgrade : undefined}
          />
          {loadingMore && (
            <p className="text-center text-xs text-[var(--color-ink-soft)]">
              <span className="animate-pulse">正在加载更多卡片…</span>
            </p>
          )}
        </>
      )}

      <ReviewHistoryDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sessionId={sessionId}
        sessionScopeId={sessionId ?? undefined}
        onUndoSuccess={async (entry) => {
          await applyHistoryUndo({
            reviewLogId: entry.id,
            rating: entry.rating,
            word_slug: entry.word_slug,
            word_lemma: entry.word_lemma,
          });
        }}
      />
    </div>
  );
}

export function ReviewPage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const wordIdsParam = searchParams.get("wordIds");
  const freeWordIds = wordIdsParam ? wordIdsParam.split(",").filter(Boolean) : undefined;
  const [mode, setMode] = useState<"select" | "session">("select");
  const [reviewMode, setReviewMode] = useState("review");
  // 检测到未完成的复习会话时，不静默进入；先展示"继续上次 / 重新开始"确认条。
  const [pendingRestore, setPendingRestore] = useState<{ mode: string; reviewed: number; total: number } | null>(null);

  // 首次挂载时检查 localStorage 是否有可恢复的复习会话（TTL 24h，与 useReview 同口径）。
  // 命中后先提示用户选择"继续上次"或"重新开始"（不静默自动进入）；
  // 未命中则保持 select 模式让用户手动选模式。
  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      const prefix = "vocab:review:session:";
      const now = Date.now();
      const TTL = 24 * 60 * 60 * 1000;
      let best: { mode: string; reviewed: number; total: number; savedAt: number } | null = null;
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        const raw = window.localStorage.getItem(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as { mode: string; savedAt: number; stats: { reviewed: number }; completed: boolean; queue: unknown[] };
          if (now - parsed.savedAt > TTL) {
            window.localStorage.removeItem(key);
            continue;
          }
          if (parsed.completed || !parsed.queue || parsed.queue.length === 0) continue;
          // 优先选择进度最新（savedAt 最大）的会话
          if (!best || parsed.savedAt > best.savedAt) {
            best = { mode: parsed.mode, reviewed: parsed.stats.reviewed, total: parsed.queue.length, savedAt: parsed.savedAt };
          }
        } catch {
          // ignore corrupt entry
        }
      }
      if (best) {
        setPendingRestore({ mode: best.mode, reviewed: best.reviewed, total: best.total });
      }
    } catch {
      /* private mode / quota: 静默降级到 select 模式 */
    }
  }, []);

  const [forceBootstrap, setForceBootstrap] = useState(false);

  /**
   * 两条通道的待办计数（2026-10-10 隔离）。
   *
   * 复用队列全景的计数端点（`dueNow` / `new`），不新增接口 —— 与服务端分桶同源。
   * 失败静默降级为 `null`：卡片照常可点，只是不显示数字。复习是第一优先路径，
   * 计数接口挂了不该拦住用户开始。
   */
  const [channelCounts, setChannelCounts] = useState<ReviewChannelCounts | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchReviewQueue({ bucket: "all", limit: 1 })
      .then((res) => {
        if (cancelled) return;
        setChannelCounts({ dueNow: res.counts.dueNow, newCards: res.counts.new });
      })
      .catch(() => {
        if (!cancelled) setChannelCounts(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 清空指定 mode 的复习会话缓存（"重新开始/显式开始"时调用）。
  const clearModeCache = (m: string) => {
    try {
      if (typeof window === "undefined") return;
      const prefix = "vocab:review:session:";
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const key = window.localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        const raw = window.localStorage.getItem(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as { mode: string };
          if (parsed.mode === m) window.localStorage.removeItem(key);
        } catch {
          window.localStorage.removeItem(key);
        }
      }
    } catch {
      /* ignore */
    }
  };

  // 显式点击"开始"按钮：同步清对应 mode 的缓存，再进入会话（force=true 让 useReview 发起新服务器请求）。
  // 这样用户点击"开始"一定是开一个全新的会话（不会命中旧缓存）。
  const handleStart = (m: string) => {
    clearModeCache(m);
    setReviewMode(m);
    setForceBootstrap(true);
    setMode("session");
  };

  // 确认条：继续上次进度（force=false，交给 useReview 从缓存恢复）。
  const handleContinueRestore = useCallback(() => {
    if (!pendingRestore) return;
    setReviewMode(pendingRestore.mode);
    setForceBootstrap(false);
    setPendingRestore(null);
    setMode("session");
  }, [pendingRestore]);

  /**
   * 从 L3 语境看回来的自动续接（FR-12 接线1 回程，2026-10-04）。
   *
   * 为什么需要：`/review` 与 `/l3` 是同级路由，跳过去时 ReviewPage 会卸载、`mode`
   * 局部状态丢失，回来只能靠 localStorage 会话缓存复原（含 `currentIndex`）。
   * 缓存复原本来要用户再点一次「继续上次」—— 而这次跳转是**用户主动往返**、
   * 不是"上次没关掉的会话"，多一次确认点击就成了链路断点。故带 `state.fromReview`
   * 回来时直接续上；用户从别处进 `/review` 的行为**完全不变**（仍走确认条）。
   */
  const returningFromL3 = isReviewReturnNavigation(location.state);
  useEffect(() => {
    const auto = shouldAutoRestoreSession({
      fromReview: returningFromL3,
      mode,
      hasPendingRestore: pendingRestore !== null,
    });
    if (auto) handleContinueRestore();
  }, [returningFromL3, mode, pendingRestore, handleContinueRestore]);

  // 确认条：重新开始（清旧缓存 + force=true 新启一个会话）。
  const handleStartFresh = () => {
    if (!pendingRestore) return;
    clearModeCache(pendingRestore.mode);
    setReviewMode(pendingRestore.mode);
    setForceBootstrap(true);
    setPendingRestore(null);
    setMode("session");
  };

  const restoreModeTitle =
    RESTORE_MODE_TITLES[pendingRestore?.mode ?? ""] ??
    reviewModes.find((m) => m.key === pendingRestore?.mode)?.title ??
    "上次复习";
  const isFreeSelection = !!freeWordIds && freeWordIds.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title text-2xl font-bold text-[var(--color-ink)]">复习</h1>
        <p className="text-sm text-[var(--color-ink-soft)]">
          {mode === "select" ? "选择复习模式开始训练" : "复习进行中"}
        </p>
      </div>
      {mode === "select" && !isFreeSelection ? (
        <>
          {pendingRestore && (
            <Card className="border-[var(--color-accent-border,var(--color-border-strong))]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <RotateCcw className="h-5 w-5 text-[var(--color-accent)]" />
                  <div>
                    <p className="text-sm font-medium text-[var(--color-ink)]">
                      检测到未完成的{restoreModeTitle}会话（已复习 {pendingRestore.reviewed}/{pendingRestore.total}）
                    </p>
                    <p className="text-xs text-[var(--color-ink-soft)]">可继续上次进度，或清空重新开始</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={handleContinueRestore}>继续上次</Button>
                  <Button size="sm" variant="secondary" onClick={handleStartFresh}>重新开始</Button>
                </div>
              </div>
            </Card>
          )}
          <ReviewModeSelector onStart={handleStart} counts={channelCounts} />
          {/* 队列全景（P1，2026-10-10）：此前没有任何入口能看到「队列里有哪些词」，
              只有数字与日历。入口放这里 = 用户在想「我要复习点什么」时顺手可达。 */}
          <div className="flex justify-end">
            <Link
              to="/review-queue"
              className="inline-flex items-center gap-2 text-sm text-[var(--color-accent)] hover:underline"
            >
              <Layers className="h-4 w-4" />
              查看队列里有哪些词
            </Link>
          </div>
        </>
      ) : isFreeSelection ? (
        <ReviewSession reviewMode="preview" wordIds={freeWordIds} onBack={() => setMode("select")} />
      ) : reviewMode === "ladder" ? (
        // 阶梯会话：显式模式直达（ADR-0036 §4 修订）。不选它 ⇒ 本分支不可达。
        <LadderReviewSession key={forceBootstrap ? "ladder-fresh" : "ladder-restore"} onBack={() => { setForceBootstrap(false); setMode("select"); }} />
      ) : reviewMode === "cram" ? (
        <DrillSession onBack={() => setMode("select")} />
      ) : reviewMode === "hulu" ? (
        // 葫芦冲刺：显式模式直达（ADR-0041）。不选它 ⇒ 本分支不可达；
        // 与 ladder/cram 并列，不进 ReviewSession（零 FSRS 是结构性保证）。
        <HuluSprintSession onBack={() => { setForceBootstrap(false); setMode("select"); }} />
      ) : (
        // 自动恢复的会话用 force=false（缓存命中共用）；
        // 用户显式点"开始"的 handleStart 设置了 forceBootstrap=true → 清旧缓存，新启一个会话
        <BootstrapReviewSession
          reviewMode={reviewMode}
          onBack={() => { setForceBootstrap(false); setMode("select"); }}
          force={forceBootstrap}
        />
      )}
    </div>
  );
}

/**
 * 桥接组件：在 ReviewSession 之前判断是否应该复用缓存。
 * - 用户显式点击"开始"（force=true 被上层传入）：强制清对应缓存，开一个新会话；
 * - 从详情页返回 / 浏览器恢复（force=false）：若存在未完成的缓存会话则命中；否则新拉队列。
 */
function BootstrapReviewSession({ reviewMode, onBack, force }: { reviewMode: string; onBack: () => void; force?: boolean }) {
  // 显式点击"开始"：首次挂载（force=true 的那次）清掉对应 mode 的 localStorage 缓存。
  // 注意：必须用 useEffect，useMemo 不保证副作用必然执行。
  useEffect(() => {
    if (!force) return;
    try {
      if (typeof window === "undefined") return;
      const prefix = "vocab:review:session:";
      for (let i = window.localStorage.length - 1; i >= 0; i--) {
        const key = window.localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        const raw = window.localStorage.getItem(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as { mode: string };
          if (parsed.mode === reviewMode) window.localStorage.removeItem(key);
        } catch {
          window.localStorage.removeItem(key);
        }
      }
    } catch {
      /* ignore */
    }
  }, [force, reviewMode]);
  return <ReviewSession reviewMode={reviewMode} onBack={onBack} force={force} />;
}
