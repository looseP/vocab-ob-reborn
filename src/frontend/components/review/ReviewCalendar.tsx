/**
 * 复习日历（M2，2026-10-08）—— 双向条带：左边看「复习了什么」，右边看「什么时候到期」。
 *
 * 数据来自两条**只读**端点：
 *  - `GET /api/review/stats/calendar?days=30` → 过去（已复习量）/ 今天（双值）/ 未来（到期量）；
 *  - `GET /api/review/day?date=&scope=due|reviewed` → 点某天列词（**只读展示，不进复习流**）。
 *
 * 三个口径必须与后端一致，否则日历会与仪表盘卡片互相矛盾：
 *  ① 日历日 = 服务端给的 `today.date`（Asia/Shanghai）—— **不用浏览器本地时区**算，
 *     否则跨时区/跨零点会和桶对不齐；
 *  ② 未来侧不含挂起词（后端已排除）；积压并入「今天」那一桶；
 *  ③ 过去侧只含有活动的日子 → 前端按日序列**补零**，不让空白日消失（那会骗人）。
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Loader2 } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Skeleton } from "@/frontend/components/ui/Skeleton";
import { apiFetch } from "@/frontend/api/client";

interface CalendarData {
  past: Array<{ date: string; reviewed: number }>;
  today: { date: string; dueNow: number; reviewedToday: number };
  future: Array<{ date: string; due: number }>;
}

interface DayWord {
  id: string;
  slug: string;
  title: string;
  lemma: string;
  shortDefinition: string | null;
}

interface DayData {
  date: string;
  scope: "due" | "reviewed";
  total: number;
  items: DayWord[];
}

/** 两侧各展示多少天（与后端默认窗口一致）。 */
export const CALENDAR_SPAN = 30;

/** 按 `YYYY-MM-DD` 加天数 —— 用 UTC 算术，避开本地时区偏移。 */
export function shiftDate(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** 构造连续日序列并补零（缺桶 = 该日 0 张，而不是「这天不存在」）。 */
export function buildSeries(
  todayKey: string,
  span: number,
  offsetFromToday: (index: number) => number,
  values: Map<string, number>,
): Array<{ date: string; value: number }> {
  return Array.from({ length: span }, (_, index) => {
    const date = shiftDate(todayKey, offsetFromToday(index));
    return { date, value: values.get(date) ?? 0 };
  });
}

/** `MM-DD`（条带上的刻度，省地方）。 */
function shortLabel(key: string): string {
  return key.slice(5);
}

function Strip({ series, testId, tone }: {
  series: Array<{ date: string; value: number }>;
  testId: string;
  tone: "past" | "future";
}) {
  const max = Math.max(1, ...series.map((day) => day.value));
  return (
    <div className="flex items-end gap-[2px]" data-testid={testId}>
      {series.map((day) => (
        <div
          key={day.date}
          title={`${day.date}：${day.value} 张`}
          data-date={day.date}
          data-value={day.value}
          className={`flex-1 rounded-sm ${tone === "past" ? "bg-[var(--color-accent-2)]" : "bg-[var(--color-accent)]"}`}
          style={{ height: `${Math.max(2, Math.round((day.value / max) * 32))}px`, opacity: day.value === 0 ? 0.18 : 1 }}
        />
      ))}
    </div>
  );
}

export function ReviewCalendar() {
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<{ date: string; scope: "due" | "reviewed" } | null>(null);
  const [day, setDay] = useState<DayData | null>(null);
  const [dayLoading, setDayLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    return apiFetch<CalendarData>(`/review/stats/calendar?days=${CALENDAR_SPAN}`)
      .then((result) => setData(result))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDay = useCallback((date: string, scope: "due" | "reviewed") => {
    setSelected({ date, scope });
    setDayLoading(true);
    setDay(null);
    void apiFetch<DayData>(`/review/day?date=${date}&scope=${scope}&limit=50`)
      .then((result) => setDay(result))
      .catch(() => setDay(null))
      .finally(() => setDayLoading(false));
  }, []);

  if (loading) {
    return (
      <Card>
        <Skeleton className="h-40 w-full" />
      </Card>
    );
  }
  // fail-closed：载荷不合契约形状（如测试桩对未知端点返回残缺对象）时按失败处理，
  // 绝不带着 `data.today` 为 undefined 往下渲染 —— 那会整页白屏（2026-10-08 全量测试抓到）。
  if (failed || !data?.today?.date || !Array.isArray(data.past) || !Array.isArray(data.future)) {
    return (
      <Card>
        <p className="text-sm text-[var(--color-ink-soft)]">日历加载失败，稍后重试。</p>
      </Card>
    );
  }

  const todayKey = data.today.date;
  const pastSeries = buildSeries(todayKey, CALENDAR_SPAN, (i) => i - (CALENDAR_SPAN - 1),
    new Map(data.past.map((day_) => [day_.date, day_.reviewed])));
  const futureSeries = buildSeries(todayKey, CALENDAR_SPAN, (i) => i + 1,
    new Map(data.future.map((day_) => [day_.date, day_.due])));
  const pastTotal = pastSeries.reduce((sum, day_) => sum + day_.value, 0);
  const futureTotal = futureSeries.reduce((sum, day_) => sum + day_.value, 0);

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
          <CalendarDays className="h-5 w-5 text-[var(--color-accent)]" />
          复习日历
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">今天待做 {data.today.dueNow}</Badge>
          <Badge tone="warm">今天已复习 {data.today.reviewedToday}</Badge>
        </div>
      </div>

      <div className="space-y-5">
        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-[var(--color-ink-soft)]">
            <span>过去 {CALENDAR_SPAN} 天 · 共复习 {pastTotal} 张（点柱子看当天复习了哪些）</span>
            <span>{shortLabel(pastSeries[0].date)} → {shortLabel(todayKey)}</span>
          </div>
          <button
            type="button"
            className="block w-full cursor-pointer text-left"
            onClick={() => openDay(todayKey, "reviewed")}
            aria-label="查看今天的复习记录"
          >
            <Strip series={pastSeries} testId="calendar-strip-past" tone="past" />
          </button>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-[var(--color-ink-soft)]">
            <span>未来 {CALENDAR_SPAN} 天 · 共到期 {futureTotal} 张（点柱子看那天到期哪些词）</span>
            <span>{shortLabel(shiftDate(todayKey, 1))} → {shortLabel(shiftDate(todayKey, CALENDAR_SPAN))}</span>
          </div>
          <button
            type="button"
            className="block w-full cursor-pointer text-left"
            onClick={() => openDay(shiftDate(todayKey, 1), "due")}
            aria-label="查看明天到期的词"
          >
            <Strip series={futureSeries} testId="calendar-strip-future" tone="future" />
          </button>
        </div>

        <p className="text-xs text-[var(--color-ink-soft)]">
          口径：日历日按 Asia/Shanghai；未来侧不含挂起词；今天到期数含**积压**（已过期未复习的词都算今天）。
        </p>

        {selected && (
          <div className="rounded-xl border border-[var(--color-border)] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-[var(--color-ink)]">
                {selected.date} · {selected.scope === "due" ? "到期" : "复习过"}
              </span>
              {day && <span className="text-xs text-[var(--color-ink-soft)]">共 {day.total} 张</span>}
            </div>
            {dayLoading ? (
              <div className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
                <Loader2 className="h-4 w-4 animate-spin" />加载中…
              </div>
            ) : day && day.items.length > 0 ? (
              <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
                {day.items.map((word) => (
                  <li key={word.id} className="flex items-baseline gap-2">
                    <span className="font-medium text-[var(--color-ink)]">{word.lemma}</span>
                    {word.shortDefinition && (
                      <span className="truncate text-[var(--color-ink-soft)]">{word.shortDefinition}</span>
                    )}
                  </li>
                ))}
                {day.total > day.items.length && (
                  <li className="text-xs text-[var(--color-ink-soft)]">…还有 {day.total - day.items.length} 张未列出</li>
                )}
              </ul>
            ) : (
              <p className="text-sm text-[var(--color-ink-soft)]">这天没有记录。</p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
