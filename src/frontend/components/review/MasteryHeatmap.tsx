import { useEffect, useState, useMemo } from "react";
import { Calendar } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Skeleton } from "@/frontend/components/ui/Skeleton";
import { EmptyState } from "@/frontend/components/ui/EmptyState";
import { apiFetch } from "@/frontend/api/client";

interface HeatmapEntry {
  date: string;
  count: string;
}

function getIntensity(count: number): number {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 10) return 3;
  return 4;
}

const intensityColors = [
  "var(--color-surface-muted)",
  "var(--color-accent)",
  "var(--color-accent)",
  "var(--color-accent)",
  "var(--color-accent)",
];

const intensityOpacity = [0.3, 0.4, 0.6, 0.8, 1];

/** 显示时区(Asia/Shanghai)日键 —— 与后端 heatmap 的分组口径一致。 */
function dayKeyInDisplayTz(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : date.toISOString().slice(0, 10);
}

export function MasteryHeatmap() {
  const [entries, setEntries] = useState<HeatmapEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<{ items: HeatmapEntry[] }>("/review/heatmap?days=84")
      .then((result) => setEntries(result.items ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, []);

  const heatmapMap = useMemo(() => {
    const map = new Map<string, number>();
    entries.forEach((e) => map.set(e.date, parseInt(e.count, 10)));
    return map;
  }, [entries]);

  const weeks = useMemo(() => {
    const today = new Date();
    const weeks: Array<Array<{ date: string; count: number }>> = [];
    const totalDays = 84;
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - totalDays + 1);

    for (let w = 0; w < totalDays / 7; w++) {
      const week: Array<{ date: string; count: number }> = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + w * 7 + d);
        if (date > today) {
          week.push({ date: "", count: -1 });
        } else {
          const dateStr = dayKeyInDisplayTz(date);
          week.push({ date: dateStr, count: heatmapMap.get(dateStr) ?? 0 });
        }
      }
      weeks.push(week);
    }
    return weeks;
  }, [heatmapMap]);

  const totalReviews = useMemo(() => entries.reduce((sum, e) => sum + parseInt(e.count, 10), 0), [entries]);

  if (loading) return <Skeleton className="h-48 w-full" />;

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-[var(--color-accent)]" />
          <h2 className="section-title text-lg font-semibold text-[var(--color-ink)]">复习热力图</h2>
        </div>
        <span className="text-xs text-[var(--color-ink-soft)]">近 12 周 · {totalReviews} 次复习</span>
      </div>

      {totalReviews === 0 ? (
        <EmptyState title="暂无复习活动" description="开始复习后，热力图会显示每日复习情况" />
      ) : (
        <div className="overflow-x-auto">
          <div className="flex gap-1">
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-1">
                {week.map((day, di) => {
                  if (day.count === -1) {
                    return <div key={di} className="h-3 w-3" />;
                  }
                  const intensity = getIntensity(day.count);
                  return (
                    <div
                      key={di}
                      className="h-3 w-3 rounded-sm transition-colors"
                      style={{
                        backgroundColor: intensityColors[intensity],
                        opacity: intensityOpacity[intensity],
                      }}
                      title={`${day.date}: ${day.count} 次复习`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs text-[var(--color-ink-soft)]">
            <span>少</span>
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-3 w-3 rounded-sm"
                style={{ backgroundColor: intensityColors[i], opacity: intensityOpacity[i] }}
              />
            ))}
            <span>多</span>
          </div>
        </div>
      )}
    </Card>
  );
}
