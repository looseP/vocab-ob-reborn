import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  ClipboardType,
  Globe,
  Minus,
  Plus,
  Quote,
  Search,
  StickyNote,
  X,
} from "lucide-react";
import { Button } from "@/frontend/components/ui/Button";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Input } from "@/frontend/components/ui/Input";
import { SkeletonCard } from "@/frontend/components/ui/Skeleton";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { useToast } from "@/frontend/components/ui/Toast";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";

interface WordDetail {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  short_definition: string | null;
  definition_md: string;
}

interface NoteResponse {
  content_md: string;
}

interface CaptureResponse {
  ok: true;
  existed: boolean;
  word: {
    id: string;
    slug: string;
    title: string;
    lemma: string;
    shortDefinition: string | null;
  };
  noteContentMd: string | null;
  l3Status: "deferred";
}

type Phase =
  | { kind: "idle" }
  | { kind: "looking"; headword: string }
  | { kind: "found"; word: WordDetail; noteMd: string | null }
  | { kind: "missing"; headword: string }
  | { kind: "captured"; wordId: string; title: string };

function slugifyHeadword(headword: string): string {
  return headword
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof BrowserApiError) {
    if (error.status === 401) return "登录已过期，请在主窗口重新登录";
    return error.message || fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

const DRAFT_KEY = "capture-draft-source-v1";

interface SourceDraft {
  sentence?: string;
  sourceUrl?: string;
  obsidianRef?: string;
}

function loadSourceDraft(): SourceDraft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SourceDraft;
    return {
      ...(typeof parsed.sentence === "string" ? { sentence: parsed.sentence } : {}),
      ...(typeof parsed.sourceUrl === "string" ? { sourceUrl: parsed.sourceUrl } : {}),
      ...(typeof parsed.obsidianRef === "string" ? { obsidianRef: parsed.obsidianRef } : {}),
    };
  } catch {
    return {};
  }
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-glass)] px-1.5 py-0.5 font-sans text-[10px] font-medium text-[var(--color-ink-soft)]">
      {children}
    </kbd>
  );
}

const cardShadow = "shadow-[0_10px_30px_-12px_rgb(var(--color-shadow-warm)/0.28)]";

interface CapturePageProps {
  /** When provided, the header shows a button to collapse into the floating ball. */
  onCollapse?: () => void;
}

export function CapturePage({ onCollapse }: CapturePageProps = {}) {
  const [inputValue, setInputValue] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [addedToReview, setAddedToReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const draft = loadSourceDraft();
  const [sentence, setSentence] = useState(draft.sentence ?? "");
  const [sourceUrl, setSourceUrl] = useState(draft.sourceUrl ?? "");
  const [obsidianRef, setObsidianRef] = useState(draft.obsidianRef ?? "");
  const lookupSeqRef = useRef(0);
  const { addToast } = useToast();

  useEffect(() => {
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ sentence, sourceUrl, obsidianRef }),
      );
    } catch {
      // ignore storage errors
    }
  }, [sentence, sourceUrl, obsidianRef]);

  useEffect(() => {
    document.title = "快速捕获 · Vocab Observatory";
    try {
      const stored = localStorage.getItem("theme");
      if (stored === "dark" || stored === "light") {
        document.documentElement.setAttribute("data-theme", stored);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const reset = useCallback(() => {
    setPhase({ kind: "idle" });
    setInputValue("");
    setAddedToReview(false);
  }, []);

  const lookup = useCallback(
    async (raw: string) => {
      const headword = raw.trim();
      const slug = slugifyHeadword(headword);
      if (!slug) {
        addToast("warning", "请粘贴或输入英文单词");
        return;
      }
      const seq = ++lookupSeqRef.current;
      setAddedToReview(false);
      setPhase({ kind: "looking", headword });
      try {
        const [word, note] = await Promise.all([
          apiFetch<WordDetail>(`/words/${encodeURIComponent(slug)}`),
          apiFetch<NoteResponse>(`/words/${encodeURIComponent(slug)}/notes`).catch(() => null),
        ]);
        if (seq !== lookupSeqRef.current) return;
        setPhase({ kind: "found", word, noteMd: note?.content_md ?? null });
      } catch (error) {
        if (seq !== lookupSeqRef.current) return;
        if (error instanceof BrowserApiError && error.status === 404) {
          setPhase({ kind: "missing", headword });
        } else {
          addToast(
            error instanceof BrowserApiError && error.status === 401 ? "warning" : "error",
            apiErrorMessage(error, "查询失败"),
          );
          setPhase({ kind: "idle" });
        }
      }
    },
    [addToast],
  );

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text").trim();
    if (!text) return;
    event.preventDefault();
    setInputValue(text);
    void lookup(text);
  };

  const captureWord = async () => {
    if (phase.kind !== "missing") return;
    const headword = phase.headword;
    setBusy(true);
    try {
      const sourceMaterial = {
        ...(sentence.trim() ? { sentence: sentence.trim() } : {}),
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
        ...(obsidianRef.trim() ? { obsidianRef: obsidianRef.trim() } : {}),
      };
      const result = await apiFetch<CaptureResponse>("/capture", {
        method: "POST",
        body: JSON.stringify({ headword, ...sourceMaterial }),
      });
      setPhase({ kind: "captured", wordId: result.word.id, title: result.word.title });
      addToast("success", `${result.word.title} 已加入生词本`);
      if (Object.keys(sourceMaterial).length > 0 && result.l3Status === "deferred") {
        addToast("info", "来源记录将在 L3 功能启用后生效保存");
      }
    } catch (error) {
      addToast("error", apiErrorMessage(error, "加入生词本失败"));
    } finally {
      setBusy(false);
    }
  };

  const addToReview = async (wordId: string, title: string) => {
    setBusy(true);
    try {
      await apiFetch<{ ok: true; progressId: string }>("/review/cards", {
        method: "POST",
        body: JSON.stringify({ wordId }),
      });
      setAddedToReview(true);
      addToast("success", `${title} 已加入复习队列`);
    } catch (error) {
      if (error instanceof BrowserApiError && error.status === 409) {
        setAddedToReview(true);
        addToast("info", `${title} 已在复习队列中`);
      } else {
        addToast(
          error instanceof BrowserApiError && error.status === 401 ? "warning" : "error",
          apiErrorMessage(error, "加入复习失败"),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const sourceFilled = sentence.trim() !== "" || sourceUrl.trim() !== "" || obsidianRef.trim() !== "";
  const slug = phase.kind === "found" ? phase.word.slug : null;

  return (
    <div
      className="min-h-screen bg-[var(--color-canvas)] bg-gradient-to-b from-[var(--color-canvas)] to-[var(--color-canvas-deep)] p-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") reset();
      }}
    >
      <div className="mx-auto flex w-full max-w-[380px] flex-col gap-3">
        <header className="flex items-center gap-2.5 px-1">
          <div className="soft-grid flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-glass)]">
            <ClipboardType className="h-5 w-5 text-[var(--color-accent)]" />
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight text-[var(--color-ink)]">快速捕获</h1>
            <p className="text-[11px] leading-tight text-[var(--color-ink-soft)]">生词入本 · 熟词入队 · 两步完成</p>
          </div>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              aria-label="收起为悬浮球"
              title="收起为悬浮球 (Ctrl+B)"
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-glass)] text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-accent)]"
            >
              <Minus className="h-4 w-4" />
            </button>
          )}
        </header>

        <div className="animate-rise space-y-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[var(--color-ink-soft)]" />
            <Input
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if (event.key === "Enter") void lookup(inputValue);
              }}
              placeholder="粘贴单词，如 ephemeral"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              aria-label="要捕获的单词"
              className="h-11 pl-10 pr-9 text-[15px]"
            />
            {inputValue && (
              <button
                type="button"
                onClick={reset}
                aria-label="清空输入"
                className="absolute right-2.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface-glass-hover)] hover:text-[var(--color-ink)]"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <p className="flex items-center gap-1.5 px-1 text-[11px] text-[var(--color-ink-soft)]">
            <Kbd>Ctrl</Kbd>+<Kbd>V</Kbd> 粘贴即查
            <span className="mx-0.5 opacity-50">·</span>
            <Kbd>Enter</Kbd> 查询
            <span className="mx-0.5 opacity-50">·</span>
            {onCollapse && (
              <>
                <Kbd>Ctrl</Kbd>+<Kbd>B</Kbd> 收起为球
                <span className="mx-0.5 opacity-50">·</span>
              </>
            )}
            <Kbd>Esc</Kbd> 清空
          </p>
        </div>

        {phase.kind === "looking" && (
          <Card className={`animate-rise ${cardShadow}`}>
            <SkeletonCard />
          </Card>
        )}

        {phase.kind === "idle" && (
          <div className={`animate-rise ${cardShadow}`}>
            <Card>
              <EmptyState
                icon={<ClipboardType className="h-10 w-10" />}
                title="从任意阅读处捕获"
                description="在别处复制一个单词，回到这里粘贴即可查询；生词一键入本，熟词直接加入复习。"
              />
            </Card>
          </div>
        )}

        {(phase.kind === "found" || phase.kind === "captured") && (
          <div key={phase.kind} className={`animate-rise ${cardShadow}`}>
            <Card className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-xl font-bold text-[var(--color-ink)]">
                    {phase.kind === "found" ? phase.word.title : phase.title}
                  </h2>
                  {phase.kind === "found" && phase.word.ipa && (
                    <p className="mt-0.5 text-sm text-[var(--color-ink-soft)]">{phase.word.ipa}</p>
                  )}
                </div>
                {phase.kind === "found" ? (
                  <Badge tone={phase.word.cefr ? "accent" : "default"}>{phase.word.cefr ?? "词库"}</Badge>
                ) : (
                  <Badge tone="warm">新生词</Badge>
                )}
              </div>

              {phase.kind === "found" && (
                <>
                  {phase.word.short_definition && (
                    <p className="border-l-2 border-[var(--color-accent)] pl-3 text-sm font-medium leading-relaxed text-[var(--color-ink)]">
                      {phase.word.short_definition}
                    </p>
                  )}
                  {phase.noteMd ? (
                    <div className="rounded-xl bg-[var(--color-surface-muted)] p-3">
                      <p className="mb-1 flex items-center gap-1 text-xs font-semibold text-[var(--color-pill-text)]">
                        <StickyNote className="h-3 w-3" />
                        我的笔记
                      </p>
                      <p className="max-h-28 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-ink-soft)]">
                        {phase.noteMd}
                      </p>
                    </div>
                  ) : (
                    phase.word.definition_md && (
                      <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-xl bg-[var(--color-surface-glass)] p-3 text-xs leading-relaxed text-[var(--color-ink-soft)]">
                        {phase.word.definition_md}
                      </p>
                    )
                  )}
                </>
              )}

              {phase.kind === "captured" && (
                <EmptyState
                  icon={<BookOpen className="h-8 w-8" />}
                  title="已进入生词本"
                  description={`「${phase.title}」还没有笔记释义，制作笔记并导入后会自动补全。现在就可以先加入复习队列。`}
                />
              )}

              <div className="flex items-center gap-2 border-t border-[var(--color-border)] pt-3">
                <Button
                  size="sm"
                  disabled={addedToReview || busy}
                  onClick={() => {
                    const wordId = phase.kind === "found" ? phase.word.id : phase.wordId;
                    const title = phase.kind === "found" ? phase.word.title : phase.title;
                    void addToReview(wordId, title);
                  }}
                >
                  {addedToReview ? (
                    <>
                      <Check className="h-4 w-4" />
                      已在队列
                    </>
                  ) : busy ? (
                    <>
                      <Spinner className="h-4 w-4" />
                      处理中…
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4" />
                      加入复习
                    </>
                  )}
                </Button>
                {slug && (
                  <a href={`/words/${slug}`} target="_blank" rel="noreferrer" className="ml-auto">
                    <Button variant="ghost" size="sm">
                      <BookOpen className="h-4 w-4" />
                      词条详情
                    </Button>
                  </a>
                )}
              </div>
            </Card>
          </div>
        )}

        {phase.kind === "missing" && (
          <div className={`animate-rise space-y-3 ${cardShadow}`}>
            <Card>
              <EmptyState
                title={`词库中没有「${phase.headword}」`}
                description="可将其写入生词本；之后统一制作笔记导入时再归类。"
                action={
                  <Button disabled={busy} onClick={() => void captureWord()}>
                    {busy ? (
                      <>
                        <Spinner className="h-4 w-4" />
                        写入中…
                      </>
                    ) : (
                      <>
                        <Plus className="h-4 w-4" />
                        加入生词本
                      </>
                    )}
                  </Button>
                }
              />

              <div className="border-t border-[var(--color-border)] pt-1">
                <button
                  type="button"
                  onClick={() => setSourceOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs font-semibold text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-surface-glass-hover)] hover:text-[var(--color-ink)]"
                >
                  <span className="flex items-center gap-1.5">
                    {sourceFilled && <Check className="h-3.5 w-3.5 text-[var(--color-accent)]" />}
                    {sourceFilled ? "已填写来源信息" : "未记录来源（可选）"}
                  </span>
                  <Badge tone="accent">L3 预留</Badge>
                </button>
                <div
                  className={`grid transition-all duration-200 ease-out ${
                    sourceOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                  }`}
                >
                  <div className="overflow-hidden">
                    <div className="space-y-2 p-2 pt-1">
                      <div className="relative">
                        <Globe className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-soft)]" />
                        <Input
                          value={sourceUrl}
                          onChange={(event) => setSourceUrl(event.target.value)}
                          placeholder="来源网页链接 https://…"
                          type="url"
                          className="pl-9"
                          aria-label="来源网页链接"
                        />
                      </div>
                      <div className="relative">
                        <Quote className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-[var(--color-ink-soft)]" />
                        <textarea
                          value={sentence}
                          onChange={(event) => setSentence(event.target.value)}
                          placeholder="阅读中的完整例句或段落…"
                          rows={3}
                          className="w-full resize-y rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-input)] py-2 pl-9 pr-3 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-soft)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                          aria-label="例句或段落"
                        />
                      </div>
                      <div className="relative">
                        <BookOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-soft)]" />
                        <Input
                          value={obsidianRef}
                          onChange={(event) => setObsidianRef(event.target.value)}
                          placeholder="obsidian://open?vault=…&file=…"
                          className="pl-9"
                          aria-label="Obsidian 链接"
                        />
                      </div>
                      <p className="px-1 pb-1 text-[11px] leading-relaxed text-[var(--color-ink-soft)]">
                        来源记录随捕获一并提交，待 L3 语境空间启用后落库。
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
