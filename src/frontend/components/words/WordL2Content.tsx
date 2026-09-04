import { Link2, Quote, Scale, ArrowLeftRight } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import type {
  L2CollocationItem,
  L2CorpusItem,
  L2DiscriminationItem,
  L2Provenance,
  WordDetailL2Content,
} from "@/frontend/hooks/useWordDetail";

/** v1 provenance.source → 展示文案。 */
const SOURCE_LABELS: Record<string, string> = {
  manual: "手动",
  llm: "AI 生成",
  llm_edited: "AI · 已编辑",
  external_chat: "外部生成",
  dictionary: "词典",
  dictionary_llm_refined: "词典 + AI",
};

const TONE_LABELS: Record<string, string> = {
  formal: "正式",
  neutral: "中性",
  informal: "口语",
};

function provenanceOf(item: { provenance?: L2Provenance; [key: string]: unknown }): L2Provenance | null {
  const p = item.provenance;
  return p && typeof p === "object" ? p : null;
}

function ProvenanceBadge({ item }: { item: { provenance?: L2Provenance; [key: string]: unknown } }) {
  const provenance = provenanceOf(item);
  if (!provenance) return null;
  const source = typeof provenance.source === "string" ? provenance.source : null;
  if (!source) return null;
  const label = SOURCE_LABELS[source] ?? source;
  const dictionary = typeof provenance.dictionaryName === "string" ? provenance.dictionaryName : null;
  return (
    <span
      className="shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] text-[var(--color-ink-soft)]"
      title={dictionary ? `来源：${label}（${dictionary}）` : `来源：${label}`}
    >
      {dictionary ? `${label} · ${dictionary}` : label}
    </span>
  );
}

function ToneBadge({ tone }: { tone?: string }) {
  if (!tone) return null;
  const label = TONE_LABELS[tone];
  if (!label) return null;
  return (
    <span className="shrink-0 rounded-full bg-[var(--color-pill-warm-bg)] px-2 py-0.5 text-[11px] text-[var(--color-pill-warm-text)]">
      {label}
    </span>
  );
}

function L2Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <h3 className="section-title mb-3 flex items-center gap-2 text-base font-semibold text-[var(--color-ink)]">
        {icon}
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </Card>
  );
}

function CollocationList({ items }: { items: L2CollocationItem[] }) {
  return (
    <L2Section title="搭配" icon={<Link2 className="h-4 w-4 text-[var(--color-accent)]" />}>
      {items.map((item, i) => (
        <div key={`${item.phrase}-${i}`} className="rounded-lg border border-[var(--color-border)] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-sm font-semibold text-[var(--color-ink)]">{item.phrase}</code>
            <ToneBadge tone={item.tone} />
            <ProvenanceBadge item={item} />
          </div>
          {item.gloss && <p className="mt-1 text-sm text-[var(--color-ink)]">{item.gloss}</p>}
          {item.example && (
            <div className="mt-2 border-l-2 border-[var(--color-blockquote-border)] pl-3">
              <p className="text-sm text-[var(--color-ink)]">{item.example}</p>
              {item.exampleTranslation && (
                <p className="mt-0.5 text-xs text-[var(--color-ink-soft)]">{item.exampleTranslation}</p>
              )}
            </div>
          )}
        </div>
      ))}
    </L2Section>
  );
}

function CorpusList({ items }: { items: L2CorpusItem[] }) {
  return (
    <L2Section title="语料例句" icon={<Quote className="h-4 w-4 text-[var(--color-accent)]" />}>
      {items.map((item, i) => (
        <div key={`${item.text.slice(0, 24)}-${i}`} className="border-l-2 border-[var(--color-blockquote-border)] pl-4">
          <p className="text-[var(--color-ink)]">{item.text}</p>
          {item.translation && (
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{item.translation}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {item.source && (
              <span className="text-[11px] text-[var(--color-ink-soft)]">语境：{item.source}</span>
            )}
            <ProvenanceBadge item={item} />
          </div>
        </div>
      ))}
    </L2Section>
  );
}

function DiscriminationList({ items, title, icon }: { items: L2DiscriminationItem[]; title: string; icon: React.ReactNode }) {
  return (
    <L2Section title={title} icon={icon}>
      {items.map((item, i) => (
        <div key={`${item.word}-${i}`} className="rounded-lg border border-[var(--color-border)] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-sm font-semibold text-[var(--color-ink)]">{item.word}</code>
            <ToneBadge tone={item.tone} />
            <ProvenanceBadge item={item} />
          </div>
          {item.semanticDiff && <p className="mt-1 text-sm text-[var(--color-ink)]">{item.semanticDiff}</p>}
          <dl className="mt-2 space-y-1 text-xs text-[var(--color-ink-soft)]">
            {item.usage && (
              <div className="flex gap-2">
                <dt className="shrink-0">用法</dt>
                <dd className="font-mono">{item.usage}</dd>
              </div>
            )}
            {item.delta && (
              <div className="flex gap-2">
                <dt className="shrink-0">区别</dt>
                <dd>{item.delta}</dd>
              </div>
            )}
            {item.object && (
              <div className="flex gap-2">
                <dt className="shrink-0">对象</dt>
                <dd>{item.object}</dd>
              </div>
            )}
          </dl>
        </div>
      ))}
    </L2Section>
  );
}

/**
 * 词条详情的 L2 enrichment 展示区（搭配 / 语料例句 / 同义辨析 / 反义）。
 * 仅在存在内容时渲染；条目自 v1 wrapper 携带溯源时显示来源徽标。
 */
export function WordL2Content({ l2 }: { l2?: WordDetailL2Content | null }) {
  if (!l2) return null;
  const hasCollocations = (l2.collocations ?? []).length > 0;
  const hasCorpus = (l2.corpus_items ?? []).length > 0;
  const hasSynonyms = (l2.synonym_items ?? []).length > 0;
  const hasAntonyms = (l2.antonym_items ?? []).length > 0;
  if (!hasCollocations && !hasCorpus && !hasSynonyms && !hasAntonyms) return null;

  return (
    <div className="space-y-6" data-testid="word-l2-content">
      {hasCollocations && <CollocationList items={l2.collocations} />}
      {hasCorpus && <CorpusList items={l2.corpus_items} />}
      {hasSynonyms && (
        <DiscriminationList title="同义辨析" icon={<Scale className="h-4 w-4 text-[var(--color-accent)]" />} items={l2.synonym_items} />
      )}
      {hasAntonyms && (
        <DiscriminationList title="反义对照" icon={<ArrowLeftRight className="h-4 w-4 text-[var(--color-accent)]" />} items={l2.antonym_items} />
      )}
    </div>
  );
}
