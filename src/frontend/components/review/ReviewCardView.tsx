import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/frontend/components/ui/Button";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { Markdown } from "@/frontend/components/ui/Markdown";
import { useToast } from "@/frontend/components/ui/Toast";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Eye,
  EyeOff,
  Plus,
  StickyNote,
  TrendingUp,
  Zap,
} from "lucide-react";
import type { Rating, ReviewCard, ReviewNoteEntry } from "@/frontend/hooks/useReview";
import { labelReviewState } from "@/frontend/hooks/useReview";
import { useWordDetail, type WordDetail } from "@/frontend/hooks/useWordDetail";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { L3ContextsFold } from "@/frontend/components/review/L3ContextsFold";

const ratings = [
  { value: "again", label: "重来", variant: "danger" as const, key: "1" },
  { value: "hard", label: "困难", variant: "secondary" as const, key: "2" },
  { value: "good", label: "良好", variant: "secondary" as const, key: "3" },
  { value: "easy", label: "轻松", variant: "primary" as const, key: "4" },
] as const;

const TA_CLASS =
  "min-h-[56px] w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-input)] p-2 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-soft)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]";

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="ml-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink-soft)]">
      {children}
    </kbd>
  );
}

/**
 * 记忆锚核心提取:精修版 mnemonic_text 可能是「核心 text 行 + **词源锚** + **画面锚**」
 * 拼接块(导入时词源锚/画面锚并入),而词源锚与 Tier 2 词源、画面锚与原型信息重复。
 * 只取非锚段的核心行;整块都是锚段(核心丢失)时返回 null —— 胶囊优雅缺席。
 * 同时剥离 ** 与 ` 记号,胶囊按纯文本呈现。
 */
function extractMnemonicCore(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const segments = raw
    .split(/(?=\*\*词源锚)|(?=\*\*画面锚)|\n/)
    .map((segment) =>
      segment
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .replace(/^- (?:text:\s*)?/, "")
        .trim(),
    )
    .filter(Boolean);
  const core = segments.find(
    (segment) => !segment.startsWith("词源锚") && !segment.startsWith("画面锚"),
  );
  return core || null;
}

// ── T3 提示分级 Hint Ladder（2026-09-25，t3-hint-ladder-design）──────────
// 四级提示：H1 例句（无例句降级 H1′ 语义链）→ H2 原型意象（isSpoiler 剧透跳级）
// → H3 助记锚（复用卡背核心行提取）→ H4 翻卡。成本化评分：每消费一级提示，
// 评分上限下降（0 级→easy / 1 级→good / ≥2 级→hard）；提示穷尽后经 H4 翻卡
// 强制 again。直接翻卡（未用满提示）= 验证回忆，上限不降。

type HintStep =
  | { kind: "example"; text: string; translation: string | null }
  | { kind: "chain"; text: string }
  | { kind: "prototype"; text: string }
  | { kind: "mnemonic"; text: string; mtype: string | null };

const STEP_LABEL: Record<HintStep["kind"], string> = {
  example: "H1 例句",
  chain: "H1′ 语义链",
  prototype: "H2 原型",
  mnemonic: "H3 助记锚",
};

/** 评分上限序（again < hard < good < easy），超上限按钮禁用。 */
const HINT_CAP_RANK: Record<Rating, number> = { again: 0, hard: 1, good: 2, easy: 3 };
const HINT_CAP_LABEL: Record<Rating, string> = { again: "重来", hard: "困难", good: "良好", easy: "轻松" };

function hintCapNow(level: number, viaH4: boolean): Rating {
  if (viaH4) return "again";
  return level === 0 ? "easy" : level === 1 ? "good" : "hard";
}

/**
 * isSpoiler：提示文本与短释义的剧透重合检测（设计稿 v2 口径）——
 * 释义中任一 ≥2 连续汉字串出现在提示文本（去空白/记号）中 → 判剧透。
 */
function isSpoiler(hintText: string, shortDefinition: string | null | undefined): boolean {
  if (!shortDefinition) return false;
  const runs = shortDefinition.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  if (runs.length === 0) return false;
  const stripped = hintText.replace(/[\s*`·]/g, "").toLowerCase();
  return runs.some((run) => stripped.includes(run));
}

/** 由 queue 直载的 word 字段动态构建提示步（降级链：缺失级自动跳过）。 */
function buildHintSteps(word: ReviewCard["word"] | null | undefined): HintStep[] {
  if (!word) return [];
  const steps: HintStep[] = [];
  const example = (word.examples ?? []).find(
    (e): e is { text: string; translation?: unknown } =>
      typeof e === "object" && e !== null &&
      typeof (e as { text?: unknown }).text === "string" &&
      ((e as { text: string }).text.trim().length > 0),
  );
  if (example) {
    steps.push({
      kind: "example",
      text: example.text,
      translation:
        typeof example.translation === "string" && example.translation.trim().length > 0
          ? example.translation
          : null,
    });
  } else if (word.semantic_chain && word.semantic_chain.trim().length > 0) {
    steps.push({ kind: "chain", text: word.semantic_chain });
  }
  if (
    word.prototype_text && word.prototype_text.trim().length > 0 &&
    !isSpoiler(word.prototype_text, word.short_definition)
  ) {
    steps.push({ kind: "prototype", text: word.prototype_text });
  }
  const mnemonicCore = extractMnemonicCore(word.mnemonic_text ?? null);
  if (mnemonicCore) {
    steps.push({ kind: "mnemonic", text: mnemonicCore, mtype: word.mnemonic_type ?? null });
  }
  return steps;
}

/** H2 原型遮罩：模糊态点击揭示（mask 玩法）。 */
function PrototypeMask({ text }: { text: string }) {
  const [shown, setShown] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setShown((v) => !v)}
      title={shown ? "点击遮回" : "点击揭示原型意象"}
      className={
        "max-w-full text-left text-[12.5px] leading-relaxed text-[var(--color-ink)] transition-all duration-200 " +
        (shown ? "" : "select-none blur-[5px] hover:blur-[3px]")
      }
    >
      {text.replace(/\*\*/g, "").replace(/`/g, "")}
    </button>
  );
}

function HintStepContent({ step }: { step: HintStep }) {
  if (step.kind === "example") {
    return (
      <div className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2">
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
      <div className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2">
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
      <div className="flex items-start gap-2 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2">
        <span aria-hidden className="pt-0.5">🎯</span>
        <PrototypeMask text={step.text} />
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-lg bg-[var(--color-surface-muted)] px-3 py-2">
      <span aria-hidden className="pt-0.5">💡</span>
      <span className="text-[12.5px] leading-relaxed text-[var(--color-ink)]">
        {step.text}
        {step.mtype && <span className="ml-1.5 text-[10px] text-[var(--color-ink-soft)]">（{step.mtype}）</span>}
      </span>
    </div>
  );
}

/** 正面提示面板：已消费步逐条展示 + 下一步按钮（穷尽后变 H4 翻卡）。 */
function HintLadderPanel({
  steps,
  level,
  onConsume,
  onFlipH4,
}: {
  steps: HintStep[];
  level: number;
  onConsume: () => void;
  onFlipH4: () => void;
}) {
  const exhausted = level >= steps.length;
  return (
    <div
      className="mt-4 w-full rounded-xl border border-dashed border-[var(--color-border-strong)] p-3 text-left"
      data-no-flip
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wider text-[var(--color-ink-soft)] opacity-70">
          提示阶梯 · 每用一级，评分上限下降
        </p>
        <span className="shrink-0 text-[10px] text-[var(--color-ink-soft)]">
          {level}/{steps.length} 级
        </span>
      </div>
      {level > 0 && (
        <div className="mt-2 space-y-1.5">
          {steps.slice(0, level).map((step, i) => (
            <HintStepContent key={`${step.kind}-${i}`} step={step} />
          ))}
        </div>
      )}
      {!exhausted ? (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onConsume}>
          <Zap className="h-3 w-3" />
          提示 {level + 1} · {STEP_LABEL[steps[level].kind]}
          <Kbd>N</Kbd>
        </Button>
      ) : (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onFlipH4}>
          <Eye className="h-3 w-3" />
          H4 · 翻卡（上限：重来）
          <Kbd>Space</Kbd>
        </Button>
      )}
      {level === 0 && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-ink-soft)] opacity-70">
          不用提示直接翻卡 = 验证回忆，评分上限「轻松」保持；用满全部提示后翻卡按「重来」计。
        </p>
      )}
    </div>
  );
}

/** Tier 1 锚点胶囊:原型 / 记忆锚 —— 巩固用的记忆钩子,低调常驻,单行截断悬停看全文。 */
function AnchorPills({ prototype, mnemonic, mnemonicType }: { prototype: string | null; mnemonic: string | null; mnemonicType: string | null }) {
  const core = extractMnemonicCore(mnemonic);
  if (!prototype && !core) return null;
  return (
    <div className="mt-3 w-full text-left">
      <p className="mb-1 text-[10px] uppercase tracking-wider text-[var(--color-ink-soft)] opacity-70">锚点 · 协助巩固</p>
      <div className="flex flex-wrap gap-2">
        {prototype && (
          <span
            className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--color-accent-soft)] px-3 py-1 text-xs text-[var(--color-ink)]"
            title={`原型：${prototype.replace(/\*\*/g, "").replace(/`/g, "")}`}
          >
            <span aria-hidden>🎯</span>
            <span className="truncate">{prototype.replace(/\*\*/g, "").replace(/`/g, "")}</span>
          </span>
        )}
        {core && (
          <span
            className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[var(--color-accent-soft)] px-3 py-1 text-xs text-[var(--color-ink)]"
            title={`记忆锚${mnemonicType ? `（${mnemonicType}）` : ""}：${core}`}
          >
            <span aria-hidden>💡</span>
            <span className="truncate">{core}</span>
          </span>
        )}
      </div>
    </div>
  );
}

/** Tier 2 网络折叠:词源叙事 / 语义链 / 词根词族 —— 默认收起,按需展开的可选增益。 */
function NetworkFold({ detail }: { detail: WordDetail | null }) {
  const meta = detail?.metadata ?? null;
  const etymology = meta?.etymology_narrative ?? null;
  const chain = meta?.semantic_chain ?? null;
  const root = meta?.morphology_root ?? null;
  const family = meta?.morphology_family ?? null;
  if (!etymology && !chain && !root && !(family && family.length > 0)) return null;
  const chainNodes = chain
    ? chain.split("->").map((node) => node.trim()).filter(Boolean)
    : [];
  return (
    <details className="group mt-3 w-full rounded-xl border border-dashed border-[var(--color-border)]" data-no-flip>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs text-[var(--color-ink-soft)] transition-colors hover:text-[var(--color-accent)]">
        <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        词源 / 语义链 / 词根（点击展开）
      </summary>
      <div className="space-y-2 border-t border-[var(--color-border)] px-3 py-2.5 text-left text-[12.5px] leading-relaxed text-[var(--color-ink)]">
        {etymology && (
          <div className="flex gap-2">
            <span className="w-10 shrink-0 whitespace-nowrap pt-0.5 text-right text-[11px] text-[var(--color-ink-soft)]">词源</span>
            <span className="min-w-0 flex-1">{etymology}</span>
          </div>
        )}
        {chainNodes.length > 0 && (
          <div className="flex gap-2">
            <span className="w-10 shrink-0 whitespace-nowrap pt-0.5 text-right text-[11px] text-[var(--color-ink-soft)]">语义链</span>
            <span className="min-w-0 flex-1 font-mono text-xs">
              {chainNodes.map((node, i) => (
                <span key={`${node}-${i}`}>
                  {i > 0 && <span className="px-1 font-bold text-[var(--color-accent)]">→</span>}
                  {node}
                </span>
              ))}
            </span>
          </div>
        )}
        {(root || (family && family.length > 0)) && (
          <div className="flex gap-2">
            <span className="w-10 shrink-0 whitespace-nowrap pt-0.5 text-right text-[11px] text-[var(--color-ink-soft)]">词根</span>
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {root && (
                <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[11px]">{root}</code>
              )}
              {(family ?? []).map((item) => (
                <span key={item} className="rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-ink-soft)]">
                  {item}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * P3-①(条目制 2026-09-06):卡背笔记折叠 + 快记。
 * N 条条目逐条展开;快记 = POST 插入一条,追加式无覆盖冲突。
 * 所有交互 stopPropagation —— 卡片容器点击 = 翻回词形,不能被冒泡触发。
 */
function NoteEntriesFold({
  slug,
  entries,
  draft,
  onDraftChange,
  onInsert,
}: {
  slug: string;
  entries: ReviewNoteEntry[];
  draft: string;
  onDraftChange: (value: string) => void;
  onInsert: (entry: ReviewNoteEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const { addToast } = useToast();

  const add = async () => {
    const content = draft.trim();
    if (!content || adding) return;
    setAdding(true);
    try {
      const res = await apiFetch<{ entry: ReviewNoteEntry }>(
        `/words/${encodeURIComponent(slug)}/notes/entries`,
        { method: "POST", body: JSON.stringify({ content_md: content }), timeoutMs: 20_000 },
      );
      onInsert(res.entry);
      onDraftChange("");
      addToast("success", "已添加一条笔记");
    } catch (err) {
      addToast("error", err instanceof BrowserApiError ? err.message : "添加失败，请重试");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="mt-3 w-full text-left" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[var(--color-border-strong)] px-3 py-1 text-xs text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        <StickyNote className="h-3 w-3" />
        {entries.length > 0
          ? `${entries.length} 条笔记${open ? " —— 点击收起" : " —— 点击展开"}`
          : "记一条笔记"}
        {!open && entries.length > 0 && " · ✏️"}
      </button>
      {open && (
        <div className="mt-2 w-full rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3">
          {entries.length > 0 && (
            <ul className="space-y-1.5">
              {entries.map((entry, index) => (
                <li key={entry.id} className="text-[12.5px] leading-relaxed text-[var(--color-ink)]">
                  <span className="mr-1 font-bold text-[var(--color-accent)]">{index + 1}.</span>
                  {entry.content_md}
                </li>
              ))}
            </ul>
          )}
          <textarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder={entries.length > 0 ? "再记一条..." : "一条笔记记一个点..."}
            className={TA_CLASS}
          />
          <div className="mt-1.5 flex justify-end">
            <Button size="sm" variant="secondary" onClick={() => void add()} disabled={adding || !draft.trim()}>
              {adding ? <Spinner className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
              添加条目
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface ReviewCardViewProps {
  card: ReviewCard | null;
  loading: boolean;
  error: string | null;
  /** Free browse mode — hide rating, use prev/next navigation, no persistence. */
  preview?: boolean;
  /** T3 Hint 阶梯：rating 附带提示消费埋点（hintLevel = 已消费级数，viaH4 = 穷尽翻卡）。 */
  onAnswer: (rating: "again" | "hard" | "good" | "easy", hint?: { hintLevel: number; viaH4?: boolean }) => void;
  onSkip: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onClearWeakSignal?: (wordId: string) => void;
  /** 挂起当前卡（P0：v1 的 p/P 快捷键对齐）。 */
  onSuspend?: () => void;
  /** 撤销最近一次评分（P0：v1 的 u/U 快捷键对齐 + Ctrl/Cmd+Z）。 */
  onUndo?: () => void;
  /** 是否存在可撤销的评分。 */
  canUndo?: boolean;
  /** 当前复习会话的 mode 与 wordIds，点击"查看详情"时塞入路由 state，便于返回按钮渲染。 */
  reviewContext?: { mode: string; wordIds?: string[] };
  /** 当前在队列中的进度，仅用于文案展示（返回复习后会通过缓存还原）。 */
  reviewProgress?: { reviewed: number; total: number };
  /**
   * ADR-0018 首学徽标：该词在本书的进行中升级工单（来自会话级映射，只读，
   * 不做逐词请求）。存在 → 显示档位徽标并跳 /upgrade。
   */
  upgradeHint?: { suggestion: string; workOrderId: string } | null;
  /** 「标记升级」动作（POST mark）；仅首学窗口 + 无工单时展示轻量入口。 */
  onMarkUpgrade?: (wordId: string) => Promise<void>;
}

/** 三档升级建议文案（与后端 suggestion_snapshot.level 同值）。 */
const UPGRADE_SUGGESTION_LABELS: Record<string, string> = {
  strong: "强烈推荐升级",
  normal: "推荐升级",
  needs_settling: "需要沉淀",
};

/**
 * 翻卡交互(P2)+ 三层信息披露(2026-09-06):
 *   Tier 0 答案 = 短释主行(居中)+ 义项行(definition_md,小字);
 *   Tier 1 锚点 = 原型 + 记忆锚 胶囊(低调常驻);
 *   Tier 2 网络 = 词源 / 语义链 / 词根词族(默认收起)。
 * 锚点/网络数据来自 GET /words/:slug 挂载预取(useWordDetail LRU 复用),
 * 未到达时优雅降级只显 Tier 0。翻面容器为 div[role=button] ——
 * 背面含真按钮/折叠/textarea(条目快记),不允许 button 嵌套 button。
 */
export function ReviewCardView({
  card,
  loading,
  error,
  preview,
  onAnswer,
  onSkip,
  onPrev,
  onNext,
  onClearWeakSignal,
  onSuspend,
  onUndo,
  canUndo,
  reviewContext,
  reviewProgress,
  upgradeHint,
  onMarkUpgrade,
}: ReviewCardViewProps) {
  const [revealed, setRevealed] = useState(false);
  // 卡背快记草稿:评分/跳过/挂起时未提交则自动插入(兜底不丢内容)
  const [quickDraft, setQuickDraft] = useState("");
  const [noteEntries, setNoteEntries] = useState<ReviewNoteEntry[]>(card?.note_entries ?? []);
  // 首学徽标：标记升级请求进行中（防连点）
  const [markingUpgrade, setMarkingUpgrade] = useState(false);
  // T3 Hint 阶梯：已消费提示级数 + 提示穷尽后经 H4/直翻的翻卡标记
  const [hintLevel, setHintLevel] = useState(0);
  const [viaH4, setViaH4] = useState(false);
  const { addToast } = useToast();

  // 操作区容器：评分/跳过/挂起/撤销/翻页后把焦点移回这里，
  // 避免按钮卸载后焦点掉回 body（键盘/读屏用户的焦点链断裂）。
  const actionRef = useRef<HTMLDivElement>(null);
  const refocusActions = () => {
    requestAnimationFrame(() => actionRef.current?.focus());
  };

  // 挂载即预取词条详情(锚点/网络层数据源),LRU 缓存复用;数据未到只显 Tier 0。
  // preview 浏览模式同样预取(三层在 preview 下直接全部展示)。
  const detail = useWordDetail(card?.word.slug);

  // 切换卡片时重置翻转与笔记折叠状态(仅依赖 progressId:队列刷新产生的
  // 新 note_entries 数组身份不应打断进行中的复习)
  useEffect(() => {
    setRevealed(false);
    setNoteEntries(card?.note_entries ?? []);
    setQuickDraft("");
    setHintLevel(0);
    setViaH4(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.progressId]);

  // T3 Hint 阶梯：提示步（缺失级自动降级跳过）与评分上限
  const hintSteps = useMemo(() => (preview ? [] : buildHintSteps(card?.word)), [card, preview]);
  const cap = hintCapNow(hintLevel, viaH4);

  // 翻卡统一入口：提示已全部消费时任何翻卡都标记 viaH4（防绕过 again 强制）；
  // 未用满提示的直翻 = 验证回忆，上限保持。
  const flipCard = () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    if (hintSteps.length > 0 && hintLevel >= hintSteps.length) {
      setViaH4(true);
    }
    setRevealed(true);
  };

  const commitQuickNote = useCallback(async () => {
    const content = quickDraft.trim();
    if (!content || !card) {
      setQuickDraft("");
      return;
    }
    try {
      const res = await apiFetch<{ entry: ReviewNoteEntry }>(
        `/words/${encodeURIComponent(card.word.slug)}/notes/entries`,
        { method: "POST", body: JSON.stringify({ content_md: content }), timeoutMs: 20_000 },
      );
      setNoteEntries((prev) => [...prev, res.entry]);
    } catch (err) {
      // 快记保存失败不阻塞评分流(复习优先),提示后继续
      addToast("error", err instanceof BrowserApiError ? err.message : "快记未能保存");
    } finally {
      setQuickDraft("");
    }
  }, [quickDraft, card, addToast]);

  const handleAnswer = async (rating: "again" | "hard" | "good" | "easy") => {
    await commitQuickNote();
    // T3 Hint 阶梯埋点：hintLevel=0（直翻验证）也上报
    onAnswer(rating, { hintLevel, viaH4 });
    refocusActions();
  };
  const consumeHint = () => setHintLevel((v) => Math.min(v + 1, hintSteps.length));
  const flipViaH4 = () => {
    setViaH4(true);
    setRevealed(true);
  };
  const handleSkip = async () => {
    await commitQuickNote();
    onSkip();
    refocusActions();
  };
  const handleSuspend = async () => {
    await commitQuickNote();
    onSuspend?.();
    refocusActions();
  };
  const handleUndo = () => {
    onUndo?.();
    refocusActions();
  };
  const handlePrev = () => {
    onPrev?.();
    refocusActions();
  };
  const handleNext = () => {
    onNext?.();
    refocusActions();
  };

  // ADR-0018 首学徽标：标记升级（POST mark）。仅在用户显式点击时发出请求，
  // 作答链路（评分/下一张卡）零新增网络请求。
  const handleMarkUpgrade = async () => {
    if (!card || !onMarkUpgrade || markingUpgrade) return;
    setMarkingUpgrade(true);
    try {
      await onMarkUpgrade(card.word.id);
      addToast("success", "已加入待升级清单");
    } catch {
      addToast("error", "标记失败，请重试");
    } finally {
      setMarkingUpgrade(false);
    }
  };

  // 键盘快捷键（P0，对齐 v1）：
  //   评分模式：空格/Enter 翻转、1-4 评分、S 跳过、P 挂起、U 或 Ctrl/Cmd+Z 撤销；
  //   preview 模式：←/→ 翻页。
  // 输入控件聚焦时豁免（快记 textarea 内不打断输入）。
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
      ) {
        return;
      }
      const modifierActive = Boolean(event.metaKey || event.ctrlKey);
      const key = event.key.toLowerCase();
      const isPreview = Boolean(preview);

      // Ctrl/Cmd+Z = 撤销（即使卡面仍在 loading，只要 canUndo 就触发）
      if (modifierActive && !event.altKey && (key === "z" || event.key === "Z")) {
        if (isPreview) return; // preview 不评分，无可撤销
        if (!canUndo) return;
        event.preventDefault();
        onUndo?.();
        return;
      }
      if (modifierActive || event.altKey) return;

      if (isPreview) {
        if (key === "arrowleft") {
          event.preventDefault();
          onPrev?.();
        } else if (key === "arrowright") {
          event.preventDefault();
          onNext?.();
        }
        return;
      }

      if (key === " " || key === "enter") {
        if (event.repeat) return;
        // 翻面容器聚焦时由容器自身的 onKeyDown 处理（原生激活路径），
        // 这里跳过避免双重翻转。
        const flipTarget = event.target as HTMLElement | null;
        if (flipTarget && typeof flipTarget.closest === "function" && flipTarget.closest("[data-flip-card]")) {
          return;
        }
        event.preventDefault();
        flipCard();
        return;
      }
      if (!card || loading) return;
      if (key === "1" || key === "2" || key === "3" || key === "4") {
        event.preventDefault();
        void handleAnswer(ratings[Number(key) - 1].value);
      } else if (key === "n") {
        // T3 Hint 阶梯：N 推进下一条提示（背面不推进）
        if (revealed) return;
        if (hintSteps.length === 0 || hintLevel >= hintSteps.length) return;
        event.preventDefault();
        setHintLevel((v) => Math.min(v + 1, hintSteps.length));
      } else if (key === "s") {
        event.preventDefault();
        void handleSkip();
      } else if (key === "p") {
        event.preventDefault();
        void handleSuspend();
      } else if (key === "u") {
        if (!canUndo) return;
        event.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card, loading, preview, onAnswer, onSkip, onSuspend, onUndo, canUndo, onPrev, onNext, commitQuickNote, flipCard, handleAnswer, hintSteps, hintLevel, revealed]);

  if (loading && !card) {
    return (
      <Card className="flex items-center justify-center py-20">
        <Spinner />
        <span className="ml-3 text-[var(--color-ink-soft)]">加载下一张卡片...</span>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="py-20 text-center">
        <p className="text-[var(--color-accent-2)]">{error}</p>
      </Card>
    );
  }

  if (!card) {
    return (
      <Card className="py-20 text-center">
        <p className="text-lg text-[var(--color-ink)]">今日复习已完成 🎉</p>
        <p className="mt-2 text-sm text-[var(--color-ink-soft)]">没有更多待复习的卡片</p>
      </Card>
    );
  }

  const showDefinition = preview || revealed;

  // ADR-0018 首学徽标：新词首学（state=new）或刚过首评（reviewCount<=1）视为
  // 首学窗口。有工单 → 档位徽标（跳 /upgrade）；无工单 + 窗口内 → 轻量
  // 「标记升级」入口；窗口外不展示（升级仍可走词条详情页自助发起）。
  // preview 模式不写数据，升级面整体隐藏（组件自防御，不依赖调用方过滤）。
  const upgradeBadgeLabel = !preview && upgradeHint
    ? (UPGRADE_SUGGESTION_LABELS[upgradeHint.suggestion] ?? "升级建议")
    : null;
  const showMarkUpgradeButton =
    !preview &&
    !upgradeHint &&
    typeof onMarkUpgrade === "function" &&
    (card.state === "new" || card.reviewCount <= 1);

  // 三层数据(来自挂载预取的词条详情;未到达时安静降级只显 Tier 0)
  const detailWord: WordDetail | null = detail.word;
  const meta = detailWord?.metadata ?? null;
  const definitionMd = detailWord?.definition_md ?? "";
  const hasDefinitionMd = definitionMd.trim().length > 0;

  // 卡片主体内容：aria-live 区域在翻转时向读屏播报词形↔释义切换。
  const flipBody = (
    <span aria-live="polite" className="block w-full">
      <AnimatePresence mode="wait">
        {showDefinition ? (
          <motion.div
            key="back"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="flex h-full w-full flex-col"
          >
            {/* ── Tier 0 答案焦点区:徽章 + 短释主行(居中)── */}
            <div className="flex flex-col items-center text-center">
              {(hintLevel > 0 || viaH4) && (
                <p className="mb-1.5 text-[11px] text-[var(--color-ink-soft)]">
                  提示已用 {hintLevel}/{hintSteps.length} 级
                  {viaH4 ? " · H4 翻卡" : ""} · 评分上限「{HINT_CAP_LABEL[cap]}」
                </p>
              )}
              <div className="flex flex-wrap items-center justify-center gap-2">
                {card.word.pos && <Badge>{card.word.pos}</Badge>}
                {card.word.cefr && <Badge tone="warm">CEFR {card.word.cefr}</Badge>}
                {card.word.ipa && (
                  <span className="font-mono text-sm text-[var(--color-ink-soft)]">{card.word.ipa}</span>
                )}
              </div>
              {card.word.short_definition ? (
                <p className="mt-3 text-lg font-medium text-[var(--color-ink)]">{card.word.short_definition}</p>
              ) : (
                <p className="mt-3 text-sm text-[var(--color-ink-soft)]">暂无释义</p>
              )}
            </div>

            {/* ── Tier 0 义项行:Core Definitions(definition_md),阅读区左对齐 ── */}
            {hasDefinitionMd && (
              <div className="mt-3 w-full rounded-xl bg-[var(--color-surface-muted)] px-3 py-2 text-left text-[12.5px] leading-relaxed text-[var(--color-ink)]">
                <Markdown content={definitionMd} />
              </div>
            )}

            {/* ── Tier 1 锚点:原型 + 记忆锚(数据未到/字段缺失时整体缺席)── */}
            <AnchorPills
              prototype={detailWord?.prototype_text ?? null}
              mnemonic={meta?.mnemonic_text ?? null}
              mnemonicType={meta?.mnemonic_type ?? null}
            />

            {/* ── Tier 2 网络:词源 / 语义链 / 词根词族(默认收起)── */}
            <NetworkFold detail={detailWord} />

            {/* ── Tier 2 语境:L3 素材空间圈记条目(默认收起,深链阅读视图)── */}
            <L3ContextsFold slug={card.word.slug} items={card?.l3_contexts ?? []} />

            {/* ── 我的笔记(条目制):折叠 + 快记 ── */}
            <NoteEntriesFold
              slug={card.word.slug}
              entries={noteEntries}
              draft={quickDraft}
              onDraftChange={setQuickDraft}
              onInsert={(entry) => setNoteEntries((prev) => [...prev, entry])}
            />

            {!preview && (
              <span className="mt-3 inline-flex items-center gap-1 self-center text-xs text-[var(--color-ink-soft)] opacity-70">
                <EyeOff className="h-3.5 w-3.5" /> 点击返回词形
              </span>
            )}
          </motion.div>
        ) : (
          <motion.div
            key="front"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="flex h-full flex-col items-center justify-center text-center"
          >
            <h2 className="section-title text-4xl font-bold text-[var(--color-ink)]">
              {card.word.lemma}
            </h2>
            {card.word.ipa && (
              <span className="mt-2 font-mono text-sm text-[var(--color-ink-soft)]">{card.word.ipa}</span>
            )}
            <HintLadderPanel
              steps={hintSteps}
              level={hintLevel}
              onConsume={consumeHint}
              onFlipH4={flipViaH4}
            />
            <span className="mt-4 inline-flex items-center gap-1 text-xs text-[var(--color-ink-soft)] opacity-70">
              <Eye className="h-3.5 w-3.5" /> 点击显示释义
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </span>
  );

  // 翻面容器:div[role=button](背面含真按钮/textarea/折叠,禁止 button 嵌套)。
  // 点击目标落在交互控件上时不翻转;Space/Enter 由容器 onKeyDown 处理。
  // 注意用 Element 而非 HTMLElement:折叠箭头等 SVG 图标不是 HTMLElement,
  // 用 HTMLElement 判定会漏掉图标点击导致误翻转。
  const shouldSkipFlip = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    Boolean(target.closest("button, textarea, input, select, a, summary, [data-no-flip]"));

  const flipContainerProps = {
    "data-flip-card": true,
    role: "button" as const,
    tabIndex: 0,
    "aria-pressed": revealed,
    "aria-label": revealed
      ? `翻转「${card.word.lemma}」，隐藏释义`
      : `翻转「${card.word.lemma}」，显示释义`,
    title: "点击翻转",
    className:
      "relative flex min-h-[14rem] w-full cursor-pointer flex-col items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-6 py-6 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2",
    onClick: (e: ReactMouseEvent) => {
      if (shouldSkipFlip(e.target)) return;
      flipCard();
    },
    onKeyDown: (e: ReactKeyboardEvent) => {
      if ((e.key === " " || e.key === "Enter") && !shouldSkipFlip(e.target)) {
        e.preventDefault();
        flipCard();
      }
    },
  };

  return (
    <Card className="space-y-6">
      {card.l1WeakSignal && (
        <div className="flex items-center justify-between rounded-lg border border-[var(--color-warm-border,transparent)] bg-[var(--color-surface-muted)] px-3 py-2">
          <div className="flex items-center gap-2">
            <Badge tone="warm" className="flex items-center gap-1">
              <Zap size={12} /> 弱信号
            </Badge>
            <span className="text-xs text-[var(--color-ink-soft)]">
              L2 连续判错，已触发 L1 重刷
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => onClearWeakSignal?.(card.word.id)}
          >
            清除标记
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-2">
          <Badge tone="accent">{labelReviewState(card.state)}</Badge>
          {card.queueLabel && <Badge>{card.queueLabel}</Badge>}
          {card.reviewCount > 0 && <Badge>复习 {card.reviewCount} 次</Badge>}
          {typeof card.retrievability === "number" && (
            <Badge tone="warm">记忆留存 {Math.round(card.retrievability * 100)}%</Badge>
          )}
          {upgradeBadgeLabel && (
            <Link
              to="/upgrade"
              title="打开升级工作台"
              data-testid="upgrade-badge"
              className="inline-flex items-center gap-1 rounded-full border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-ink)] transition-colors hover:border-[var(--color-border-strong)]"
            >
              <TrendingUp className="h-3 w-3 text-[var(--color-accent)]" />
              {upgradeBadgeLabel}
            </Link>
          )}
          {showMarkUpgradeButton && (
            <button
              type="button"
              title="标记升级：提前进入 L2 辨析（ADR-0018）"
              data-testid="mark-upgrade"
              onClick={() => void handleMarkUpgrade()}
              disabled={markingUpgrade}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border-strong)] px-2.5 py-0.5 text-xs text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
            >
              {markingUpgrade ? <Spinner className="h-3 w-3" /> : <TrendingUp className="h-3 w-3" />}
              标记升级
            </button>
          )}
        </div>
        <Link
          to={{ pathname: `/words/${card.word.slug}` }}
          state={{
            from: "review",
            mode: reviewContext?.mode,
            wordIds: reviewContext?.wordIds,
            reviewed: reviewProgress?.reviewed,
            total: reviewProgress?.total,
          }}
          className="text-sm font-semibold text-[var(--color-accent)]"
        >
          查看详情
        </Link>
      </div>

      {/* Phase E 晋升可视化：S≥21d 且复习≥5 次即晋升 L2 辨析训练（双条件进度） */}
      {typeof card.stability === "number" && (
        <div className="rounded-lg border border-[var(--color-border)] px-3 py-2" data-testid="promotion-progress">
          <div className="flex items-center justify-between text-xs text-[var(--color-ink-soft)]">
            <span>晋升进度 · 达标后自动进入辨析训练</span>
            {card.stability >= 21 && card.reviewCount >= 5 && (
              <span className="font-semibold text-[var(--color-accent)]">已达晋升门</span>
            )}
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-3">
            {(() => {
              const sRatio = Math.min(1, card.stability / 21);
              const cRatio = Math.min(1, card.reviewCount / 5);
              return (
                <>
                  <div>
                    <div className="mb-1 flex justify-between text-[11px] text-[var(--color-ink-soft)]">
                      <span>稳定度</span>
                      <span className="font-mono">{Math.round(card.stability * 10) / 10}d / 21d</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                      <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${Math.round(sRatio * 100)}%` }} />
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between text-[11px] text-[var(--color-ink-soft)]">
                      <span>复习次数</span>
                      <span className="font-mono">{card.reviewCount} / 5</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                      <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${Math.round(cRatio * 100)}%` }} />
                    </div>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* 卡片主体:preview 直接展示;评分模式先词形后释义(三层披露) */}
      {!preview ? (
        <div {...flipContainerProps}>{flipBody}</div>
      ) : (
        <div className="relative flex min-h-[14rem] w-full cursor-pointer flex-col items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-6 py-6 text-left">
          {flipBody}
        </div>
      )}

      {preview ? (
        <div
          ref={actionRef}
          tabIndex={-1}
          aria-label="卡片导航操作区"
          className="flex justify-center gap-3 pt-4 focus:outline-none"
        >
          <Button variant="secondary" size="lg" disabled={loading} onClick={handlePrev}>
            <ArrowLeft className="h-4 w-4" /> 上一个
          </Button>
          <Button variant="secondary" size="lg" disabled={loading} onClick={handleNext}>
            下一个 <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <>
          <div
            ref={actionRef}
            tabIndex={-1}
            aria-label="评分操作区"
            className="flex justify-center gap-2 pt-4 focus:outline-none"
          >
            {ratings.map((r) => (
              <Button
                key={r.value}
                variant={r.variant}
                size="lg"
                disabled={loading || HINT_CAP_RANK[r.value] > HINT_CAP_RANK[cap]}
                title={
                  HINT_CAP_RANK[r.value] > HINT_CAP_RANK[cap]
                    ? `已用 ${hintLevel} 级提示，评分上限「${HINT_CAP_LABEL[cap]}」`
                    : undefined
                }
                onClick={() => void handleAnswer(r.value)}
              >
                {r.label}
                <Kbd>{r.key}</Kbd>
              </Button>
            ))}
          </div>

          <div className="text-center">
            <Button variant="ghost" size="sm" disabled={loading} onClick={() => void handleSkip()}>
              跳过<Kbd>S</Kbd>
            </Button>
            {onSuspend && (
              <Button variant="ghost" size="sm" disabled={loading} onClick={() => void handleSuspend()} className="ml-3">
                挂起<Kbd>P</Kbd>
              </Button>
            )}
          </div>

          <p className="text-center text-xs text-[var(--color-ink-soft)] opacity-70">
            评分上限「{HINT_CAP_LABEL[cap]}」
            {hintLevel > 0 ? ` · 已用 ${hintLevel} 级提示` : ""} · 空格 翻转 · N 提示 · 1-4 评分 · S 跳过 · P 挂起 · H 历史{canUndo ? " · U / Ctrl+Z 撤销上一张" : ""}
          </p>
        </>
      )}
    </Card>
  );
}
