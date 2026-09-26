/**
 * EncodeCardView —— 新词 T3 初见编码卡（ADR-0036 LW-2，VISIT_TEMPLATE.NEW 首段）。
 *
 * state=new 词在再认轮的编码形态：自动逐级展开全部可用提示
 * （H1 例句 → H1′ 语义链 → H2 原型 → H3 助记锚，复用 buildHintSteps 降级链：
 * 数据缺失级自动跳过、isSpoiler 剧透过滤）+ 词义翻卡（H4）。
 * 「我认识」跳过提示直接首评（偏 easy）；翻卡后四键首评。
 * 首评不 POST（会话内唯一一次调度提交仍在产出轮末）。
 */

import { useMemo, useState } from "react";
import { Eye } from "lucide-react";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { Card } from "@/frontend/components/ui/Card";
import type { Rating, ReviewCard } from "@/frontend/hooks/useReview";
import { buildHintSteps, HINT_STEP_LABEL, type HintStep } from "@/frontend/reviewFlow/hintSteps";

function EncodeHintStep({ step }: { step: HintStep }) {
  if (step.kind === "example") {
    return (
      <div className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-left">
        <p className="text-[13px] leading-relaxed text-[var(--color-ink)]">{step.text}</p>
        {step.translation && (
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--color-ink-soft)]">{step.translation}</p>
        )}
      </div>
    );
  }
  if (step.kind === "chain") {
    const nodes = step.text.split("->").map((n) => n.trim()).filter(Boolean);
    return (
      <div className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-left">
        <p className="font-mono text-xs leading-relaxed text-[var(--color-ink)]">
          {nodes.map((node, i) => (
            <span key={`${node}-${i}`}>
              {i > 0 && <span className="px-1 font-bold text-[var(--color-accent)]">→</span>}
              {node}
            </span>
          ))}
        </p>
      </div>
    );
  }
  if (step.kind === "prototype") {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-left">
        <span aria-hidden className="pt-0.5">🎯</span>
        <span className="text-[12.5px] leading-relaxed text-[var(--color-ink)]">
          {step.text.replace(/\*\*/g, "").replace(/`/g, "")}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-left">
      <span aria-hidden className="pt-0.5">💡</span>
      <span className="text-[12.5px] leading-relaxed text-[var(--color-ink)]">
        {step.text}
        {step.mtype && <span className="ml-1.5 text-[10px] text-[var(--color-ink-soft)]">（{step.mtype}）</span>}
      </span>
    </div>
  );
}

interface EncodeCardViewProps {
  card: ReviewCard;
  disabled?: boolean;
  onRate: (rating: Rating) => void;
}

export function EncodeCardView({ card, disabled, onRate }: EncodeCardViewProps) {
  const [revealed, setRevealed] = useState(false);
  // 编码模式：自动逐级展开全部可用提示（缺失级已被 buildHintSteps 跳过）
  const steps = useMemo(() => buildHintSteps(card.word), [card.word]);

  return (
    <Card className="space-y-4" data-testid="encode-card-view">
      <div className="flex items-center justify-center">
        <Badge tone="warm">新词编码 · 首学</Badge>
      </div>
      <h2 className="section-title text-center text-4xl font-bold text-[var(--color-ink)]">
        {card.word.lemma}
      </h2>
      {card.word.ipa && (
        <p className="text-center font-mono text-sm text-[var(--color-ink-soft)]">{card.word.ipa}</p>
      )}

      {steps.length > 0 ? (
        <div className="space-y-1.5">
          {steps.map((step, i) => (
            <div key={`${step.kind}-${i}`} className="space-y-0.5">
              <p className="text-[10px] uppercase tracking-wider text-[var(--color-ink-soft)] opacity-70">
                {HINT_STEP_LABEL[step.kind]}
              </p>
              <EncodeHintStep step={step} />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-center text-xs text-[var(--color-ink-soft)] opacity-70">暂无提示素材，直接看释义学习</p>
      )}

      {!revealed ? (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => setRevealed(true)} disabled={disabled}>
            <Eye className="h-4 w-4" />
            看释义（H4）
          </Button>
        </div>
      ) : (
        <div className="rounded-xl bg-[var(--color-surface-muted)] px-4 py-3 text-center">
          <p className="text-lg font-medium text-[var(--color-ink)]">
            {card.word.short_definition ?? "暂无释义"}
          </p>
        </div>
      )}

      <div className="flex justify-center gap-2 pt-1" data-testid="encode-rating">
        <Button variant="secondary" size="lg" disabled={disabled} onClick={() => onRate("easy")}>
          我认识
        </Button>
        <Button variant="secondary" size="lg" disabled={disabled} onClick={() => onRate("good")}>
          有印象
        </Button>
        <Button variant="primary" size="lg" disabled={disabled || !revealed} onClick={() => onRate("hard")}>
          初见（难）
        </Button>
      </div>
      <p className="text-center text-xs text-[var(--color-ink-soft)] opacity-70">
        首学编码：提示已自动逐级展开（缺失级自动跳过）；首评在会话产出轮后随调度一并提交
      </p>
    </Card>
  );
}
