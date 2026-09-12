/**
 * 素材宇宙（B1 体验层）视图模型：纯函数、零出向（与 l3GraphViewModel 同款约束）。
 *
 * 只负责"把 L3 读面数据整理成首页要展示的形状"，不触网络、不触计时器——
 * 便于在 node 环境直测（前端文件不受分层覆盖率治理，但纪律上仍需真实测试）。
 */
import type { L3OccurrenceListItem } from "@/domain";

/** 计数卡数值：千分位（数字随积累变大，保持一眼可读）。 */
export function formatUniverseCount(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  return safe.toLocaleString("en-US");
}

export interface UniverseCaptureGroup {
  contextId: string;
  createdAt: string;
  /** 该句绑定的词 slug（去重、保持出现顺序）。 */
  words: string[];
  /** 句子预览（空白折叠 + 截断）。 */
  excerpt: string;
  sourceId: string;
  sourceTitle: string;
}

const EXCERPT_MAX = 120;

/** 圈记预览：折叠空白，超出截断加省略号。 */
export function trimUniverseExcerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > EXCERPT_MAX ? `${collapsed.slice(0, EXCERPT_MAX)}…` : collapsed;
}

/**
 * occurrences（服务端按 created_at DESC）→ 最近圈记分组。
 *
 * 一句可能圈多个词（同 context_id 多条 occurrence）——合并为一行
 * 「句子 + 词 chips」，避免同一句在首页重复出现。输入已按时间倒序，
 * 因此取满 maxGroups 个不同语境即可停止。
 */
export function buildRecentCaptureGroups(
  items: readonly L3OccurrenceListItem[],
  maxGroups = 5,
): UniverseCaptureGroup[] {
  const groups = new Map<string, UniverseCaptureGroup>();
  for (const item of items) {
    const contextId = item.context?.id;
    if (!contextId) continue;
    const slug = item.word?.slug ?? null;
    const existing = groups.get(contextId);
    if (existing) {
      if (slug && !existing.words.includes(slug)) existing.words.push(slug);
      continue;
    }
    groups.set(contextId, {
      contextId,
      createdAt: item.occurrence?.created_at ?? item.context?.created_at ?? "",
      words: slug ? [slug] : [],
      excerpt: trimUniverseExcerpt(item.context?.text ?? ""),
      sourceId: item.source?.id ?? "",
      sourceTitle: item.source?.title ?? "",
    });
    if (groups.size >= maxGroups) break;
  }
  return [...groups.values()];
}

/** 素材宇宙是否处于"还没开始积累"的空态（判断依据：素材数）。 */
export function isUniverseEmpty(counts: { sourceCount: number } | null): boolean {
  return counts === null || counts.sourceCount === 0;
}

/** 相对时间（中文短格式）——用于「最近导入 / 最近圈记」的时间戳。 */
export function formatUniverseWhen(iso: string, now: Date = new Date()): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  const diffMs = now.getTime() - parsed;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

// ── B2 生长趋势（生长感可视化：累计曲线，形态定稿见基线 §6） ────────────────

export interface GrowthSeriesPoint {
  /** YYYY-MM-DD（展示端本地时区的自然日）。 */
  day: string;
  /** 当日新增（窗口内无新增的日子为 0）。 */
  daily: number;
  /** 截至当日的累计量（起点 = 窗口前存量）。 */
  cumulative: number;
}

/** 本地时区的 YYYY-MM-DD 日键（与后端 Asia/Shanghai 切日在展示上对齐）。 */
function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 稀疏的每日新增（服务端 Asia/Shanghai 切日）→ 连续窗口的累计序列。
 *
 * - 起点 = currentTotal − 窗口内新增合计（clamp 0，容忍数据边界不一致）；
 * - 末点累计 == currentTotal（口径自洽，图上最后一个点就是计数卡数字）。
 */
export function buildGrowthSeries(
  byDay: ReadonlyArray<{ day: string; occurrenceCount: number }>,
  windowDays: number,
  currentTotal: number,
  now: Date = new Date(),
): GrowthSeriesPoint[] {
  const days = Math.max(2, Math.trunc(windowDays));
  const dailyByDay = new Map<string, number>();
  let windowTotal = 0;
  for (const entry of byDay) {
    const daily = Number.isFinite(entry.occurrenceCount) ? Math.max(0, Math.trunc(entry.occurrenceCount)) : 0;
    dailyByDay.set(entry.day, daily);
    windowTotal += daily;
  }
  const baseTotal = Math.max(0, Math.trunc(currentTotal) - windowTotal);

  const points: GrowthSeriesPoint[] = [];
  let cumulative = baseTotal;
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    const day = localDayKey(date);
    const daily = dailyByDay.get(day) ?? 0;
    cumulative += daily;
    points.push({ day, daily, cumulative });
  }
  return points;
}
