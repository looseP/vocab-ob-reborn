import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Volume2 } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Button } from "@/frontend/components/ui/Button";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { apiFetch } from "@/frontend/api/client";

interface WordDetail {
  slug: string;
  title: string;
  lemma: string;
  pos: string | null;
  cefr: string | null;
  ipa: string | null;
  shortDefinition: string | null;
  definitionMd: string;
  bodyMd: string;
  examples: Array<{ text: string; translation?: string }>;
  aliases: string[];
  isPublished: boolean;
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
            <div className="mt-2 flex items-center gap-3 text-sm text-[var(--color-ink-soft)]">
              {word.pos && <span>{word.pos}</span>}
              {word.cefr && (
                <span className="rounded-full bg-[var(--color-pill-bg)] px-2 py-0.5 text-[var(--color-pill-text)]">
                  {word.cefr}
                </span>
              )}
              {word.ipa && (
                <span className="flex items-center gap-1 font-mono">
                  <Volume2 className="h-3 w-3" />
                  {word.ipa}
                </span>
              )}
            </div>
          </div>
        </div>

        {word.shortDefinition && (
          <p className="mt-4 text-lg text-[var(--color-ink)]">{word.shortDefinition}</p>
        )}
      </Card>

      {word.definitionMd && (
        <Card>
          <h2 className="section-title mb-3 text-lg font-semibold text-[var(--color-ink)]">
            释义
          </h2>
          <div className="prose prose-sm max-w-none text-[var(--color-ink-soft)]">
            {word.definitionMd}
          </div>
        </Card>
      )}

      {word.examples && word.examples.length > 0 && (
        <Card>
          <h2 className="section-title mb-3 text-lg font-semibold text-[var(--color-ink)]">
            例句
          </h2>
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
        </Card>
      )}

      {word.aliases && word.aliases.length > 0 && (
        <Card>
          <h2 className="section-title mb-3 text-lg font-semibold text-[var(--color-ink)]">
            别名
          </h2>
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
        </Card>
      )}
    </div>
  );
}
