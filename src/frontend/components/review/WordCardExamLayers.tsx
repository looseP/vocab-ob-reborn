/**
 * 复习卡「例句线索区 + 训练扩展 + 例句层」三件套（2026-09-29）。
 *
 * 移植自未合并的 `a5d0f60` / `86d9b3f`（备份于 `backup/hint-ladder-unpushed-2026-09-28`），
 * 按 **wordcard-mock** 口径实现：mock 类名 `.clue-zone` / `.clue-split` / `.mask` /
 * `.ex-layer` / `fold` / `pattern-box` 一一对应。
 *
 * 设计意图（这是**训练区**不是阅读区 —— 与"把三层摊开给人读"方向相反）：
 * - **正面 ClueZone**：例句**先出现**，但目标词被遮盖（`--color-highlight` 同色底，
 *   看不见但占位），按轨色切分（main 主轨 / mod 修饰轨 / supp 补充轨）。
 *   记忆任务从"看整句回想"变成"**在语境里回想词形**"。
 * - **H1 提示语义 =「揭示词形」**：例句已在正面，此级只负责**解锁词形**，
 *   不是再给一遍整句。评分上限经济学不变（0→easy / 1→good / ≥2→hard）。
 * - **正面 TrainingFold**：译点**金块遮盖点击自检**（先猜后看，揭示后才附 tag/note），
 *   骨架句式直接可见（`pattern-box`）+ 功能徽章 + 适用 + 仿写 + 已核验。
 * - **卡背 ExampleLayerBlock**：完整例句（目标词 `<mark>` 高亮）+ 译文 + 来源/核验徽章。
 *
 * 数据解析复用 `@/domain/word-exam`（PR #167 的严格契约层，有 13 例单测），
 * 而非参考实现里的宽松 `asString` 直取 —— `words.examples` 是 jsonb，
 * 形状不受类型系统保护（实测 `reading.structure` 缺 95/6731）。
 */
import { useState } from "react";
import { ChevronDown, Volume2 } from "lucide-react";
import { Badge } from "@/frontend/components/ui/Badge";
import { parseWordExam, type WordExam } from "@/domain/word-exam";

/** 轨色（切分设计说明书）：main 主干轨 / mod 修饰轨 / supp 补充轨。 */
const RAIL_COLOR: Record<"main" | "mod" | "supp", string> = {
  main: "var(--color-accent)",
  mod: "rgba(178, 87, 47, 0.55)",
  supp: "rgba(103, 77, 44, 0.32)",
};

/** 轨色正则元字符转义（目标词可能含 . 或 -）。 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `verified.checked` 条目数（产线核验遗留；非数组/缺失 → 0）。 */
function parseVerifiedCount(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) return 0;
  const checked = (raw as { checked?: unknown }).checked;
  return Array.isArray(checked) ? checked.length : 0;
}

/** 切分片段渲染：`[]` 标记拆成尖括号强调（mock .nest 口径）。 */
function SplitSegment({ text, highlight }: { text: string; highlight?: string | null }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  const hl = highlight && highlight.trim().length > 0 ? highlight : null;
  const hlRe = hl ? new RegExp(`(${escapeRegExp(hl)})`, "gi") : null;
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("[") && part.endsWith("]")) {
          return (
            <span key={i} className="font-medium text-[var(--color-accent)]">
              {part.slice(1, -1)}
            </span>
          );
        }
        if (!hlRe || !hl) return <span key={i}>{part}</span>;
        return (
          <span key={i}>
            {part.split(hlRe).map((piece, j) =>
              piece.toLowerCase() === hl.toLowerCase() ? (
                <span key={j} className="font-semibold text-[var(--color-accent)]">
                  {piece}
                </span>
              ) : (
                <span key={j}>{piece}</span>
              ),
            )}
          </span>
        );
      })}
    </>
  );
}

/**
 * 目标词遮挡文本（mock `.mask` 口径）：未揭示时以**高亮底色隐形**呈现（点击揭示），
 * 揭示后按强调色显示。`term` 为空退化为普通渲染。
 */
function MaskedText({
  text,
  term,
  revealed,
  onUnmask,
}: {
  text: string;
  term: string | null;
  revealed: boolean;
  onUnmask?: () => void;
}) {
  if (!term || term.trim().length === 0) return <SplitSegment text={text} />;
  if (revealed) return <SplitSegment text={text} highlight={term} />;
  const parts = text.split(new RegExp(`(${escapeRegExp(term)})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === term.toLowerCase() ? (
          <span
            key={i}
            role="button"
            tabIndex={0}
            title="点击揭示词形（消耗 H1 提示）"
            data-testid="clue-mask"
            className="inline-block min-w-[4.2em] cursor-pointer rounded-md px-1 text-center align-baseline transition-colors"
            // 同色底 + 同色字 = 隐形但占位：保留句法结构，不泄露词形长度以外的信息
            style={{ background: "var(--color-highlight)", color: "var(--color-highlight)" }}
            onClick={(e) => {
              e.stopPropagation();
              onUnmask?.();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onUnmask?.();
              }
            }}
          >
            {part}
          </span>
        ) : (
          <SplitSegment key={i} text={part} />
        ),
      )}
    </>
  );
}

/** 卡背完整例句：目标词 `<mark>` 高亮（mock `.ex-sentence mark` 口径）。 */
function MarkedSentence({ text, term }: { text: string; term: string | null }) {
  if (!term || term.trim().length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(term)})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === term.toLowerCase() ? (
          <mark
            key={i}
            className="rounded px-0.5 font-semibold"
            style={{ background: "var(--color-highlight)" }}
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/**
 * 轨色切分行（mock `.clue-split` 口径）：main/mod/supp 三轨 + 角色标签 + `[]` 嵌套着色
 * + 目标词遮挡。
 */
function SplitLines({
  exam,
  maskTerm,
  maskRevealed,
  onUnmask,
}: {
  exam: WordExam;
  maskTerm?: string | null;
  maskRevealed?: boolean;
  onUnmask?: () => void;
}) {
  const blocks = exam.reading?.blocks ?? [];
  if (blocks.length === 0) return null;
  return (
    <ol className="space-y-1" data-testid="clue-split">
      {blocks.map((block, i) => {
        const role = block.roleKind ?? "supp";
        const label = block.role ?? "";
        return (
          <li key={`${block.text.slice(0, 20)}-${i}`} className="flex items-start gap-2">
            <span
              aria-hidden
              className="mt-[0.45em] h-[0.9em] w-[3px] flex-none rounded-full"
              style={{ background: RAIL_COLOR[role] }}
            />
            <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-[var(--color-ink)]">
              <MaskedText
                text={block.text}
                term={maskTerm ?? null}
                revealed={maskRevealed ?? true}
                onUnmask={onUnmask}
              />
            </span>
            {label && (
              // 窄屏隐藏（对齐 mock `wordcard-mock-2026-09-11.html:206` 的
              // `@media (max-width: 520px) { .split-line .sl-role { display: none } }`）。
              // 390px 下这个 58px 的标签要吃掉卡片内容宽（258px）的 22%，
              // 正文被压成每 2-3 词换行；轨色本身仍在，主干/修饰的区分不丢失。
              <span className="max-w-[11em] flex-none text-right text-[10px] leading-snug text-[var(--color-ink-soft)] max-[520px]:hidden">
                {label}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 正面「例句线索区」（mock `.clue-zone` 口径）：目标词遮盖 + 轨色切分，
 * 先在语境里回想。**无切分数据的 v1 批次退化为整句遮盖**。
 *
 * 「听例句」定位为**听觉线索**（Phase 1）：与"揭示词形（H1）"正交 ——
 * 听整句不泄露词形，故不消耗 H1 提示上限；对听觉型学习者是独立的提取线索。
 *
 * ⚠️ 按钮文案**不得写「真题例句」**。实测真库 `words.examples[0].source_type`
 * 全量分布为 press 6407 / reference 302 / institution 38 / academic 16 / quote 3 / media 1，
 * 且 `source ~ '考研|真题'` 命中 **0 条** —— 例句来自报刊与词典，不是历年真题原文。
 * 「真题例句」一词源自 `docs/superpowers/specs/2026-07-06-*.md` 里 `corpus_items`（语料例句）
 * 的旧括注，被从 L3 语境（L3 用「真题」正确）误带进 L1。卡背同一句标的是「朗读例句」
 * 并如实显示来源，两侧必须一致。**改回「真题」前请先跑 `docs/plan/` 里的来源核查。**
 */
export function ClueZone({
  exam,
  text,
  maskTerm,
  maskRevealed,
  onUnmask,
  onPlaySentence,
  sentencePlaying,
}: {
  exam: WordExam | null;
  text: string | null;
  maskTerm: string | null;
  maskRevealed: boolean;
  onUnmask: () => void;
  onPlaySentence?: () => void;
  sentencePlaying?: boolean;
}) {
  const hasSplit = (exam?.reading?.blocks.length ?? 0) > 0;
  if (!text) return null;
  return (
    <div
      className="mt-4 w-full rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[rgba(255,253,248,0.6)] px-3.5 py-3 text-left"
      data-testid="clue-zone"
      data-no-flip
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-[var(--color-ink-soft)]">
        <span className="rounded bg-[var(--color-accent-2)] px-1 py-px text-[10px] font-bold tracking-wider text-white">
          例句线索
        </span>
        <span>（H1）· 目标词已遮盖 · 先在语境里回想</span>
        {onPlaySentence && (
          <button
            type="button"
            data-no-flip
            data-testid="clue-play-example"
            aria-label="朗读例句 (E)"
            title="朗读例句（快捷键 E）· 听觉线索，不消耗 H1 提示"
            onClick={(e) => {
              e.stopPropagation();
              onPlaySentence();
            }}
            className="ml-auto inline-flex flex-none items-center gap-1 rounded-full border border-dashed border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <Volume2 className="h-3 w-3" /> {sentencePlaying ? "播放中…" : "听例句"}
          </button>
        )}
      </div>
      {hasSplit && exam ? (
        <SplitLines
          exam={exam}
          maskTerm={maskTerm}
          maskRevealed={maskRevealed}
          onUnmask={onUnmask}
        />
      ) : (
        <p className="text-[13.5px] leading-relaxed text-[var(--color-ink)]">
          <MaskedText text={text} term={maskTerm} revealed={maskRevealed} onUnmask={onUnmask} />
        </p>
      )}
    </div>
  );
}

/**
 * 正面「训练扩展」折叠（mock `fold` 口径）：译点与骨架自检 ——
 * 译点**参考处理以金块遮盖**（点一下揭示，"先猜后看"）；骨架句式直接可见，附适用与核验状态。
 *
 * 金块遮罩用 `data-masked` 标记而非只靠内联样式：断言与调试都需要一个稳定钩子，
 * 内联 style 的具体色值属于视觉细节，不该成为测试契约。
 */
export function TrainingFold({ exam, verifiedCount }: { exam: WordExam | null; verifiedCount: number }) {
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const keyPoints = exam?.translation?.keyPoints ?? [];
  const pattern = exam?.writing?.pattern ?? null;
  const usage = exam?.writing?.usage ?? null;
  const imit = exam?.writing?.imitatingExample ?? null;
  const fn = exam?.writing?.functionLabel ?? null;
  if (!exam || (keyPoints.length === 0 && !pattern)) return null;

  const toggle = (index: number) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  const KHOLE = { background: "rgba(243,220,162,0.72)", color: "rgba(243,220,162,0.72)" } as const;

  return (
    <details
      className="group mt-2.5 w-full rounded-xl border border-dashed border-[var(--color-border)]"
      data-testid="training-fold"
      data-no-flip
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs text-[var(--color-ink-soft)]">
        <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
        训练扩展 · 译点与骨架（点金块自检 · 先猜后看）
      </summary>
      <div className="flex flex-col gap-2.5 border-t border-[var(--color-border)] px-3 py-2.5 text-left text-[12.5px]">
        {keyPoints.length > 0 && (
          <div className="flex gap-2">
            <span className="w-11 flex-none pt-0.5 text-right text-[11px] text-[var(--color-ink-soft)]">
              译点
            </span>
            <div className="min-w-0 flex-1 space-y-1.5">
              {keyPoints.map((kp, i) => (
                <div
                  key={`${kp.tag}-${i}`}
                  className="cursor-pointer"
                  data-testid="training-key-point"
                  onClick={() => toggle(i)}
                  title={revealed.has(i) ? "点击遮回" : "点击揭示参考译文"}
                >
                  <span className="font-semibold text-[var(--color-ink)]">{kp.text}</span>
                  {kp.translation && (
                    <>
                      <span className="mx-1 text-[var(--color-accent)]">·</span>
                      <span
                        className="inline-block rounded px-1 transition-colors"
                        data-masked={revealed.has(i) ? undefined : "true"}
                        style={revealed.has(i) ? undefined : KHOLE}
                      >
                        {kp.translation}
                      </span>
                    </>
                  )}
                  {revealed.has(i) && kp.tag && (
                    <span className="ml-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1 py-px text-[10px] text-[var(--color-ink-soft)]">
                      {kp.tag}
                    </span>
                  )}
                  {revealed.has(i) && kp.kind && (
                    <span className="ml-1 text-[10px] text-[var(--color-ink-soft)] opacity-70">
                      {kp.kind}
                    </span>
                  )}
                  {revealed.has(i) && kp.note && (
                    <span className="ml-1.5 text-[11px] text-[var(--color-ink-soft)]">{kp.note}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {pattern && (
          <div className="flex gap-2">
            <span className="w-11 flex-none pt-0.5 text-right text-[11px] text-[var(--color-ink-soft)]">
              骨架
            </span>
            <div className="min-w-0 flex-1">
              <pre
                className="whitespace-pre-wrap break-words rounded-lg bg-[#2a2118] px-3 py-2 font-mono text-[11.5px] leading-relaxed text-[#f5e9d8]"
                data-testid="pattern-box"
              >
                {pattern}
              </pre>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-ink-soft)]">
                {fn && <Badge tone="warm">{fn}</Badge>}
                {usage && <span>适用：{usage}</span>}
                {imit && <span className="text-[var(--color-ink)]">仿写：{imit}</span>}
                {verifiedCount > 0 && <b className="text-[var(--color-accent-2)]">✓已核</b>}
              </p>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * 卡背「例句层」（mock `.ex-layer` 口径）：完整例句（目标词 `mark` 高亮）+ 译文
 * + 来源/核验徽章 + **原声朗读**（听写复核 / 原句跟读）。
 */
export function ExampleLayerBlock({
  text,
  translation,
  term,
  source,
  sourceType,
  url,
  modified,
  verifiedCount,
  onPlaySentence,
  sentencePlaying,
}: {
  text: string | null;
  translation: string | null;
  term: string | null;
  source: string | null;
  sourceType: string | null;
  url: string | null;
  modified: boolean;
  verifiedCount: number;
  onPlaySentence?: () => void;
  sentencePlaying?: boolean;
}) {
  if (!text) return null;
  return (
    <div
      className="mt-3 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3 text-left"
      data-testid="ex-layer"
      data-no-flip
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-ink)]">
          <span className="rounded bg-[var(--color-accent-2)] px-1 py-px text-[10px] font-bold tracking-wider text-white">
            例句 · H1
          </span>
        </span>
        <div className="flex flex-none items-center gap-2">
          {onPlaySentence && (
            <button
              type="button"
              data-no-flip
              data-testid="ex-layer-play"
              aria-label="朗读例句 (E)"
              title="朗读例句（快捷键 E）· 听写复核与原句跟读"
              onClick={(e) => {
                e.stopPropagation();
                onPlaySentence();
              }}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border-strong)] px-2 py-0.5 text-[10px] text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              <Volume2 className="h-3 w-3" /> {sentencePlaying ? "播放中…" : "朗读例句"}
            </button>
          )}
          <span className="text-right text-[11px] text-[var(--color-ink-soft)]">
            {[sourceType, source].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>
      <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--color-ink)]">
        <MarkedSentence text={text} term={term} />
      </p>
      {translation && (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-ink-soft)]">
          {translation}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {verifiedCount > 0 && <Badge>✓已核</Badge>}
        {modified && <Badge tone="warm">来源·改</Badge>}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-[var(--color-ink-soft)] underline transition-colors hover:text-[var(--color-accent)]"
          >
            原文
          </a>
        )}
      </div>
    </div>
  );
}

export { parseWordExam, parseVerifiedCount };
