import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { apiFetch } from "@/frontend/api/client";

interface MasteryFamily {
  token: string;
  slug: string;
  total: number;
  mastered: number;
  learning: number;
  meaning: string | null;
}

interface MasteryResponse {
  available: boolean;
  total: number;
  families: MasteryFamily[];
}

/** 家族状态档：已掌握 > 学习中 > 未开始（矩阵格与图谱节点共用的着色口径）。 */
export function familyStatus(
  family: Pick<MasteryFamily, "mastered" | "learning">,
): "mastered" | "learning" | "fresh" {
  if (family.mastered > 0) return "mastered";
  if (family.learning > 0) return "learning";
  return "fresh";
}

/**
 * P2-2 词根掌握矩阵：全部家族的 mastered/learning 分档热力格。
 * 未学 = total - mastered - learning（suspended 并入未学段）。
 */
export function RootMasteryMatrix({ minCount }: { minCount: number }) {
  const [data, setData] = useState<MasteryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    apiFetch<MasteryResponse>(`/api/plaza/roots/mastery-matrix?minCount=${minCount}`, {
      signal: controller.signal,
    })
      .then(setData)
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "加载掌握矩阵失败");
      });
    return () => controller.abort();
  }, [minCount]);

  const groups = useMemo(() => {
    const map = new Map<string, MasteryFamily[]>();
    for (const family of data?.families ?? []) {
      const letter = family.token[0]?.toUpperCase() ?? "?";
      const bucket = map.get(letter) ?? [];
      bucket.push(family);
      map.set(letter, bucket);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  if (error) {
    return <p className="text-sm text-[var(--color-accent-2)]">{error}</p>;
  }
  if (!data) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-[var(--color-ink-soft)]">
        <Spinner />
        加载掌握矩阵...
      </div>
    );
  }

  const counts = {
    mastered: data.families.filter((f) => f.mastered > 0).length,
    learning: data.families.filter((f) => f.mastered === 0 && f.learning > 0).length,
    fresh: data.families.filter((f) => f.mastered === 0 && f.learning === 0).length,
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[var(--color-ink-soft)]">
        <span>
          已掌握 <b className="text-[var(--color-accent)]">{counts.mastered}</b> 族
        </span>
        <span>
          学习中 <b className="text-[var(--color-highlight-key)]">{counts.learning}</b> 族
        </span>
        <span>
          未开始 <b>{counts.fresh}</b> 族
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[var(--color-accent)]" />
          有已掌握词
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[var(--color-highlight-key)]" />
          仅学习中
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)]" />
          未开始
        </span>
      </div>
      <div className="space-y-3">
        {groups.map(([letter, families]) => (
          <div key={letter} className="flex flex-wrap items-center gap-1.5">
            <span className="w-6 shrink-0 text-xs font-bold uppercase text-[var(--color-ink-soft)]">
              {letter}
            </span>
            {families.map((family) => {
              const status = familyStatus(family);
              const untrained = Math.max(0, family.total - family.mastered - family.learning);
              const tooltip =
                `-${family.token}- · 已掌握 ${family.mastered} · 学习中 ${family.learning} · 未学 ${untrained}` +
                (family.meaning ? ` · ${family.meaning}` : "");
              const masteredPct = (family.mastered / family.total) * 100;
              const learningPct = (family.learning / family.total) * 100;
              return (
                <Link
                  key={family.token}
                  to={`/plaza/${encodeURIComponent(family.slug)}`}
                  title={tooltip}
                  className={`w-[5.5rem] rounded-lg border px-2 py-1.5 transition-colors hover:border-[var(--color-accent)] ${
                    status === "mastered"
                      ? "border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)]"
                      : status === "learning"
                        ? "border-[var(--color-highlight-key)]/50 bg-[var(--color-rating-hard-bg)]"
                        : "border-[var(--color-border)] bg-[var(--color-surface-glass)]"
                  }`}
                >
                  <p className="truncate text-center text-xs font-semibold text-[var(--color-ink)]">
                    -{family.token}-
                  </p>
                  <div className="mt-1 flex h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                    <span style={{ width: `${masteredPct}%` }} className="bg-[var(--color-accent)]" />
                    <span style={{ width: `${learningPct}%` }} className="bg-[var(--color-highlight-key)]" />
                  </div>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
