/**
 * 素材宇宙（B1 体验层）：L3 空间首页。
 *
 * 设计基线条目：§1 E1/E2（开门第一眼是"我的"、数字在生长）、§2（区块与信息
 * 层级）、§4 状态矩阵（空态积累型导向、区块级加载/错误降级）。
 *
 * 三个读面并发拉取、区块级独立降级（任一失败不影响其余区块渲染）：
 * - 生长计数：GET /l3/space-summary（四类实体全量计数）
 * - 最近导入：GET /l3/sources?sort=recent&limit=5（复用书架端点）
 * - 最近圈记：GET /l3/occurrences?limit=20（服务端按 created_at DESC）
 *
 * 配色沿用既有 token；本文件不使用当前未定义的 --color-accent-soft
 * （见视觉走查 G-P0-1），软底统一用已定义的 --color-surface-muted。
 */
import { useCallback, useEffect, useState } from "react";
import type { L3OccurrenceListItem } from "@/domain";
import { apiFetch } from "@/frontend/api/client";
import { TYPE_LABELS, type L3SourceListItem } from "@/frontend/components/l3/L3Bookshelf";
import { L3GrowthChart } from "@/frontend/components/l3/L3GrowthChart";
import { Skeleton } from "@/frontend/components/ui/Skeleton";
import type { L3ShellSection } from "@/frontend/viewModels/l3ShellViewModel";
import {
  buildGrowthSeries,
  buildRecentCaptureGroups,
  formatUniverseCount,
  formatUniverseWhen,
  isUniverseEmpty,
} from "@/frontend/viewModels/l3UniverseViewModel";

interface L3HomePageProps {
  /** 打开某篇来源的阅读视图；带 contextId 时深链聚焦该圈记。 */
  onOpenSource(sourceId: string, contextId?: string): void;
  onNavigate(section: L3ShellSection): void;
}

interface UniverseCounts {
  sourceCount: number;
  contextCount: number;
  occurrenceCount: number;
  linkCount: number;
}

interface UniverseGrowth {
  windowDays: number;
  byDay: Array<{ day: string; occurrenceCount: number }>;
}

const COUNT_CARDS: Array<{ key: keyof UniverseCounts; label: string; hint: string }> = [
  { key: "sourceCount", label: "素材", hint: "导入的文章与笔记" },
  { key: "contextCount", label: "语境", hint: "圈记下来的句子与搭配" },
  { key: "occurrenceCount", label: "圈词", hint: "绑定到词卡的踪迹" },
  { key: "linkCount", label: "关联", hint: "语境之间的连线" },
];

export function L3HomePage({ onOpenSource, onNavigate }: L3HomePageProps) {
  const [counts, setCounts] = useState<UniverseCounts | null>(null);
  const [growth, setGrowth] = useState<UniverseGrowth | null>(null);
  const [sources, setSources] = useState<L3SourceListItem[] | null>(null);
  const [captures, setCaptures] = useState<L3OccurrenceListItem[] | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [reloadNonce, setReloadNonce] = useState(0);

  const load = useCallback(async () => {
    setFailures([]);
    const [summaryResult, sourcesResult, capturesResult] = await Promise.allSettled([
      apiFetch<{ counts: UniverseCounts; growth: UniverseGrowth }>("/l3/space-summary", { timeoutMs: 15_000 }),
      apiFetch<{ items: L3SourceListItem[] }>("/l3/sources?sort=recent&limit=5", { timeoutMs: 15_000 }),
      apiFetch<{ items: L3OccurrenceListItem[] }>("/l3/occurrences?limit=20", { timeoutMs: 15_000 }),
    ]);

    const failed: string[] = [];
    if (summaryResult.status === "fulfilled") {
      setCounts(summaryResult.value.counts);
      setGrowth(summaryResult.value.growth);
    } else failed.push("生长计数");
    if (sourcesResult.status === "fulfilled") setSources(sourcesResult.value.items ?? []);
    else failed.push("最近导入");
    if (capturesResult.status === "fulfilled") setCaptures(capturesResult.value.items ?? []);
    else failed.push("最近圈记");
    setFailures(failed);
  }, []);

  useEffect(() => { void load(); }, [load, reloadNonce]);

  const empty = isUniverseEmpty(counts);
  const groups = buildRecentCaptureGroups(captures ?? [], 5);

  return (
    <section className="l3-page">
      <div>
        <p className="eyebrow">L3 Material Space</p>
        <h2 className="text-lg font-semibold text-[var(--color-ink)]">我的素材宇宙</h2>
        <p className="text-[13px] text-[var(--color-ink-soft)]">
          你读过的每一篇、圈下的每一个词，都在这里慢慢长成网络。
        </p>
      </div>

      {failures.length > 0 && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12px] text-[var(--color-ink-soft)]">
          {failures.join(" / ")} 暂未加载出来
          <button
            type="button"
            onClick={() => setReloadNonce((n) => n + 1)}
            className="ml-2 text-[var(--color-accent)] hover:underline"
          >
            重试
          </button>
        </div>
      )}

      {/* ① 生长计数：积累型数字（只随积累变大，不因复习被消耗） */}
      <div className="l3-status-grid">
        {COUNT_CARDS.map((card) => (
          <div key={card.key}>
            <span>{card.label}</span>
            {counts ? (
              <strong className="text-xl">{formatUniverseCount(counts[card.key])}</strong>
            ) : (
              <Skeleton className="h-6 w-12" />
            )}
            <span className="normal-case tracking-normal">{card.hint}</span>
          </div>
        ))}
      </div>

      {/* ② 生长趋势（B2）：累计圈词曲线——"看到自己的知识网络在长大"。
          空态不渲染（基线 §4：不显示尴尬的空坐标）。 */}
      {counts && growth && !empty && (
        <L3GrowthChart
          series={buildGrowthSeries(growth.byDay, growth.windowDays, counts.occurrenceCount)}
          label={`圈词累计 · 近 ${growth.windowDays} 天`}
        />
      )}

      {empty ? (
        /* 空态：积累型导向——不上筛选器、不显示"0 条"的空壳列表 */
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-6">
          <p className="text-[13.5px] text-[var(--color-ink)]">
            你的素材宇宙还很安静——导入第一篇文章，让它开始生长。
          </p>
          <p className="mt-1 text-[12px] text-[var(--color-ink-soft)]">
            粘贴《经济学人》的一段、一篇真题阅读、或者自己写的一篇作文，都可以成为第一份素材。
          </p>
          <button
            type="button"
            onClick={() => onNavigate("source")}
            className="mt-3 rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs text-[var(--color-accent-contrast,var(--color-surface))]"
          >
            去导入第一篇
          </button>
        </div>
      ) : (
        <>
          {/* ② 最近导入 */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-[12px] font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">最近导入</p>
              <button
                type="button"
                onClick={() => onNavigate("source")}
                className="text-[11.5px] text-[var(--color-accent)] hover:underline"
              >
                全部素材 →
              </button>
            </div>
            {sources === null ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <ul className="space-y-2">
                {sources.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onOpenSource(item.id)}
                      className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]"
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--color-ink)]">{item.title}</span>
                        <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-ink-soft)]">
                          {TYPE_LABELS[item.source_type] ?? item.source_type}
                        </span>
                        <span className="shrink-0 text-[10px] text-[var(--color-ink-soft)]">{item.context_count} 语境</span>
                        <span className="shrink-0 text-[10px] text-[var(--color-ink-soft)]">{formatUniverseWhen(item.created_at)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ③ 最近圈记（同句多词合并为一行） */}
          <div>
            <p className="mb-1.5 text-[12px] font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">最近圈记</p>
            {captures === null ? (
              <Skeleton className="h-20 w-full" />
            ) : groups.length === 0 ? (
              <p className="text-[12.5px] text-[var(--color-ink-soft)]">
                还没有圈记——在阅读视图里选中一个词，这里就会长出第一条。
              </p>
            ) : (
              <ul className="space-y-2">
                {groups.map((group) => (
                  <li key={group.contextId}>
                    <button
                      type="button"
                      onClick={() => onOpenSource(group.sourceId, group.contextId)}
                      className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left transition-colors hover:border-[var(--color-accent)]"
                    >
                      <span className="block text-[12.5px] leading-relaxed text-[var(--color-ink)]">{group.excerpt}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        {group.words.map((slug) => (
                          <span
                            key={slug}
                            className="rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] text-[var(--color-accent)]"
                          >
                            {slug}
                          </span>
                        ))}
                        <span className="ml-auto shrink-0 text-[10px] text-[var(--color-ink-soft)]">
                          {group.sourceTitle} · {formatUniverseWhen(group.createdAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {/* ④ 视角入口：空间 = 三个取景框（来源 / 词 / 网络） */}
      <div className="flex flex-wrap gap-2">
        {(
          [
            ["source", "来源书架"],
            ["word", "词空间"],
            ["graph", "关联图"],
          ] as Array<[L3ShellSection, string]>
        ).map(([section, label]) => (
          <button
            key={section}
            type="button"
            onClick={() => onNavigate(section)}
            className="rounded-full border border-[var(--color-border)] px-3 py-1 text-[11.5px] text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
