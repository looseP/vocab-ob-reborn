/**
 * LadderReviewSession —— 阶梯复习会话（ADR-0036，LW-1）。
 *
 * 队列拉取复用 useReview 的 startReview（缓存/会话语义不变），拉到后经
 * sessionScheduler 排三轮队列；逐 visit 渲染，**每词每会话恰好一次
 * POST /review/answer**（产出轮末，rating = 政策 B final + metadata 全量）；
 * 再认轮自评 / 巩固轮跟写 / 词义卡复核全部前端暂存，不 POST。
 * 阶梯模式禁用 undo（会话内无中间 answer 可撤）。
 *
 * 拍板⑦：档位菜单常驻于默写视图；R3 词产出完成后词义卡复核入队尾（拍板⑥）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Sparkles } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { ReviewCardView } from "@/frontend/components/review/ReviewCardView";
import { FollowCopyView } from "@/frontend/components/review/FollowCopyView";
import { TypingDictationView } from "@/frontend/components/review/TypingDictationView";
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
  const [settlement, setSettlement] = useState<LadderSettlementRow[]>([]);

  // 进入会话：拉队列（复用现行缓存语义），成功后由 effect 排三轮。
  useEffect(() => {
    void startReview("review");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (queue.length === 0 || visits.length > 0) return;
    setVisits(buildLadderSession(queue));
  }, [queue, visits.length]);

  const cardsByProgressId = useMemo(() => {
    const map = new Map<string, ReviewCard>();
    for (const card of queue) map.set(card.progressId, card);
    return map;
  }, [queue]);

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

  const advance = useCallback(() => {
    setPos((p) => {
      const next = p + 1;
      if (next >= visits.length) setCompleted(true);
      return next;
    });
  }, [visits.length]);

  /** 产出轮末：组装唯一一次 answer 提交（rating = 政策 B final + metadata 全量）。 */
  const submitWordAnswer = useCallback(async (visit: LadderVisit) => {
    const card = cardsByProgressId.get(visit.progressId);
    const scratch = scratchFor(visit.progressId);
    if (!card || !sessionId || !scratch.dictResult) {
      // 无会话/无默写结果：跳过调度（防御分支，正常流不触达）
      advance();
      return;
    }
    const rung = (card.ladderRung ?? 1) as LadderRung;
    const dictMap = scratch.dictResult.dictMap;
    const rating = policyBFinal({ ladderRung: rung, cardRating: scratch.cardRating, dictMap });
    const durationMs = Math.max(0, Date.now() - scratch.startedAt);
    const downgraded = scratch.dictResult.tier !== "dictation";
    setSubmitting(true);
    try {
      await apiFetch("/review/answer", {
        method: "POST",
        body: JSON.stringify({
          progressId: visit.progressId,
          sessionId,
          mode: "review",
          rating,
          idempotencyKey: newIdempotencyKey(),
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
        setVisits((prevVisits) => [...prevVisits, { qi: visit.qi, progressId: visit.progressId, pass: 3, stage: "meaning", meaningReview: true }]);
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
  }, [cardsByProgressId, sessionId, advance, addToast]);

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

  if (loading && queue.length === 0) {
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
  if (!loading && queue.length === 0 && visits.length === 0) {
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
          <Button variant="secondary" onClick={onBack}>返回</Button>
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
        <Button variant="ghost" size="sm" onClick={onBack}>退出</Button>
      </div>

      {current.stage === "follow" ? (
        <FollowCopyView
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
          lemma={currentCard.word.lemma}
          definition={currentCard.word.short_definition}
          ipa={currentCard.word.ipa}
          disabled={submitting}
          onDone={onDictationDone}
        />
      ) : current.stage === "meaning" ? (
        <div data-testid="meaning-review">
          <Badge tone="accent">词义卡复核（无调度语义）</Badge>
          <ReviewCardView
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
