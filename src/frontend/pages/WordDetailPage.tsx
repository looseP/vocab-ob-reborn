import { useEffect, useMemo, useState } from "react";
import { useParams, Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Lightbulb, Network, Puzzle, Quote, Undo2, Layers, Users, Sparkles, Eye, EyeOff, Trash2 } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { Markdown } from "@/frontend/components/ui/Markdown";
import { Reveal, RevealMarkdown } from "@/frontend/components/ui/Reveal";
import { useToast } from "@/frontend/components/ui/Toast";
import { apiFetch } from "@/frontend/api/client";
import { BrowserApiError } from "@/frontend/api/browserRequest";
import { WordNotes } from "@/frontend/components/words/WordNotes";
import { WordL3Contexts } from "@/frontend/components/words/WordL3Contexts";
import { WordL2Content, ProvenanceBadge } from "@/frontend/components/words/WordL2Content";
import { WordL2Composer } from "@/frontend/components/words/WordL2Composer";
import { PromoteL2Button } from "@/frontend/components/words/PromoteL2Button";
import { AddToReviewButton } from "@/frontend/components/words/AddToReviewButton";
import { SpeakButton } from "@/frontend/components/words/SpeakButton";
import { useWordDetail, type L2Provenance, type WordDetail } from "@/frontend/hooks/useWordDetail";
import { deriveWordCollections } from "@/frontend/utils/plazaSlugs";

/**
 * Stub 删除 409 阻塞详情 → 可读中文提示（镜像 L3Bookshelf.sourceDeleteBlockerMessage）。
 * blockers 三项：绑定 L3 语境 / 用户笔记 / 入站语境链接（复习进度与词单成员随 FK 级联，不阻塞）。
 */
export function wordDeleteBlockerMessage(details: unknown): string {
  const blockers = (details as { blockers?: Record<string, unknown> } | undefined)?.blockers;
  if (!blockers) return "该词条存在关联数据，暂不能删除";
  const parts: string[] = [];
  if (typeof blockers.l3OccurrenceCount === "number" && blockers.l3OccurrenceCount > 0) {
    parts.push(`先到素材空间删除该词绑定的 ${blockers.l3OccurrenceCount} 条语境`);
  }
  if (typeof blockers.noteEntryCount === "number" && blockers.noteEntryCount > 0) {
    parts.push(`先删除该词下的 ${blockers.noteEntryCount} 条笔记`);
  }
  if (typeof blockers.inboundWordLinkCount === "number" && blockers.inboundWordLinkCount > 0) {
    parts.push(`先删除引用该词的 ${blockers.inboundWordLinkCount} 条语境链接`);
  }
  return parts.length > 0 ? `暂不能删除：${parts.join("；")}` : "该词条存在关联数据，暂不能删除";
}

function SectionCard({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-32">
      <Card>
        <h2 className="section-title mb-3 flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
          {title}
        </h2>
        {children}
      </Card>
    </section>
  );
}

/** 默认折叠的内容区（低频阅读：词源故事 / 笔记原文）。 */
function CollapsibleSection({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <details id={id} className="group scroll-mt-32 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]">
      <summary className="cursor-pointer list-none px-5 py-4 text-lg font-semibold text-[var(--color-ink)] transition-colors group-open:text-[var(--color-accent)]">
        {title}
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  );
}

interface AnchorItem {
  id: string;
  label: string;
}

/** 页内锚点导航条（sticky，滚动高亮当前节）。 */
function AnchorNav({ items, active }: { items: AnchorItem[]; active: string | null }) {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="页内导航"
      className="sticky top-[76px] z-30 flex gap-1.5 overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]/95 px-2.5 py-2 shadow-sm backdrop-blur"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className={`shrink-0 rounded-full px-3 py-1 text-sm transition-colors ${
            active === item.id
              ? "bg-[var(--color-accent)] text-[var(--color-accent-contrast,var(--color-surface))]"
              : "text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]"
          }`}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

/** IntersectionObserver 滚动监听（jsdom / 不支持环境的守卫在内部）。 */
function useScrollSpy(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join("|");
  useEffect(() => {
    const list = key ? key.split("|") : [];
    if (list.length === 0 || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: "-15% 0px -75% 0px" },
    );
    for (const id of list) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [key]);
  return active;
}

/** 例句统一池条目：L1 收藏 + L2 生成合并，带来源区分。 */
interface UnifiedExample {
  text: string;
  translation?: string;
  origin: "l1" | "l2";
  provenance?: L2Provenance;
}

function buildUnifiedExamples(word: WordDetail): UnifiedExample[] {
  const l1Items: UnifiedExample[] = (word.examples ?? []).map((ex) => ({
    text: ex.text,
    translation: ex.translation,
    origin: "l1",
  }));
  const l2Items: UnifiedExample[] = (word.l2_content?.corpus_items ?? []).map((item) => ({
    text: item.text,
    translation: item.translation,
    origin: "l2",
    provenance: item.provenance,
  }));
  return [...l1Items, ...l2Items];
}

export function WordDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { word, loading, error, refresh } = useWordDetail(slug);

  // 自测模式：答案字段（释义/例句翻译/L2 辨析结论）模糊化，点击逐个揭示
  const [quizMode, setQuizMode] = useState(false);

  // 0023 stub 生命周期：definition_md='' 即生词条目，空态区提供删除出口
  const isStub = (word?.definition_md ?? "") === "";
  const [deleting, setDeleting] = useState(false);
  const { addToast } = useToast();

  const deleteStub = async () => {
    if (!slug || !word || deleting) return;
    if (!window.confirm(`删除生词条目「${word.title.slice(0, 40)}」？其复习进度与收藏将一并移除，此操作不可恢复。`)) return;
    setDeleting(true);
    try {
      await apiFetch(`/words/${encodeURIComponent(slug)}`, { method: "DELETE", timeoutMs: 20_000 });
      addToast("success", "已删除该词条");
      navigate("/words");
    } catch (err) {
      if (err instanceof BrowserApiError && err.status === 409) {
        addToast("error", wordDeleteBlockerMessage(err.details));
      } else {
        addToast("error", err instanceof Error ? err.message : "删除失败，请稍后重试");
      }
    } finally {
      setDeleting(false);
    }
  };

  // 来自复习队列：state 的字段由 ReviewCardView 注入。
  const reviewBack = (location.state as null | { from?: string; mode?: string; wordIds?: string[]; reviewed?: number; total?: number })?.from === "review"
    ? (location.state as { from: string; mode?: string; wordIds?: string[]; reviewed?: number; total?: number })
    : null;

  const goBack = () => {
    if (!reviewBack) {
      navigate("/words");
      return;
    }
    // SPA 中点击"查看详情"是 pushState 进入，上一条就是 /review，直接 navigate(-1) 返回复习页面；
    // 即使历史栈非预期（用户多开详情），兜底直接导航到 /review —— sessionStorage 缓存会恢复进度。
    if (typeof window !== "undefined" && window.history.length > 1) {
      navigate(-1);
      return;
    }
    const to = reviewBack.wordIds && reviewBack.wordIds.length > 0
      ? `/review?wordIds=${reviewBack.wordIds.join(",")}`
      : "/review";
    navigate(to, { replace: false });
  };

  const meta = word?.metadata ?? {};
  const morphologyParts = [
    ["前缀", meta.morphology_prefix],
    ["词根", meta.morphology_root],
    ["后缀", meta.morphology_suffix],
  ].filter(([, v]) => typeof v === "string" && v.length > 0) as Array<[string, string]>;
  const family = meta.morphology_family ?? [];
  // aliases 列的 DB 默认值是 ['']（含一个空串），必须过滤掉，否则 stub 词会被
  // 误判为“有内容”，并渲染出空的别名区块。
  const aliases = (word?.aliases ?? []).filter((alias) => alias.trim().length > 0);
  // L2 enrichment（搭配/语料/辨析）任一存在也算有内容，避免 stub 空态与 L2 区块同时出现。
  const l2 = word?.l2_content ?? null;
  const hasL2Content =
    (l2?.collocations ?? []).length > 0 ||
    (l2?.corpus_items ?? []).length > 0 ||
    (l2?.synonym_items ?? []).length > 0 ||
    (l2?.antonym_items ?? []).length > 0;

  // Stub words (e.g. created via batch import with only a lemma) have no
  // displayable content — render an explicit empty state instead of a bare page.
  const hasContent =
    (word?.definition_md ?? "").trim().length > 0 ||
    (word?.body_md ?? "").trim().length > 0 ||
    (word?.prototype_text ?? "").trim().length > 0 ||
    morphologyParts.length > 0 ||
    family.length > 0 ||
    (meta.mnemonic_text ?? "").trim().length > 0 ||
    (meta.semantic_chain ?? "").trim().length > 0 ||
    (meta.etymology_narrative ?? "").trim().length > 0 ||
    (word?.examples ?? []).length > 0 ||
    aliases.length > 0 ||
    hasL2Content;

  // 例句统一池：L1 收藏 + L2 生成的语料合并（L2 区块内不再重复渲染 corpus）
  const unifiedExamples = useMemo(
    () => (word ? buildUnifiedExamples(word) : []),
    [word],
  );

  // 页内锚点：只为实际渲染的区块生成导航项
  const anchorItems = useMemo<AnchorItem[]>(() => {
    if (!word) return [];
    const items: AnchorItem[] = [];
    if ((word.definition_md ?? "").trim().length > 0) items.push({ id: "sec-definition", label: "释义" });
    if ((word.prototype_text ?? "").trim().length > 0) items.push({ id: "sec-prototype", label: "原型" });
    if (morphologyParts.length > 0 || family.length > 0) items.push({ id: "sec-morphology", label: "形态" });
    if ((meta.mnemonic_text ?? "").trim().length > 0) items.push({ id: "sec-mnemonic", label: "记忆" });
    if ((meta.semantic_chain ?? "").trim().length > 0) items.push({ id: "sec-chain", label: "语义链" });
    if ((meta.etymology_narrative ?? "").trim().length > 0) items.push({ id: "sec-etymology", label: "词源" });
    if (unifiedExamples.length > 0) items.push({ id: "sec-examples", label: "例句" });
    if (hasL2Content) items.push({ id: "sec-l2", label: "L2 扩展" });
    // 笔记区（教材+批注整合）恒渲染，锚点恒可用
    items.push({ id: "sec-notes", label: "笔记" });
    // L3 语境区恒渲染，锚点恒可用
    items.push({ id: "l3-contexts", label: "语境" });
    return items;
  }, [word, unifiedExamples.length, hasL2Content, morphologyParts.length, family.length, meta]);

  const activeAnchor = useScrollSpy(anchorItems.map((item) => item.id));

  if (loading) {
    return (
      <Card className="flex items-center justify-center py-20">
        <Spinner />
        <span className="ml-3 text-[var(--color-ink-soft)]">加载单词详情...</span>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="py-20 text-center">
        <p className="text-[var(--color-accent-2)]">{error}</p>
        <Link to="/words">
          <Button className="mt-4" variant="secondary">返回词条库</Button>
        </Link>
      </Card>
    );
  }

  if (!word) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={goBack}>
          {reviewBack ? (
            <>
              <Undo2 className="h-4 w-4" />
              <span>返回复习队列</span>
              {typeof reviewBack.reviewed === "number" && typeof reviewBack.total === "number" && reviewBack.total > 0 && (
                <span className="ml-1 text-xs text-[var(--color-ink-soft)]">（{reviewBack.reviewed}/{reviewBack.total}）</span>
              )}
            </>
          ) : (
            <>
              <ArrowLeft className="h-4 w-4" />
              返回词条库
            </>
          )}
        </Button>
        {reviewBack && (
          <Link to="/words">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4" />
              返回词条库
            </Button>
          </Link>
        )}
      </div>

      <Card>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="section-title text-4xl font-bold text-[var(--color-ink)]">
              {word.lemma}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {word.pos && <Badge>{word.pos}</Badge>}
              {word.cefr && <Badge tone="warm">CEFR {word.cefr}</Badge>}
              {/* Phase E：晋升状态徽标（与下方"待扩展"提示互斥出现） */}
              {word.l2_promoted && <Badge tone="accent">已晋升 L2</Badge>}
              {word.ipa && (
                <span className="flex items-center gap-1 font-mono text-sm text-[var(--color-ink-soft)]">
                  {word.ipa}
                </span>
              )}
              <SpeakButton text={word.lemma} />
            </div>
            {/* E2：广场集合反链——语义场 / 词根家族徽标，点击跳回对应集合 */}
            {deriveWordCollections(meta).map((ref) => (
              <Link
                key={ref.slug}
                to={`/plaza/${encodeURIComponent(ref.slug)}`}
                className="mt-2 mr-2 inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-1 text-xs font-medium text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                title={`查看${ref.slug.startsWith("root-") ? "词根家族" : "语义场"}「${ref.title}」`}
              >
                {ref.slug.startsWith("root-")
                  ? <Layers className="h-3 w-3" />
                  : <Users className="h-3 w-3" />}
                {ref.title}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={quizMode ? "primary" : "secondary"}
              size="sm"
              onClick={() => setQuizMode((v) => !v)}
              title="自测模式：隐藏释义与翻译等答案字段，先回忆再点击揭示"
            >
              {quizMode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              自测{quizMode ? "开" : "关"}
            </Button>
            <PromoteL2Button slug={word.slug} promoted={Boolean(word.l2_promoted)} onPromoted={refresh} />
            <AddToReviewButton wordId={word.id} slug={word.slug} />
          </div>
        </div>

        {word.short_definition && (
          <p className="mt-4 border-l-2 border-[var(--color-accent)] pl-3 text-lg text-[var(--color-ink)]">
            {quizMode ? <Reveal>{word.short_definition}</Reveal> : word.short_definition}
          </p>
        )}
      </Card>

      {!hasContent && (
        <Card>
          <EmptyState
            title="该词条暂无详细内容"
            description="此词条可能由批量导入或捕获创建，尚未补充释义、词源等资料。你仍可以在这里添加自己的笔记。"
            action={isStub ? (
              <Button
                variant="ghost"
                onClick={deleteStub}
                disabled={deleting}
                title="仅空词条（stub）可删除；绑定了语境或笔记时会提示先清理"
              >
                <Trash2 className="h-4 w-4" />
                删除此空词条
              </Button>
            ) : undefined}
          />
        </Card>
      )}

      {anchorItems.length >= 2 && <AnchorNav items={anchorItems} active={activeAnchor} />}

      {(word.definition_md ?? "").trim().length > 0 && (
        <SectionCard title="核心释义" id="sec-definition">
          {quizMode ? (
            // 仅模糊加粗答案片段（如「口音，腔调」），括号解释/搭配保持可见
            <RevealMarkdown content={word.definition_md} />
          ) : (
            <Markdown content={word.definition_md} />
          )}
        </SectionCard>
      )}

      {(word.prototype_text ?? "").trim().length > 0 && (
        <SectionCard title="原型意象" id="sec-prototype">
          <div className="flex items-start gap-2 text-[var(--color-ink)]">
            <Lightbulb className="mt-1 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
            {/* L1 收藏集里 prototype 字段是 Markdown（画面锚加粗记号、词根反引号记号） */}
            <Markdown content={word.prototype_text ?? ""} />
          </div>
        </SectionCard>
      )}

      {(morphologyParts.length > 0 || family.length > 0) && (
        <SectionCard title="词源形态" id="sec-morphology">
          <div className="space-y-3">
            {morphologyParts.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {morphologyParts.map(([label, value]) => (
                  <span key={label} className="flex items-center gap-1">
                    <span className="text-[var(--color-ink-soft)]">{label}</span>
                    <code className="rounded bg-[var(--color-code-bg)] px-1.5 py-0.5 font-mono text-[var(--color-ink)]">{value}</code>
                    <Puzzle className="h-3 w-3 text-[var(--color-border)]" />
                  </span>
                ))}
              </div>
            )}
            {family.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-[var(--color-ink-soft)]">词族</span>
                {family.map((f) => (
                  <Link
                    key={f}
                    to={`/words/${f}`}
                    className="rounded-full bg-[var(--color-pill-warm-bg)] px-3 py-1 text-sm text-[var(--color-pill-warm-text)] transition-opacity hover:opacity-80"
                  >
                    {f}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {(meta.mnemonic_text ?? "").trim().length > 0 && (
        <SectionCard title={`记忆锚点${meta.mnemonic_type ? ` · ${meta.mnemonic_type}` : ""}`} id="sec-mnemonic">
          <div className="flex items-start gap-2 text-[var(--color-ink)]">
            <Quote className="mt-1 h-4 w-4 shrink-0 text-[var(--color-blockquote-border)]" />
            {/* mnemonic_text 是 Markdown（词源锚/画面锚加粗记号、词根反引号记号），不能用纯文本渲染 */}
            <Markdown content={meta.mnemonic_text as string} />
          </div>
        </SectionCard>
      )}

      {(meta.semantic_chain ?? "").trim().length > 0 && (
        <SectionCard title="语义链" id="sec-chain">
          <p className="flex flex-wrap items-center gap-2 font-mono text-sm text-[var(--color-ink)]">
            <Network className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
            {meta.semantic_chain?.split("->").map((s, i, arr) => (
              <span key={i} className="flex items-center gap-2">
                <span>{s.trim()}</span>
                {i < arr.length - 1 && <span className="text-[var(--color-accent)]">→</span>}
              </span>
            ))}
          </p>
        </SectionCard>
      )}

      {(meta.etymology_narrative ?? "").trim().length > 0 && (
        <CollapsibleSection title="词源故事" id="sec-etymology">
          <Markdown content={meta.etymology_narrative as string} />
        </CollapsibleSection>
      )}

      {unifiedExamples.length > 0 && (
        <SectionCard title={`例句（${unifiedExamples.length}）`} id="sec-examples">
          <div className="space-y-3">
            {unifiedExamples.map((ex, i) => (
              <div key={`${ex.text.slice(0, 24)}-${i}`} className="border-l-2 border-[var(--color-blockquote-border)] pl-4">
                <p className="text-[var(--color-ink)]">{ex.text}</p>
                {ex.translation && (
                  <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                    {quizMode ? <Reveal>{ex.translation}</Reveal> : ex.translation}
                  </p>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  {ex.origin === "l1" ? (
                    <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] text-[var(--color-ink-soft)]">
                      L1 收藏
                    </span>
                  ) : (
                    <ProvenanceBadge item={{ provenance: ex.provenance }} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* L2 enrichment：搭配 / 同义辨析 / 反义（语料例句已并入上方统一例句池）；
          生效内容的管理并入下方 Composer 的 Agent 候选 tab */}
      <div id="sec-l2" className="scroll-mt-32">
        <WordL2Content l2={l2} exclude={["corpus_items"]} quizMode={quizMode} />
      </div>

      {aliases.length > 0 && (
        <SectionCard title="别名">
          <div className="flex flex-wrap gap-2">
            {aliases.map((alias) => (
              <span
                key={alias}
                className="rounded-full bg-[var(--color-pill-warm-bg)] px-3 py-1 text-sm text-[var(--color-pill-warm-text)]"
              >
                {alias}
              </span>
            ))}
          </div>
        </SectionCard>
      )}

      {/* C2 业务联动：已晋升 L2 但尚无扩展内容 → 待扩展提示，指向下方 Composer */}
      {word.l2_promoted && !hasL2Content && (
        <Card className="border-[var(--color-accent)]">
          <p className="flex items-start gap-2 text-sm text-[var(--color-ink)]">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
            <span>
              这个词已进入辨析训练（L2）轨道，但还没有辨析素材。用下方「扩展内容」生成搭配、例句与近义辨析后，
              它们会直接成为训练题面。
            </span>
          </p>
        </Card>
      )}

      {/* L2 enrichment 扩展面板：AI 生成草稿 → 勾选保存 → 入库并刷新 L2 缓存 */}
      <WordL2Composer slug={word.slug} onConfirmed={refresh} />

      {/* 双笔记并排：教材笔记（L1 收藏集 body_md，只读）+ 我的批注（notes，可编辑） */}
      <div id="sec-notes" className="scroll-mt-32">
        <WordNotes slug={word.slug} textbookMd={word.body_md} />
      </div>

      {/* L3 语境：素材空间中含该词的语境记录，每条深链直达阅读视图（词卡↔素材双向跳转） */}
      <SectionCard title="L3 语境" id="l3-contexts">
        <WordL3Contexts slug={word.slug} />
      </SectionCard>
    </div>
  );
}
