import { useMemo, useState } from "react";
import { Sparkles, ClipboardPaste, Copy, Check } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { STYLE_PROFILES } from "@/domain/l2-style-profile";

type ComposerField = "collocation" | "example" | "synonym" | "antonym";

const FIELD_LABELS: Record<ComposerField, string> = {
  collocation: "搭配",
  example: "例句",
  synonym: "同义辨析",
  antonym: "反义",
};

const FIELDS: ComposerField[] = ["collocation", "example", "synonym", "antonym"];

/** 例句字段在 UI 上的可选风格档案（域内 STYLE_PROFILES 按 fieldScope 过滤）。 */
const EXAMPLE_FIELD = "example" as const;
const COLLOCATION_FIELD = "collocation" as const;

type DraftItem = Record<string, unknown>;

interface DraftState {
  items: DraftItem[];
  /** internal_llm / dictionary / dictionary_llm_refined / external_chat */
  origin: "internal" | "external";
  /** 内部 LLM 路径返回的来源模式（draft 响应的 sourceMode）。 */
  sourceMode?: string;
}

/** 服务端 draft 可能是裸数组（legacy）或 v1 wrapper（{ schemaVersion, field, items }）。 */
function extractDraftItems(draft: unknown): DraftItem[] {
  if (Array.isArray(draft)) return draft as DraftItem[];
  if (draft && typeof draft === "object" && Array.isArray((draft as { items?: unknown }).items)) {
    return (draft as { items: DraftItem[] }).items;
  }
  throw new Error("草稿格式无法识别");
}

function errorMessage(err: unknown): string {
  if (err instanceof BrowserApiError) {
    switch (err.code) {
      case "OVER_BUDGET":
        return "今日 LLM 预算已用尽，明天再试，或改用「外部生成」通道（不消耗预算）。";
      case "L2_CONTENT_UNAVAILABLE":
        return "LLM 服务未配置。可改用「外部生成」通道，在任意外部 AI 工具中粘贴提示词完成扩展。";
      case "NO_DICTIONARY_CANDIDATES":
        return "词典没有返回候选搭配，无法锚定生成（搭配必须以词典为准）。可先跳过搭配字段。";
      case "VALIDATION_ERROR":
        return `参数校验失败：${err.message}`;
      case "TIMEOUT":
        return "请求超时，请重试或改用「外部生成」通道。";
      default:
        return err.message || `请求失败（${err.status}）`;
    }
  }
  return err instanceof Error ? err.message : "未知错误";
}

function itemLabel(item: DraftItem, field: ComposerField): string {
  if (field === "collocation") return String(item.phrase ?? "(未命名搭配)");
  if (field === "example") return String(item.text ?? "(空例句)");
  return String(item.word ?? "(未命名词条)");
}

function itemDetail(item: DraftItem, field: ComposerField): string {
  if (field === "collocation") {
    const parts = [item.gloss, item.example].filter((v) => typeof v === "string" && v.length > 0);
    return parts.join(" — ");
  }
  if (field === "example") {
    const parts = [item.translation, item.source].filter((v) => typeof v === "string" && v.length > 0);
    return parts.join(" · ");
  }
  const parts = [item.semanticDiff, item.delta].filter((v) => typeof v === "string" && v.length > 0);
  return parts.join(" / ");
}

/**
 * L2 内容扩展面板（Composer UI）：
 * 选字段 →（选风格/数量）→ AI 生成草稿 或 外部提示词通道 → 勾选采纳 → 确认入库。
 * 确认是纯 DB 级联（insert + 刷新缓存 + L2 软重卡），不依赖 LLM 配置。
 */
export function WordL2Composer({ slug, onConfirmed }: { slug: string; onConfirmed: () => void }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<ComposerField>("collocation");
  const [styleProfileId, setStyleProfileId] = useState<string>("default");
  const [count, setCount] = useState(2);
  const [busy, setBusy] = useState<"draft" | "confirm" | "external" | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [externalPrompt, setExternalPrompt] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [copied, setCopied] = useState(false);

  const scopedProfiles = useMemo(() => {
    const scope: typeof EXAMPLE_FIELD | typeof COLLOCATION_FIELD | null =
      field === "example" ? EXAMPLE_FIELD : field === "collocation" ? COLLOCATION_FIELD : null;
    if (!scope) return [];
    return STYLE_PROFILES.filter((p) => p.fieldScope.includes(scope));
  }, [field]);

  const encodedSlug = encodeURIComponent(slug);

  const resetDraft = () => {
    setDraft(null);
    setSelected(new Set());
    setPasted("");
    setExternalPrompt(null);
    setCopied(false);
  };

  const switchField = (next: ComposerField) => {
    setField(next);
    setError(null);
    resetDraft();
    if (next === "example" || next === "collocation") {
      const scope = next === "example" ? EXAMPLE_FIELD : COLLOCATION_FIELD;
      if (!STYLE_PROFILES.find((p) => p.id === styleProfileId)?.fieldScope.includes(scope)) {
        setStyleProfileId("default");
      }
    }
  };

  const generateDraft = async () => {
    setBusy("draft");
    setError(null);
    resetDraft();
    try {
      const body: Record<string, unknown> = { field, count };
      if (field === "example" || field === "collocation") body.styleProfileId = styleProfileId;
      const data = await apiFetch<{ draft: unknown; sourceMode?: string }>(`/l2/${encodedSlug}/draft`, {
        method: "POST",
        body: JSON.stringify(body),
        timeoutMs: 120_000,
      });
      const items = extractDraftItems(data.draft);
      if (items.length === 0) {
        setError("生成结果为空，请重试或调整数量。");
        return;
      }
      setDraft({ items, origin: "internal", sourceMode: data.sourceMode });
      setSelected(new Set(items.map((_, i) => i)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const buildExternalPrompt = async () => {
    setBusy("external");
    setError(null);
    resetDraft();
    try {
      const body: Record<string, unknown> = { field };
      if (field === "example" || field === "collocation") body.styleProfileId = styleProfileId;
      const data = await apiFetch<{ prompt: string }>(`/l2/${encodedSlug}/external-prompt`, {
        method: "POST",
        body: JSON.stringify(body),
        timeoutMs: 60_000,
      });
      setExternalPrompt(data.prompt);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const adoptPasted = () => {
    try {
      const parsed: unknown = JSON.parse(pasted);
      const items = extractDraftItems(parsed);
      if (items.length === 0) {
        setError("粘贴内容没有可采纳的条目。");
        return;
      }
      setDraft({ items, origin: "external" });
      setSelected(new Set(items.map((_, i) => i)));
      setError(null);
    } catch {
      setError("粘贴内容不是合法 JSON（接受裸数组或 { items: [...] } 形态）。");
    }
  };

  const confirmSelected = async () => {
    if (!draft || selected.size === 0) return;
    setBusy("confirm");
    setError(null);
    try {
      const items = draft.items.filter((_, i) => selected.has(i));
      await apiFetch(`/l2/${encodedSlug}/confirm`, {
        method: "POST",
        body: JSON.stringify({ field, items, source: "manual" }),
        timeoutMs: 60_000,
      });
      resetDraft();
      onConfirmed();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const copyPrompt = async () => {
    if (!externalPrompt) return;
    try {
      await navigator.clipboard.writeText(externalPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("复制失败，请手动选择文本复制。");
    }
  };

  const toggleItem = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const needsStyle = field === "example" || field === "collocation";

  return (
    <Card>
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="section-title flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
          <Sparkles className="h-4 w-4 text-[var(--color-accent)]" />
          扩展内容（AI 生成）
        </span>
        <span className="text-sm text-[var(--color-ink-soft)]">{open ? "收起" : "展开"}</span>
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          {/* 字段选择 */}
          <div className="flex flex-wrap gap-2">
            {FIELDS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => switchField(f)}
                className={`rounded-full px-3 py-1 text-sm transition-colors ${
                  field === f
                    ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]"
                    : "border border-[var(--color-border)] text-[var(--color-ink-soft)] hover:border-[var(--color-accent)]"
                }`}
              >
                {FIELD_LABELS[f]}
              </button>
            ))}
          </div>

          {/* 选项行：风格档案 + 数量（仅搭配/例句有风格） */}
          {needsStyle && (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2 text-[var(--color-ink-soft)]">
                风格
                <select
                  value={styleProfileId}
                  onChange={(e) => setStyleProfileId(e.target.value)}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-ink)]"
                >
                  {scopedProfiles.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-[var(--color-ink-soft)]">
                数量
                <select
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-ink)]"
                >
                  {[1, 2, 3].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {/* 动作行 */}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={generateDraft} disabled={busy !== null}>
              {busy === "draft" ? <Spinner /> : <Sparkles className="h-4 w-4" />}
              AI 生成草稿
            </Button>
            <Button size="sm" variant="secondary" onClick={buildExternalPrompt} disabled={busy !== null}>
              {busy === "external" ? <Spinner /> : null}
              外部生成（不耗预算）
            </Button>
          </div>

          {error && (
            <p className="rounded-lg border border-[var(--color-accent-2)] bg-[var(--color-surface-muted)] px-3 py-2 text-sm text-[var(--color-accent-2)]">
              {error}
            </p>
          )}

          {/* 外部提示词通道 */}
          {externalPrompt && !draft && (
            <div className="space-y-2 rounded-lg border border-[var(--color-border)] p-3">
              <p className="text-sm text-[var(--color-ink-soft)]">
                把提示词粘贴到任意外部 AI 工具，将其返回的 JSON 粘贴到下方并采纳：
              </p>
              <textarea
                readOnly
                value={externalPrompt}
                rows={6}
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-code-bg)] p-2 font-mono text-xs text-[var(--color-ink)]"
              />
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={copyPrompt}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "已复制" : "复制提示词"}
                </Button>
              </div>
              <textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                rows={4}
                placeholder='粘贴外部工具返回的 JSON，如 [ {...}, {...} ] 或 { "items": [...] }'
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-xs text-[var(--color-ink)]"
              />
              <Button size="sm" variant="secondary" onClick={adoptPasted} disabled={!pasted.trim()}>
                <ClipboardPaste className="h-4 w-4" />
                解析并预览
              </Button>
            </div>
          )}

          {/* 草稿勾选与确认 */}
          {draft && (
            <div className="space-y-3 rounded-lg border border-[var(--color-border)] p-3">
              <p className="text-sm text-[var(--color-ink-soft)]">
                草稿预览（{draft.origin === "external" ? "来自外部工具" : `来源：${draft.sourceMode ?? "LLM"}`}）——
                勾选要采纳的条目，确认后写入并安排复习：
              </p>
              <div className="space-y-2">
                {draft.items.map((item, i) => (
                  <label
                    key={i}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] p-2 transition-colors hover:border-[var(--color-accent)]"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(i)}
                      onChange={() => toggleItem(i)}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="block font-mono text-sm font-semibold text-[var(--color-ink)]">
                        {itemLabel(item, field)}
                      </span>
                      <span className="block text-xs text-[var(--color-ink-soft)]">{itemDetail(item, field)}</span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={confirmSelected} disabled={busy !== null || selected.size === 0}>
                  {busy === "confirm" ? <Spinner /> : null}
                  采纳选中项（{selected.size}）
                </Button>
                <Button size="sm" variant="ghost" onClick={() => resetDraft()} disabled={busy !== null}>
                  丢弃
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
