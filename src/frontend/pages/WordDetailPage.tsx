import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Volume2, Lightbulb, Network, Puzzle, Quote } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Badge } from "@/frontend/components/ui/Badge";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { Markdown } from "@/frontend/components/ui/Markdown";
import { WordNotes } from "@/frontend/components/words/WordNotes";
import { AddToReviewButton } from "@/frontend/components/words/AddToReviewButton";
import { apiFetch } from "@/frontend/api/client";

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
  body_md: string;
  examples: Array<{ text: string; translation?: string }>;
  prototype_text?: string | null;
  aliases: string[];
  metadata?: {
    morphology_prefix?: string;
    morphology_root?: string;
    morphology_suffix?: string;
    morphology_family?: string[];
    etymology_narrative?: string;
    mnemonic_type?: string;
    mnemonic_text?: string;
    semantic_chain?: string;
    [key: string]: unknown;
  } | null;
}

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
  const [word, setWord] = useState<WordDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    apiFetch<WordDetail>(`/words/${slug}`)
      .then((data) => {
        setWord(data);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [slug]);

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

  return (
    <div className="space-y-6">
      <Link to="/words">
        <Button variant="ghost" size="sm">
          <ArrowLeft className="h-4 w-4" />
          返回词条库
        </Button>
      </Link>

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

      {word.aliases && word.aliases.length > 0 && (
        <SectionCard title="别名">
          <div className="flex flex-wrap gap-2">
            {word.aliases.map((alias) => (
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
