import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { BookOpen, ChevronRight, Flame, Layers, Loader2, Play, Plus, Sparkles, Trash2, Users } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Button } from "@/frontend/components/ui/Button";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { useToast } from "@/frontend/components/ui/Toast";
import { PlazaPrecheckFlow } from "@/frontend/components/plaza/PlazaPrecheckFlow";
import { apiFetch } from "@/frontend/api/client";
import { extractRootTokens } from "@/frontend/utils/plazaSlugs";
import { RootNeighborhoodGraph } from "@/frontend/components/plaza/RootNeighborhoodGraph";

type PlazaKind = "semantic_field" | "root_affix";
type RootFamilyType = "simple" | "compound" | "mixed";

interface PlazaWordCard {
  id: string;
  slug: string;
  lemma: string;
  cefr: string | null;
  short_definition: string | null;
  semantic_chain: string | null;
}
interface RootWordCard extends PlazaWordCard {
  root: string | null;
  prefix: string | null;
  suffix: string | null;
}
interface PlazaCollectionDetail {
  slug: string;
  title: string;
  kind: PlazaKind;
  count: number;
  updatedAt: string;
  type?: RootFamilyType;
  /** 核心义（0052 词典命中时；未命中 null）。 */
  meaning?: string | null;
  /** 同族变体 token（0052 词典命中时；未命中空数组）。 */
  variants?: string[];
  /** 释义分支 → 词例（2026-10-10；词典 senses 命中时非空，按分支成对渲染）。 */
  senses?: Array<{ meaning: string; words: string[] }>;
  words: PlazaWordCard[] | RootWordCard[];
}
/** 集合内复习统计（E1 + P1-B 掌握分档）。 */
interface PlazaReviewStats {
  tracked: number;
  due: number;
  mastered: number;
  learning: number;
}

const TYPE_LABEL: Record<RootFamilyType, string> = {
  simple: "简单词根",
  compound: "复合词根",
  mixed: "混合词族",
};

export function PlazaCollectionPage() {
  const { slug = "" } = useParams();
  const [data, setData] = useState<PlazaCollectionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // E1：集合内复习统计（已追踪 / 待复习 / P1-B 掌握分档）
  const [reviewStats, setReviewStats] = useState<PlazaReviewStats | null>(null);
  // P0-B：整组加入复习计划（写队列，幂等；入队成功后统计即时刷新）
  const [enqueuing, setEnqueuing] = useState(false);
  const [enqueued, setEnqueued] = useState(false);
  // P1 队列编辑：整组移出（删除进度行）/ 优先学这一组（入队 + 提前到期）
  const [removing, setRemoving] = useState(false);
  const [prioritizing, setPrioritizing] = useState(false);
  // P1-A：生词预审快闪（先筛后生）
  const [precheckOpen, setPrecheckOpen] = useState(false);
  const { addToast } = useToast();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    // 语义场集合走 /plaza/collections/:slug；词根家族走 /plaza/roots/:slug
    const isRoot = slug.startsWith("root-");
    const path = isRoot ? `/plaza/roots/${encodeURIComponent(slug)}` : `/plaza/collections/${encodeURIComponent(slug)}`;
    apiFetch<PlazaCollectionDetail>(path, {
      signal: controller.signal,
    })
      .then((result) => setData(result))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "加载集合失败");
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoading(false);
      });
    // E1：集合内复习统计（独立端点，失败不阻塞详情）
    apiFetch<PlazaReviewStats>(`/plaza/review-stats/${encodeURIComponent(slug)}`, {
      signal: controller.signal,
    })
      .then(setReviewStats)
      .catch(() => { /* 统计非关键路径，失败静默 */ });
    return () => controller.abort();
  }, [slug]);

  // 集合内复习统计刷新（入队 / 预审入队后调用；非关键路径失败静默）
  const refreshReviewStats = () => {
    apiFetch<PlazaReviewStats>(`/plaza/review-stats/${encodeURIComponent(slug)}`)
      .then(setReviewStats)
      .catch(() => { /* 统计非关键路径，失败静默 */ });
  };

  // P0-B：整组加入复习计划——复用 /api/review/cards/batch（幂等，重复记 skipped）。
  const addCollectionToReview = async () => {
    if (!data || data.words.length === 0) return;
    setEnqueuing(true);
    try {
      const res = await apiFetch<{ ok: boolean; added: number; skipped: number }>("/api/review/cards/batch", {
        method: "POST",
        body: JSON.stringify({ wordIds: data.words.map((w) => w.id) }),
      });
      if (res.ok) {
        setEnqueued(true);
        addToast(
          "success",
          `成功加入 ${res.added} 词到复习队列${res.skipped > 0 ? `（已在队列 ${res.skipped} 词）` : ""}`,
        );
        refreshReviewStats(); // 入队后让「已追踪 / 待复习」即时反映本组进度
      }
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "批量加入复习失败");
    } finally {
      setEnqueuing(false);
    }
  };

  // P1 队列编辑：整组移出复习队列（物理删除进度行 + 审计；未命中幂等零行）。
  // 与「挂起」的差别：移出 = 离开队列（重新加入后 FSRS 从头）；挂起 = 留在书里但暂不复习。
  const removeCollectionFromReview = async () => {
    if (!data || data.words.length === 0) return;
    setRemoving(true);
    try {
      const res = await apiFetch<{ ok: boolean; count: number }>("/api/review/cards/remove", {
        method: "POST",
        body: JSON.stringify({ wordIds: data.words.map((w) => w.id) }),
      });
      if (res.ok) {
        setEnqueued(false);
        addToast("success", `已从复习队列移出 ${res.count} 词`);
        refreshReviewStats();
      }
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "移出复习队列失败");
    } finally {
      setRemoving(false);
    }
  };

  // P1 优先学习：先整组入队（幂等，已在队列的记 skipped），再全部提前到期 ——
  // 候选池排序（due_at ASC NULLS LAST）把这批词提到新卡之前，即「先学这一组」。
  const prioritizeCollection = async () => {
    if (!data || data.words.length === 0) return;
    setPrioritizing(true);
    try {
      const wordIds = data.words.map((w) => w.id);
      await apiFetch("/api/review/cards/batch", {
        method: "POST",
        body: JSON.stringify({ wordIds }),
      });
      const res = await apiFetch<{ ok: boolean; count: number }>("/api/review/cards/expire", {
        method: "POST",
        body: JSON.stringify({ wordIds }),
      });
      if (res.ok) {
        setEnqueued(true);
        addToast(
          "success",
          `已把 ${res.count} 词提到队列最前${res.count < wordIds.length ? "（其余本就在最前）" : ""}`,
        );
        refreshReviewStats();
      }
    } catch (err) {
      addToast("error", err instanceof Error ? err.message : "提升优先级失败");
    } finally {
      setPrioritizing(false);
    }
  };

  /**
   * 常见派生词精选（2026-10-10）：家族全量词已在下方列表，「常见派生词」chips
   * 只挑**最常用**的几张做速览 —— 口径：CEFR 越靠前越常用，同级按字母序；
   * 最多 6 个，避免与下方全列表重复刷屏。
   * 必须放在早退 return 之前（Hooks 顺序 invariant），用 data 判空代替 isRoot 局部量。
   */
  const representativeWords = useMemo(() => {
    if (!data || data.kind !== "root_affix") return [];
    const rank = (cefr: string | null): number => {
      const index = ["A1", "A2", "B1", "B2", "C1", "C2"].indexOf(cefr ?? "");
      return index === -1 ? 6 : index;
    };
    return [...data.words]
      .sort((a, b) => rank(a.cefr) - rank(b.cefr) || a.lemma.localeCompare(b.lemma))
      .slice(0, 6);
  }, [data]);

  /**
   * 分支词例 → 家族词卡（lemma 精确匹配，取 slug 做跳转）。senses 词例按约定
   * 都来自本家族；若词条不在家族（morphology_root 写法差异），该 chip 不渲染
   * —— 宁少不错，不给死链。
   */
  const wordByLemma = useMemo(() => {
    const map = new Map<string, PlazaWordCard>();
    if (!data) return map;
    for (const word of data.words) {
      map.set(word.lemma.toLowerCase(), word);
    }
    return map;
  }, [data]);

  if (loading) {
    return (
      <Card className="flex items-center justify-center py-12">
        <Spinner />
        <span className="ml-3 text-[var(--color-ink-soft)]">加载中...</span>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card className="py-12 text-center">
        <p className="text-[var(--color-accent-2)]">{error ?? "集合不存在"}</p>
        <Link to="/plaza" className="mt-4 inline-block text-sm font-semibold text-[var(--color-accent)]">
          返回词汇广场
        </Link>
      </Card>
    );
  }

  const isRoot = data.kind === "root_affix";
  const kindLabel = isRoot ? "词根词缀" : "语义场";

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-1.5 text-sm text-[var(--color-ink-soft)]">
        <Link to="/plaza" className="hover:text-[var(--color-ink)]">
          词汇广场
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-[var(--color-ink)]">{data.title}</span>
      </nav>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warm">{kindLabel}</Badge>
          <Badge>{isRoot ? `家族 ${data.count} 词` : `关联词条 ${data.count}`}</Badge>
          {isRoot && data.type && <Badge>{TYPE_LABEL[data.type]}</Badge>}
          {/* E1：集合内复习统计 */}
          {reviewStats && (
            <Badge>已追踪 {reviewStats.tracked}</Badge>
          )}
          {reviewStats && reviewStats.due > 0 && (
            <Badge tone="warm">待复习 {reviewStats.due}</Badge>
          )}
        </div>
        <h1 className="section-title mt-3 flex items-center gap-3 text-3xl font-bold text-[var(--color-ink)]">
          {isRoot ? <Layers className="h-7 w-7 text-[var(--color-accent)]" /> : <Users className="h-7 w-7 text-[var(--color-accent)]" />}
          {isRoot ? `-${data.title}-` : data.title}
        </h1>
        {/* 0052 词典增强（2026-10-10 升级）：优先按「释义分支 → 该支扩展词」成对渲染
            （多支词源一眼看清谁出自哪支）；词典无 senses 时回退「核心义 + CEFR 常用词」；
            全部未命中不渲染（自生长家族不硬凑）。 */}
        {isRoot && data.senses && data.senses.length > 0 && (
          <div className="mt-3 space-y-1.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
              词根释义 · 按词源分支
            </p>
            {data.senses.map((sense) => {
              const chips = sense.words
                .map((lemma) => wordByLemma.get(lemma.toLowerCase()))
                .filter((word): word is PlazaWordCard => Boolean(word));
              if (chips.length === 0) return null;
              return (
                <div key={sense.meaning} className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="min-w-0 text-sm font-medium text-[var(--color-ink)]">{sense.meaning}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {chips.map((word) => (
                      <Link
                        key={word.id}
                        to={`/words/${word.slug}`}
                        title={word.short_definition ?? word.lemma}
                        className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-0.5 text-xs text-[var(--color-ink)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                      >
                        {word.lemma}
                        {word.cefr && <span className="ml-1 text-[var(--color-ink-soft)]">{word.cefr}</span>}
                      </Link>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {isRoot && !(data.senses && data.senses.length > 0) && (data.meaning || representativeWords.length > 0) && (
          <div className="mt-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3">
            {data.meaning && (
              <p className="text-sm leading-6 text-[var(--color-ink)]">
                <span className="font-semibold text-[var(--color-ink)]">词根释义</span>
                <span className="mx-2 text-[var(--color-border-strong)]">·</span>
                {data.meaning}
              </p>
            )}
            {representativeWords.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-[var(--color-ink-soft)]">常见派生词</span>
                {representativeWords.map((word) => (
                  <Link
                    key={word.id}
                    to={`/words/${word.slug}`}
                    title={word.short_definition ?? word.lemma}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-0.5 text-xs text-[var(--color-ink)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  >
                    {word.lemma}
                    {word.cefr && <span className="ml-1 text-[var(--color-ink-soft)]">{word.cefr}</span>}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
        {/* 0052 词典增强：同族变体跳转（词源音变合并，未命中不渲染） */}
        {isRoot && data.variants && data.variants.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-[var(--color-ink-soft)]">同族变体：</span>
            {data.variants.map((variant) => (
              <Link
                key={variant}
                to={`/plaza/${encodeURIComponent(`root-${variant}`)}`}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                title={`查看词根家族「${variant}」`}
              >
                -{variant}-
              </Link>
            ))}
          </div>
        )}
        {/* P1-B：族级掌握环（review 绿 / learning 黄 / 未学 灰；分母=集合词数） */}
        {reviewStats && data.words.length > 0 && (
          <div className="mt-3 max-w-md">
            <div className="flex h-2.5 w-full overflow-hidden rounded-full border border-[var(--color-border)]">
              <div
                className="bg-[var(--color-accent)]"
                style={{ width: `${(reviewStats.mastered / data.words.length) * 100}%` }}
                title={`已掌握 ${reviewStats.mastered}`}
              />
              <div
                className="bg-[var(--color-highlight)]"
                style={{ width: `${(reviewStats.learning / data.words.length) * 100}%` }}
                title={`学习中 ${reviewStats.learning}`}
              />
              <div className="flex-1 bg-[var(--color-surface-muted)]" title="未学" />
            </div>
            <p className="mt-1.5 text-xs text-[var(--color-ink-soft)]">
              已掌握 {reviewStats.mastered} · 学习中 {reviewStats.learning} · 未学{" "}
              {Math.max(0, data.words.length - reviewStats.mastered - reviewStats.learning)}
            </p>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-[var(--color-ink-soft)]">
            {isRoot
              ? `共享「${data.title}」词根的 ${data.count} 个词——按词源关系组织，点进词条查看完整释义与词根结构。`
              : `按主题组织的 ${data.count} 个词条——浏览整组知识，点进词条可查看完整释义与词源。`}
          </p>
          {/* P1-A：生词预审快闪入口（逐词判定，只把「不认识」的词入队） */}
          {data.words.length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setPrecheckOpen(true)}>
              <Sparkles className="h-4 w-4" />
              先筛后生（{data.words.length}）
            </Button>
          )}
          {/* P0-B / P1：整组加入复习计划（写队列；幂等）—— 已入队态切换为「移出队列」 */}
          {data.words.length > 0 &&
            (enqueued ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={removeCollectionFromReview}
                disabled={removing}
                className="text-[var(--color-accent-2)]"
                title="移出 = 从复习队列删除（重新加入后从头学）；只是暂时不学请用复习卡上的「挂起」"
              >
                <Trash2 className="h-4 w-4" />
                {removing ? "移出中..." : `移出队列 (${data.words.length})`}
              </Button>
            ) : (
              <Button size="sm" onClick={addCollectionToReview} disabled={enqueuing}>
                {enqueuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {enqueuing ? "加入中..." : `加入复习计划 (${data.words.length})`}
              </Button>
            ))}
          {/* P1 优先学习：这一组的词提到候选池最前（先学这一组） */}
          {data.words.length > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={prioritizeCollection}
              disabled={prioritizing}
              title="把这一组全部入队并提前到期 —— 下一轮复习优先学它们"
            >
              {prioritizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Flame className="h-4 w-4" />}
              {prioritizing ? "提升中..." : "优先学这一组"}
            </Button>
          )}
          {/* E3：集合一键自由复习（复用 /review?wordIds= 通道，不评分不写复习数据） */}
          {data.words.length > 0 && (
            <Link to={`/review?wordIds=${data.words.map((w) => w.id).join(",")}`}>
              <Button size="sm" variant="secondary">
                <Play className="h-4 w-4" />
                自由复习该集合（{data.words.length}）
              </Button>
            </Link>
          )}
        </div>
      </div>

      {/* P2-3：词族邻域图谱（变体=虚线；共享复合 token=实线；节点色=掌握档） */}
      {isRoot && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-glass)] p-4">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-soft)]">
            词族图谱
          </p>
          <RootNeighborhoodGraph
            currentToken={data.title}
            variants={data.variants ?? []}
            wordRoots={(data.words as RootWordCard[]).map((word) => word.root ?? null)}
          />
          <p className="mt-1 text-center text-[11px] text-[var(--color-ink-soft)]">
            虚线 = 同族变体 · 实线 = 共享复合词根 · 节点颜色 = 掌握档（点击跳转）
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.words.map((word) => {
          const rootWord = word as RootWordCard;
          return (
            <Link key={word.id} to={`/words/${word.slug}`}>
              <Card className="h-full transition-colors hover:border-[var(--color-border-strong)]">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <BookOpen className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                    <p className="truncate text-lg font-semibold text-[var(--color-ink)]">{word.lemma}</p>
                  </div>
                  {word.cefr && <Badge className="shrink-0">{word.cefr}</Badge>}
                </div>
                {isRoot && (rootWord.prefix || rootWord.suffix || rootWord.root) && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    {rootWord.prefix && (
                      <span className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[var(--color-ink-soft)]">
                        {rootWord.prefix}
                      </span>
                    )}
                    {/* B4-2：复合词根（如 air + condition）拆 token，各 token 独立渲染为
                        可点击家族徽标——当前家族高亮，其他 token 跳转到对应家族。 */}
                    {rootWord.root && extractRootTokens(rootWord.root).map((token) => (
                      token === data.title ? (
                        <span
                          key={token}
                          className="rounded-md border border-[var(--color-accent)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-semibold text-[var(--color-accent)]"
                        >
                          {token}
                        </span>
                      ) : (
                        <Link
                          key={token}
                          to={`/plaza/${encodeURIComponent(`root-${token}`)}`}
                          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[var(--color-ink-soft)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                          title={`查看词根家族「${token}」`}
                        >
                          {token}
                        </Link>
                      )
                    ))}
                    {rootWord.suffix && (
                      <span className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[var(--color-ink-soft)]">
                        {rootWord.suffix}
                      </span>
                    )}
                  </div>
                )}
                {word.short_definition && (
                  <p className="mt-2 text-sm leading-6 text-[var(--color-ink-soft)]">
                    {word.short_definition}
                  </p>
                )}
                {word.semantic_chain && (
                  <p className="mt-3 line-clamp-2 border-t border-[var(--color-border)] pt-3 text-xs leading-5 text-[var(--color-ink-soft)]">
                    {word.semantic_chain}
                  </p>
                )}
              </Card>
            </Link>
          );
        })}
      </div>

      {/* P1-A：生词预审快闪（先筛后生）——只把标记为「不认识」的词写入复习队列 */}
      {precheckOpen && (
        <PlazaPrecheckFlow
          words={data.words}
          onClose={() => setPrecheckOpen(false)}
          onEnqueued={() => refreshReviewStats()}
        />
      )}
    </div>
  );
}
