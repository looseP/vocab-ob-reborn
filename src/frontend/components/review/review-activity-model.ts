/**
 * 复习活动卡的纯逻辑（批次 2，2026-10-09）。
 *
 * 三合一后，「条带（30 天）」「格网（12 周）」「最近会话（按日聚合）」共用同一份
 * review_logs 数据，各自在渲染层组装。这里放不依赖 React 的计算，便于单测直锁：
 * 显示时区日键、会话聚合、周对齐格网。
 */

/** 显示时区(Asia/Shanghai)日键 —— 与后端 heatmap / 日历分桶口径一致。 */
export function dayKeyInDisplayTz(date: Date): string {
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

/** 会话聚合的最小输入（timeline 契约的子集）。 */
export interface SessionSourceItem {
  rating: string;
  created_at: string;
}

export interface SessionDigest {
  /** 显示时区日历日（YYYY-MM-DD）。 */
  date: string;
  /** 该日评分动作总数（与后端 timeline 过滤口径一致：rating 非空）。 */
  total: number;
  /** 评分分布；未知评分只计入 total，不进分布。 */
  byRating: { again: number; hard: number; good: number; easy: number };
}

/**
 * 把复习流水按显示时区日历日聚合，日期降序取前 `limit` 天。
 *
 * 摘要只回答「每天复习了多少、都是什么评级」——不列单词（列词是日历
 * 点某天的职责，避免第二份列词实现再次堆长页面）。
 */
export function aggregateSessions(items: SessionSourceItem[], limit: number): SessionDigest[] {
  const byDay = new Map<string, SessionDigest>();
  for (const item of items) {
    const day = dayKeyInDisplayTz(new Date(item.created_at));
    let digest = byDay.get(day);
    if (!digest) {
      digest = { date: day, total: 0, byRating: { again: 0, hard: 0, good: 0, easy: 0 } };
      byDay.set(day, digest);
    }
    digest.total += 1;
    if (item.rating === "again" || item.rating === "hard" || item.rating === "good" || item.rating === "easy") {
      digest.byRating[item.rating] += 1;
    }
  }
  return [...byDay.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

/** 格网单元；`date === null` 是对齐空位，不是「0 次复习」的格子（两者含义不同）。 */
export interface GridCell {
  date: string | null;
  value: number;
}

/**
 * 把连续日序列摆成「列 = 周、行 = 周一..周日」的格网。
 *
 * 首列按首日星期几补空位、末列补齐到整周。不做月份/星期文字标签（批次 3 的
 * 视觉规范再定），但行列语义必须正确 —— 否则「哪周」读不出来。
 */
export function buildGridWeeks(series: Array<{ date: string; value: number }>): GridCell[][] {
  if (series.length === 0) return [];
  const [year, month, day] = series[0].date.split("-").map(Number);
  const leading = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7; // 周一=0
  const cells: GridCell[] = [
    ...Array.from({ length: leading }, () => ({ date: null, value: 0 })),
    ...series.map((entry) => ({ date: entry.date, value: entry.value })),
  ];
  while (cells.length % 7 !== 0) cells.push({ date: null, value: 0 });
  const weeks: GridCell[][] = [];
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
  return weeks;
}

/** 格网色阶分档数（批次 3 视觉规范）：0 = 无活动，1..4 由浅到深。 */
export const HEAT_LEVELS = 4;

/**
 * 把「当日次数 / 窗口最大次数」映射到 1..4 档（0 次恒为 0 档）。
 *
 * 分档而非连续透明度：12px 的格子上 0.62 与 0.68 人眼分辨不出，分档后
 * 图例才有意义（少 ▢▢▢▢ 多），也让"这格比那格深"是可复述的判断。
 */
export function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (max <= 1) return 4; // 窗口内只有一次活动：相对口径下即最深档
  const ratio = value / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

/** 各档透明度（索引 = heatLevel 返回值）。 */
export const HEAT_LEVEL_OPACITY = [0.15, 0.35, 0.55, 0.75, 1] as const;

export interface MonthLabel {
  /** 该月第一个覆盖到的列索引（列 = 周）。 */
  column: number;
  label: string;
}

/**
 * 从格网列里提取月份标签：一列（一周）内取**首个非空日期**的月份，
 * 月份变化处出一个标签（同月只标首次出现，GitHub 同款稀疏标注）。
 */
export function buildMonthLabels(weeks: GridCell[][]): MonthLabel[] {
  const labels: MonthLabel[] = [];
  let lastMonth = "";
  weeks.forEach((week, column) => {
    const first = week.find((cell) => cell.date !== null);
    if (!first?.date) return;
    const month = first.date.slice(5, 7);
    if (month !== lastMonth) {
      labels.push({ column, label: `${Number(month)}月` });
      lastMonth = month;
    }
  });
  return labels;
}
