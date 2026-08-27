import { useParams, Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Volume2, Lightbulb, Network, Puzzle, Quote, Undo2 } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { Markdown } from "@/frontend/components/ui/Markdown";
import { WordNotes } from "@/frontend/components/words/WordNotes";
import { AddToReviewButton } from "@/frontend/components/words/AddToReviewButton";
import { useWordDetail, type WordDetail } from "@/frontend/hooks/useWordDetail";

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <h2 className="section-title mb-3 flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
        {title}
      </h2>
      {children}
    </Card>
  );
}

export function WordDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { word, loading, error } = useWordDetail(slug);

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

  const meta = word.metadata ?? {};
  const morphologyParts = [
    ["前缀", meta.morphology_prefix],
    ["词根", meta.morphology_root],
    ["后缀", meta.morphology_suffix],
  ].filter(([, v]) => typeof v === "string" && v.length > 0) as Array<[string, string]>;
  const family = meta.morphology_family ?? [];
  // aliases 列的 DB 默认值是 ['']（含一个空串），必须过滤掉，否则 stub 词会被
  // 误判为“有内容”，并渲染出空的别名区块。
  const aliases = (word.aliases ?? []).filter((alias) => alias.trim().length > 0);

  // Stub words (e.g. created via batch import with only a lemma) have no
  // displayable content — render an explicit empty state instead of a bare page.
  const hasContent =
    (word.definition_md ?? "").trim().length > 0 ||
    (word.body_md ?? "").trim().length > 0 ||
    (word.prototype_text ?? "").trim().length > 0 ||
    morphologyParts.length > 0 ||
    family.length > 0 ||
    (meta.mnemonic_text ?? "").trim().length > 0 ||
    (meta.semantic_chain ?? "").trim().length > 0 ||
    (meta.etymology_narrative ?? "").trim().length > 0 ||
    (word.examples ?? []).length > 0 ||
    aliases.length > 0;

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
              {word.ipa && (
                <span className="flex items-center gap-1 font-mono text-sm text-[var(--color-ink-soft)]">
                  <Volume2 className="h-3 w-3" />
                  {word.ipa}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <AddToReviewButton wordId={word.id} slug={word.slug} />
          </div>
        </div>

        {word.short_definition && (
          <p className="mt-4 border-l-2 border-[var(--color-accent)] pl-3 text-lg text-[var(--color-ink)]">
            {word.short_definition}
          </p>
        )}
      </Card>

      {!hasContent && (
        <Card>
          <EmptyState
            title="该词条暂无详细内容"
            description="此词条可能由批量导入或捕获创建，尚未补充释义、词源等资料。你仍可以在这里添加自己的笔记。"
          />
        </Card>
      )}

      {(word.definition_md ?? "").trim().length > 0 && (
        <SectionCard title="核心释义">
          <Markdown content={word.definition_md} />
        </SectionCard>
      )}

      {(word.prototype_text ?? "").trim().length > 0 && (
        <SectionCard title="原型意象">
          <p className="flex items-start gap-2 text-[var(--color-ink)]">
            <Lightbulb className="mt-1 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
            {word.prototype_text}
          </p>
        </SectionCard>
      )}

      {(morphologyParts.length > 0 || family.length > 0) && (
        <SectionCard title="词源形态">
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
        <SectionCard title={`记忆锚点${meta.mnemonic_type ? ` · ${meta.mnemonic_type}` : ""}`}>
          <p className="flex items-start gap-2 italic text-[var(--color-ink)]">
            <Quote className="mt-1 h-4 w-4 shrink-0 text-[var(--color-blockquote-border)]" />
            {meta.mnemonic_text}
          </p>
        </SectionCard>
      )}

      {(meta.semantic_chain ?? "").trim().length > 0 && (
        <SectionCard title="语义链">
          <p className="flex items-center gap-2 font-mono text-sm text-[var(--color-ink)]">
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
        <SectionCard title="词源故事">
          <Markdown content={meta.etymology_narrative as string} />
        </SectionCard>
      )}

      {word.examples && word.examples.length > 0 && (
        <SectionCard title="例句">
          <div className="space-y-3">
            {word.examples.map((ex, i) => (
              <div key={i} className="border-l-2 border-[var(--color-blockquote-border)] pl-4">
                <p className="text-[var(--color-ink)]">{ex.text}</p>
                {ex.translation && (
                  <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{ex.translation}</p>
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

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

      {(word.body_md ?? "").trim().length > 0 && (
        <details className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]">
          <summary className="cursor-pointer list-none px-5 py-4 text-lg font-semibold text-[var(--color-ink)] transition-colors group-open:text-[var(--color-accent)]">
            笔记原文（L1 收藏集）
          </summary>
          <div className="px-5 pb-5">
            <Markdown content={word.body_md} />
          </div>
        </details>
      )}

      <WordNotes slug={word.slug} />
    </div>
  );
}
