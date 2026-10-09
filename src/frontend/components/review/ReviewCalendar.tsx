/**
 * 复习活动卡（批次 2，2026-10-09 —— 原「复习日历」M2 的三合一升级）。
 *
 * 合并动机：仪表盘曾把**同一份** review_logs 数据画三遍 ——
 * ① 日历过去条带（30 天）、② 独立热力图卡（84 格网）、③ 独立时间线卡（流水列词）；
 * 而「点某天列词」（/review/day）与时间线的列词互为重复实现。于是：
 *  - 格网成为本卡「过去」侧的第二个视图（条带 / 12 周切换），热力图独立卡删撤；
 *  - 时间线流水升级为「最近会话」摘要（按显示时区日聚合 + 评分分布），点行 = 点那天；
 *  - 单日词表只有本卡一处实现（条带、格网、会话行三个入口共用）。
 *
 * 数据来自三条**只读**端点：
 *  - `GET /api/review/stats/calendar?days=84` → 过去（已复习量）/ 今天（双值）/ 未来（到期量）；
 *    一次拿全 12 周：条带取窗口末 30 天、格网用整 84 天。
 *  - `GET /api/review/timeline?limit=50` → 最近会话摘要（失败只收起摘要块，不拖垮日历本体）。
 *  - `GET /api/review/day?date=&scope=due|reviewed` → 点某天列词（**只读展示，不进复习流**）。
 *
 * 三个口径必须与后端一致，否则日历会与仪表盘卡片互相矛盾：
 *  ① 日历日 = 服务端给的 `today.date`（Asia/Shanghai）—— **不用浏览器本地时区**算；
 *  ② 未来侧不含挂起词（后端已排除）；积压并入「今天」那一桶；
 *  ③ 过去侧只含有活动的日子 → 前端按日序列**补零**，不让空白日消失（那会骗人）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, CalendarDays, Grid3x3, Loader2 } from "lucide-react";
import { Card } from "@/frontend/components/ui/Card";
import { Badge } from "@/frontend/components/ui/Badge";
import { Button } from "@/frontend/components/ui/Button";
import { Skeleton } from "@/frontend/components/ui/Skeleton";
import { apiFetch } from "@/frontend/api/client";
import {
  aggregateSessions,
  buildGridWeeks,
  buildMonthLabels,
  heatLevel,
  HEAT_LEVEL_OPACITY,
  type SessionDigest,
} from "@/frontend/components/review/review-activity-model";

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

/** 会话聚合的输入（timeline 契约子集）。 */
interface TimelineItem {
  rating: string;
  created_at: string;
}

/** 条带展示多少天（与后端条带窗口一致）。 */
export const CALENDAR_SPAN = 30;
/** 格网视图窗口：12 周（请求一次覆盖条带 + 格网两种视图）。 */
export const CALENDAR_PAST_GRID_SPAN = 84;
/** 最近会话摘要展示多少天。 */
export const SESSION_DIGEST_LIMIT = 5;

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

/** 会话行的日期标签：今天 / 昨天 / MM-DD。 */
export function sessionDateLabel(dateKey: string, todayKey: string): string {
  if (dateKey === todayKey) return "今天";
  if (dateKey === shiftDate(todayKey, -1)) return "昨天";
  return shortLabel(dateKey);
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

/** 星期轴标记（行 0 = 周一 … 行 6 = 周日），够定位「哪一周」即可。 */
const WEEKDAY_MARKS = ["一", "", "三", "", "五", "", "日"] as const;

/** 过去侧的格网视图：列 = 周（周一起），行 = 周一..周日；每格可点。 */
function PastGrid({ series, onSelect }: {
  series: Array<{ date: string; value: number }>;
  onSelect: (date: string) => void;
}) {
  const weeks = useMemo(() => buildGridWeeks(series), [series]);
  const monthLabels = useMemo(() => buildMonthLabels(weeks), [weeks]);
  const max = Math.max(1, ...series.map((day) => day.value));
  return (
    <div className="overflow-x-auto" data-testid="calendar-past-grid">
      {/* 月份标签行（稀疏：月份变化的列出一个）—— pl-4 对齐星期轴列宽 */}
      <div className="flex gap-1 pl-4">
        {weeks.map((_, column) => {
          const label = monthLabels.find((month) => month.column === column);
          return (
            <div key={column} className="relative h-4 w-3">
              {label && (
                <span className="absolute left-0 top-0 whitespace-nowrap text-[10px] leading-none text-[var(--color-ink-soft)]">
                  {label.label}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex gap-1">
        {/* 星期轴：只标 一/三/五/日 */}
        <div className="flex flex-col gap-1">
          {WEEKDAY_MARKS.map((mark, index) => (
            <div
              key={index}
              className="flex h-3 w-3 items-center justify-center text-[9px] leading-none text-[var(--color-ink-soft)]"
            >
              {mark}
            </div>
          ))}
        </div>
        {weeks.map((week, weekIndex) => (
          <div key={weekIndex} className="flex flex-col gap-1">
            {week.map((cell, dayIndex) =>
              cell.date === null ? (
                <div key={dayIndex} className="h-3 w-3" />
              ) : (
                <button
                  key={dayIndex}
                  type="button"
                  data-date={cell.date}
                  data-value={cell.value}
                  title={`${cell.date}：${cell.value} 次复习`}
                  onClick={() => onSelect(cell.date as string)}
                  className="h-3 w-3 cursor-pointer rounded-sm bg-[var(--color-accent)] transition-opacity hover:opacity-100"
                  style={{ opacity: HEAT_LEVEL_OPACITY[heatLevel(cell.value, max)] }}
                />
              ),
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 pl-4 text-xs text-[var(--color-ink-soft)]">
        <span>少</span>
        {HEAT_LEVEL_OPACITY.map((opacity, level) => (
          <div key={level} className="h-3 w-3 rounded-sm bg-[var(--color-accent)]" style={{ opacity }} />
        ))}
        <span>多</span>
        <span className="ml-2">每格一天 · 列为一周（周一起）</span>
      </div>
    </div>
  );
}

/** 一行会话摘要：日期 + 当日张数 + 评分分布（点行 = 看当天复习了哪些词）。 */
function SessionDigestRow({ digest, todayKey, active, onOpen }: {
  digest: SessionDigest;
  todayKey: string;
  active: boolean;
  onOpen: () => void;
}) {
  const parts = [
    { key: "again", label: "重来", value: digest.byRating.again, dot: "bg-[var(--color-accent-2)]" },
    { key: "hard", label: "困难", value: digest.byRating.hard, dot: "bg-[var(--color-highlight)]" },
    { key: "good", label: "良好", value: digest.byRating.good, dot: "bg-[var(--color-accent)]" },
    { key: "easy", label: "简单", value: digest.byRating.easy, dot: "bg-[var(--color-accent)]" },
  ].filter((part) => part.value > 0);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={active}
      data-testid={`session-row-${digest.date}`}
      className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
        active
          ? "border-[var(--color-border-strong)] bg-[var(--color-surface-glass-hover)]"
          : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"
      }`}
    >
      <span className="w-12 shrink-0 font-medium text-[var(--color-ink)]">
        {sessionDateLabel(digest.date, todayKey)}
      </span>
      <span className="shrink-0 tabular-nums text-[var(--color-ink-soft)]">{digest.total} 张</span>
      <span className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-ink-soft)]">
        {parts.map((part) => (
          <span key={part.key} className="flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${part.dot}`} />
            {part.label} {part.value}
          </span>
        ))}
      </span>
    </button>
  );
}

export function ReviewCalendar() {
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pastView, setPastView] = useState<"strip" | "grid">("strip");
  const [sessions, setSessions] = useState<SessionDigest[]>([]);
  const [selected, setSelected] = useState<{ date: string; scope: "due" | "reviewed" } | null>(null);
  const [day, setDay] = useState<DayData | null>(null);
  const [dayLoading, setDayLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    return Promise.all([
      apiFetch<CalendarData>(`/review/stats/calendar?days=${CALENDAR_PAST_GRID_SPAN}`),
      // 摘要失败（或契约异常）只收起摘要块 —— 不把整卡拖进失败态
      apiFetch<{ items: TimelineItem[] }>("/review/timeline?limit=50").catch(() => null),
    ])
      .then(([calendar, timeline]) => {
        setData(calendar);
        setSessions(timeline ? aggregateSessions(timeline.items ?? [], SESSION_DIGEST_LIMIT) : []);
      })
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
  const pastSeriesAll = buildSeries(todayKey, CALENDAR_PAST_GRID_SPAN, (i) => i - (CALENDAR_PAST_GRID_SPAN - 1),
    new Map(data.past.map((day_) => [day_.date, day_.reviewed])));
  const pastSeries = pastSeriesAll.slice(-CALENDAR_SPAN);
  const futureSeries = buildSeries(todayKey, CALENDAR_SPAN, (i) => i + 1,
    new Map(data.future.map((day_) => [day_.date, day_.due])));
  const pastTotal = pastSeries.reduce((sum, day_) => sum + day_.value, 0);
  const pastTotal12w = pastSeriesAll.reduce((sum, day_) => sum + day_.value, 0);
  const futureTotal = futureSeries.reduce((sum, day_) => sum + day_.value, 0);
  const future7d = futureSeries.slice(0, 7).reduce((sum, day_) => sum + day_.value, 0);

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title flex items-center gap-2 text-lg font-semibold text-[var(--color-ink)]">
          <CalendarDays className="h-5 w-5 text-[var(--color-accent)]" />
          复习活动
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">今天待做 {data.today.dueNow}</Badge>
          <Badge tone="warm">今天已复习 {data.today.reviewedToday}</Badge>
        </div>
      </div>

      <div className="space-y-5">
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-ink-soft)]">
            <span>
              {pastView === "strip"
                ? `过去 ${CALENDAR_SPAN} 天 · 共复习 ${pastTotal} 张（点柱子看当天复习了哪些）`
                : `近 12 周 · 共复习 ${pastTotal12w} 次（点格子看当天复习了哪些）`}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant={pastView === "strip" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={pastView === "strip"}
                onClick={() => setPastView("strip")}
              >
                <BarChart3 className="h-3.5 w-3.5" />30 天
              </Button>
              <Button
                variant={pastView === "grid" ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={pastView === "grid"}
                onClick={() => setPastView("grid")}
              >
                <Grid3x3 className="h-3.5 w-3.5" />12 周
              </Button>
            </div>
          </div>
          {pastView === "strip" ? (
            <>
              <button
                type="button"
                className="block w-full cursor-pointer text-left"
                onClick={() => openDay(todayKey, "reviewed")}
                aria-label="查看今天的复习记录"
              >
                <Strip series={pastSeries} testId="calendar-strip-past" tone="past" />
              </button>
              <div className="mt-1 flex justify-between text-xs text-[var(--color-ink-soft)]">
                <span>{shortLabel(pastSeries[0].date)}</span>
                <span>今天</span>
              </div>
            </>
          ) : (
            <PastGrid series={pastSeriesAll} onSelect={(date) => openDay(date, "reviewed")} />
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-[var(--color-ink-soft)]">
            <span>
              未来 {CALENDAR_SPAN} 天 · 共到期 {futureTotal} 张 · 未来 7 天 {future7d} 张（点柱子看那天到期哪些词）
            </span>
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

        {sessions.length > 0 && (
          <div>
            <div className="mb-2 flex items-center justify-between text-xs text-[var(--color-ink-soft)]">
              <span>最近复习会话 · 按日聚合（点一行看当天复习了哪些）</span>
              <span>近 {sessions.length} 天共 {sessions.reduce((sum, digest) => sum + digest.total, 0)} 张</span>
            </div>
            <div className="space-y-1.5">
              {sessions.map((digest) => (
                <SessionDigestRow
                  key={digest.date}
                  digest={digest}
                  todayKey={todayKey}
                  active={selected?.date === digest.date && selected.scope === "reviewed"}
                  onOpen={() => openDay(digest.date, "reviewed")}
                />
              ))}
            </div>
          </div>
        )}

        <p className="text-xs text-[var(--color-ink-soft)]">
          口径：日历日按 Asia/Shanghai；未来侧不含挂起词；今天到期数含**积压**（已过期未复习的词都算今天）；
          过去侧与会话均为 L1+L2 的评分动作（skip / 挂起等不计）。
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
