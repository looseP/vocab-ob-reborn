/**
 * L3 练习台（ADR-0019 §1/§3）：作文句默写 + 记录版语境自测。
 *
 * - 素材：occurrences 列表读（space/direction 两轴 + cursor）经共享客户端；
 * - 出题：viewModels/l3PracticeViewModel 做挖空 / 判定（与 T04 同规则）；
 * - 记录：每次作答 POST attempts（payload.taskId = T04 形状的确定性幂等身份，
 *   用浏览器 Web Crypto 派生）；**只写 attempts，零 FSRS**；
 * - 文案：明确「只记录作答」，不暗示任何复习排程影响。
 */
import { useState } from "react";
import type { Direction, L3PracticeOutcome, L3PracticeType, L3SubSpace } from "@/domain";
import { L3ErrorMessage } from "../components/L3ErrorMessage";
import { L3NavigationActions } from "../components/L3NavigationActions";
import { Reveal } from "../components/ui/Reveal";
import {
  isNormalizedL3Error,
  L3_DIRECTION_VALUES,
  L3_SUB_SPACE_VALUES,
  normalizeL3TransportError,
  type L3FrontendClient,
  type NormalizedL3Error,
} from "@/l3/frontend/contract";
import { navigationAction, type L3NavigationIntent } from "../viewModels/l3NavigationViewModel";
import {
  buildPracticeSeed,
  buildPracticeSnapshot,
  buildPracticeTasks,
  computePracticeTaskId,
  findFirstTargetMatch,
  judgeDictation,
  L3_PRACTICE_MATERIAL_LIMIT,
  newPracticeRunId,
  outcomeLabel,
  practiceTypeLabel,
  type PracticeMaterialTask,
} from "../viewModels/l3PracticeViewModel";

interface L3PracticePageProps {
  client: L3FrontendClient;
  onNavigate(intent: L3NavigationIntent): void;
}

type PracticePhase = "idle" | "loading" | "running" | "finished";

const PRACTICE_TYPES: readonly L3PracticeType[] = ["essay_dictation", "context_quiz"];

function normalizeUnknownError(error: unknown): NormalizedL3Error {
  return isNormalizedL3Error(error) ? error : normalizeL3TransportError(error);
}

/** 目标词高亮（语境自测的原句展示；定位不到时原样输出）。 */
function renderHighlightedText(text: string, target: string) {
  const match = findFirstTargetMatch(text, target);
  if (!match) return text;
  return (
    <>
      {text.slice(0, match.start)}
      <mark className="rounded bg-[var(--color-highlight)] px-0.5">{match.text}</mark>
      {text.slice(match.end)}
    </>
  );
}

export function L3PracticePage({ client, onNavigate }: L3PracticePageProps) {
  const [space, setSpace] = useState<L3SubSpace | null>(null);
  const [direction, setDirection] = useState<Direction | null>(null);
  const [practiceType, setPracticeType] = useState<L3PracticeType>("essay_dictation");
  const [phase, setPhase] = useState<PracticePhase>("idle");
  const [tasks, setTasks] = useState<PracticeMaterialTask[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [runId, setRunId] = useState("");
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<NormalizedL3Error | null>(null);
  const [recordError, setRecordError] = useState<NormalizedL3Error | null>(null);
  const [stats, setStats] = useState({ answered: 0, correct: 0, wrong: 0, skip: 0 });
  const [lastOutcome, setLastOutcome] = useState<L3PracticeOutcome | null>(null);

  const current = phase === "running" ? (tasks[index] ?? null) : null;

  const start = async () => {
    setLoadError(null);
    setRecordError(null);
    setPhase("loading");
    try {
      const page = await client.listOccurrences({ space, direction, limit: L3_PRACTICE_MATERIAL_LIMIT });
      const built = buildPracticeTasks(page.items, practiceType);
      setTasks(built.tasks);
      setSkipped(built.skipped);
      setRunId(newPracticeRunId());
      setIndex(0);
      setDraft("");
      setLastOutcome(null);
      setStats({ answered: 0, correct: 0, wrong: 0, skip: 0 });
      setPhase(built.tasks.length > 0 ? "running" : "finished");
    } catch (caught) {
      setLoadError(normalizeUnknownError(caught));
      setPhase("idle");
    }
  };

  const record = async (outcome: L3PracticeOutcome, userInput: string | null) => {
    if (!current || submitting) return;
    setSubmitting(true);
    setRecordError(null);
    try {
      // 幂等身份：同一 (演练, 语境, 题序) 重放恒同 taskId（服务端命中即返回既有行）。
      const seed = buildPracticeSeed(runId, current.contextId, index);
      const taskId = await computePracticeTaskId(current.practiceType, seed);
      await client.recordAttempt({
        contextId: current.contextId,
        occurrenceId: current.occurrenceId,
        sessionId: null,
        practiceType: current.practiceType,
        outcome,
        payload: { taskId, ...buildPracticeSnapshot({ task: current, userInput }) },
      });
      setStats((prev) => {
        const next = { ...prev, answered: prev.answered + 1 };
        if (outcome === "correct") next.correct += 1;
        else if (outcome === "wrong") next.wrong += 1;
        else next.skip += 1;
        return next;
      });
      setLastOutcome(outcome);
      const nextIndex = index + 1;
      if (nextIndex >= tasks.length) {
        setPhase("finished");
      } else {
        setIndex(nextIndex);
        setDraft("");
      }
    } catch (caught) {
      setRecordError(normalizeUnknownError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const submitDictation = () => {
    if (!current || !current.blankText || submitting) return;
    const input = draft.trim();
    if (!input) return;
    void record(judgeDictation(input, current.blankText) ? "correct" : "wrong", draft);
  };

  return (
    <section className="l3-page space-y-4">
      <p className="eyebrow">L3 Practice</p>
      <h2>练习：默写与记录版语境自测</h2>
      <p className="lede">
        从按子空间 / 方向筛选的语境素材出题。练习只记录作答到练习记录（供错题库回看），不改动任何其他学习数据。
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-[var(--color-ink-soft)]">
          题型
          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
            disabled={phase === "loading" || submitting}
            onChange={(event) => setPracticeType(event.target.value as L3PracticeType)}
            value={practiceType}
          >
            {PRACTICE_TYPES.map((type) => (
              <option key={type} value={type}>{practiceTypeLabel(type)}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-ink-soft)]">
          子空间
          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
            disabled={phase === "loading" || submitting}
            onChange={(event) => setSpace((event.target.value || null) as L3SubSpace | null)}
            value={space ?? ""}
          >
            <option value="">全部</option>
            {L3_SUB_SPACE_VALUES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--color-ink-soft)]">
          方向
          <select
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px]"
            disabled={phase === "loading" || submitting}
            onChange={(event) => setDirection((event.target.value || null) as Direction | null)}
            value={direction ?? ""}
          >
            <option value="">全部</option>
            {L3_DIRECTION_VALUES.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <button
          className="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50"
          disabled={phase === "loading" || submitting}
          onClick={() => void start()}
          type="button"
        >
          {phase === "loading" ? "加载素材…" : phase === "running" ? "换一批" : "开始练习"}
        </button>
      </div>

      <L3ErrorMessage error={loadError} />

      {phase === "running" && current && (
        <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
          <p className="text-[11px] text-[var(--color-ink-soft)]">
            第 {index + 1} / {tasks.length} 题 · {practiceTypeLabel(current.practiceType)} · 来源：{current.sourceTitle}
          </p>

          {current.practiceType === "essay_dictation" ? (
            <>
              <p className="text-[11px] text-[var(--color-ink-soft)]">把空位补全（目标词：{current.target}）。</p>
              <p className="text-[13.5px] leading-relaxed">{current.promptText}</p>
              <div className="flex gap-2">
                <input
                  className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-input)] px-3 py-2 text-[13px]"
                  disabled={submitting}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") submitDictation(); }}
                  placeholder="输入空位处的原文片段"
                  value={draft}
                />
                <button
                  className="shrink-0 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50"
                  disabled={submitting || !draft.trim()}
                  onClick={submitDictation}
                  type="button"
                >
                  提交判定
                </button>
                <button
                  className="shrink-0 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-ink-soft)] disabled:opacity-50"
                  disabled={submitting}
                  onClick={() => void record("skip", null)}
                  type="button"
                >
                  跳过
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[11px] text-[var(--color-ink-soft)]">先回忆：这个词在这句话里是什么意思？再点击揭示并自评。</p>
              <p className="text-[13.5px] leading-relaxed">
                {renderHighlightedText(current.promptText, current.target)}
              </p>
              {current.boundSense && (
                <p className="text-[12px] text-[var(--color-accent)]">
                  绑定释义：<Reveal>{current.boundSense}</Reveal>
                </p>
              )}
              <div className="flex gap-2">
                <button
                  className="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-xs text-[var(--color-accent-contrast,var(--color-surface))] disabled:opacity-50"
                  disabled={submitting}
                  onClick={() => void record("correct", null)}
                  type="button"
                >
                  想起来了
                </button>
                <button
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-ink-soft)] disabled:opacity-50"
                  disabled={submitting}
                  onClick={() => void record("wrong", null)}
                  type="button"
                >
                  没想起来
                </button>
                <button
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-ink-soft)] disabled:opacity-50"
                  disabled={submitting}
                  onClick={() => void record("skip", null)}
                  type="button"
                >
                  跳过
                </button>
              </div>
            </>
          )}

          {lastOutcome && (
            <p className="text-[11px] text-[var(--color-ink-soft)]">最近一次：已记录（{outcomeLabel(lastOutcome)}）</p>
          )}
          <L3NavigationActions
            actions={[navigationAction("查看语境", { target: "context", contextId: current.contextId })]}
            onNavigate={onNavigate}
          />
          <L3ErrorMessage error={recordError} />
        </div>
      )}

      {phase === "finished" && (
        <div className="space-y-2 rounded-lg border border-[var(--color-border)] px-4 py-3">
          <strong className="text-[13px]">
            {stats.answered > 0 ? "本批完成" : "当前筛选下没有可练习的素材"}
          </strong>
          {stats.answered > 0 && (
            <p className="text-[12px] text-[var(--color-ink-soft)]">
              已记录 {stats.answered} 题：正确 {stats.correct} / 错误 {stats.wrong} / 跳过 {stats.skip}。
            </p>
          )}
          {skipped > 0 && (
            <p className="text-[11px] text-[var(--color-ink-soft)]">
              另有 {skipped} 条素材缺少目标词或绑定释义，已跳过。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
