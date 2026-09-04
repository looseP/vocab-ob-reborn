import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, CheckCircle2, XCircle, RotateCcw } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { Input } from "@/frontend/components/ui/Input";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { useDrill } from "@/frontend/hooks/useDrill";
import { maskLemma } from "@/services/drill-engine";
import type { DrillMode } from "@/services/drill-engine";

const DRILL_MODES: Array<{ id: DrillMode; label: string; desc: string }> = [
  { id: "cloze", label: "完形填空", desc: "根据上下文例句，填入缺失的单词" },
  { id: "definition", label: "词汇填空", desc: "根据释义和首尾字母，写出完整单词" },
] as const;

function DrillVariantPicker({ onStart, onBack }: { onStart: (v: DrillMode) => void; onBack: () => void }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {DRILL_MODES.map((m) => (
          <Card key={m.id} className="h-full">
            <h3 className="text-lg font-semibold text-[var(--color-ink)]">{m.label}</h3>
            <p className="mb-4 mt-1 text-sm text-[var(--color-ink-soft)]">{m.desc}</p>
            <Button onClick={() => onStart(m.id)}>开始</Button>
          </Card>
        ))}
      </div>
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> 返回
        </Button>
      </div>
    </div>
  );
}

/**
 * L1 练习变体（cram drill）会话：输入答案、即时反馈、错题回尾。
 * 纯前端状态机，不写任何复习数据。
 */
export function DrillSession({ onBack }: { onBack: () => void }) {
  const drill = useDrill();
  const [input, setInput] = useState("");
  const [pickedVariant, setPickedVariant] = useState(false);

  const handleStart = (v: DrillMode) => {
    setPickedVariant(true);
    drill.startDrill(v);
  };

  if (!pickedVariant) {
    return <DrillVariantPicker onStart={handleStart} onBack={onBack} />;
  }

  if (drill.loading && !drill.currentCard) {
    return (
      <Card className="flex items-center justify-center py-20">
        <Spinner />
        <span className="ml-3 text-[var(--color-ink-soft)]">加载练习队列...</span>
      </Card>
    );
  }

  if (drill.error && !drill.currentCard) {
    return (
      <Card>
        <EmptyState
          title="无法加载练习"
          description={drill.error}
          action={
            <Button onClick={() => setPickedVariant(false)}>
              <RotateCcw className="h-4 w-4" />返回选择
            </Button>
          }
        />
      </Card>
    );
  }

  if (!drill.currentCard) {
    // 完成：队列清空（错题已全部答对）
    return (
      <Card className="space-y-4 py-10 text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-[var(--color-accent)]" />
        <h3 className="text-xl font-semibold text-[var(--color-ink)]">练习完成！</h3>
        <div className="flex justify-center gap-3">
          <Badge tone="accent">答对 {drill.stats.correct}</Badge>
          <Badge tone="warm">答错 {drill.stats.incorrect}</Badge>
          <Badge>共 {drill.stats.answered} 题</Badge>
        </div>
        <p className="text-sm text-[var(--color-ink-soft)]">本次练习未写入任何复习数据</p>
        <div className="flex justify-center gap-3 pt-2">
          <Button onClick={() => setPickedVariant(false)}>
            <RotateCcw className="h-4 w-4" /> 再来一轮
          </Button>
          <Button variant="secondary" onClick={onBack}>返回</Button>
        </div>
      </Card>
    );
  }

  const card = drill.currentCard;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || drill.feedback) return;
    drill.submit(input);
    setInput("");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Badge tone="accent">答对 {drill.stats.correct}</Badge>
          <Badge tone="warm">答错 {drill.stats.incorrect}</Badge>
          <Badge>剩余 {drill.remaining}</Badge>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>退出</Button>
      </div>

      <Card className="space-y-6">
        <div className="flex items-center justify-between">
          <Badge tone="accent">{drill.variant === "cloze" ? "完形填空" : "词汇填空"}</Badge>
          <Link to={`/words/${card.slug}`} className="text-sm font-semibold text-[var(--color-accent)]">
            查看详情
          </Link>
        </div>

        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-6 py-8 text-center">
          {drill.variant === "cloze" ? (
            <>
              <p className="text-xl leading-relaxed text-[var(--color-ink)]">{card.clozeText}</p>
              <span className="mt-3 inline-block text-xs text-[var(--color-ink-soft)]">
                ({card.clozeLength} 个字母)
              </span>
            </>
          ) : (
            <>
              <p className="text-lg text-[var(--color-ink)]">{card.shortDefinition ?? "暂无释义"}</p>
              <p className="mt-4 font-mono text-2xl tracking-widest text-[var(--color-ink)]">
                {maskLemma(card.lemma)}
              </p>
            </>
          )}
        </div>

        {drill.feedback ? (
          <div className="space-y-3">
            <div
              className={`flex items-center gap-2 rounded-xl border px-4 py-3 ${
                drill.feedback.correct
                  ? "border-[var(--color-border)] bg-[var(--color-surface-muted)]"
                  : "border-[var(--color-warm-border,transparent)] bg-[var(--color-surface-muted)]"
              }`}
            >
              {drill.feedback.correct ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--color-accent)]" />
              ) : (
                <XCircle className="h-5 w-5 shrink-0 text-[var(--color-accent-2)]" />
              )}
              <div className="text-left">
                <p className="font-medium text-[var(--color-ink)]">
                  {drill.feedback.correct ? "回答正确" : `回答错误，正确答案：${drill.feedback.correctAnswer}`}
                </p>
                {!drill.feedback.correct && drill.feedback.source && (
                  <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{drill.feedback.source}</p>
                )}
              </div>
            </div>
            <div className="flex justify-center">
              <Button size="lg" onClick={drill.nextCard}>继续</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入单词..."
              autoFocus
              className="text-center text-lg"
            />
            <div className="flex justify-center gap-3">
              <Button type="submit" size="lg" disabled={!input.trim()}>提交</Button>
              <Button variant="ghost" size="lg" onClick={drill.defer}>晚点再看</Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
