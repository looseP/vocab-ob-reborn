/**
 * 生长趋势（B2 体验层）：累计圈词曲线——"看到自己的知识网络在长大"。
 *
 * 手绘 SVG、零图表库依赖（Non-goal：不引重依赖）。静态渲染，不做入场动画
 * （基线 §6：动效只承担引导+反馈，此处信息本身即反馈）。配色只用既有 token；
 * 软面积底用已定义的 --color-surface-muted（避开未定义的 --color-accent-soft，
 * 见走查 G-P0-1）。
 */
import type { GrowthSeriesPoint } from "@/frontend/viewModels/l3UniverseViewModel";
import { formatUniverseCount } from "@/frontend/viewModels/l3UniverseViewModel";

const W = 600;
const H = 150;
const PAD = { top: 16, right: 12, bottom: 24, left: 12 };

export function L3GrowthChart({ series, label }: { series: GrowthSeriesPoint[]; label: string }) {
  if (series.length < 2) return null;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const max = Math.max(...series.map((point) => point.cumulative), 1);
  const x = (index: number) => PAD.left + (index / (series.length - 1)) * innerW;
  const y = (value: number) => PAD.top + innerH - (value / max) * innerH;

  const linePath = series
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.cumulative).toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L${x(series.length - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${PAD.left},${(PAD.top + innerH).toFixed(1)} Z`;

  const first = series[0];
  const last = series[series.length - 1];
  const shortDay = (day: string) => day.slice(5); // MM-DD

  return (
    <figure className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
      <figcaption className="mb-1 flex items-baseline justify-between">
        <span className="text-[12px] font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">{label}</span>
        <span className="text-[11px] text-[var(--color-ink-soft)]">
          {formatUniverseCount(first.cumulative)} → <strong className="text-[13px] text-[var(--color-accent)]">{formatUniverseCount(last.cumulative)}</strong>
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label={`${label}：${shortDay(first.day)} 至 ${shortDay(last.day)}，累计 ${formatUniverseCount(last.cumulative)}`}>
        <path d={areaPath} fill="var(--color-surface-muted)" stroke="none" />
        <path d={linePath} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(series.length - 1).toFixed(1)} cy={y(last.cumulative).toFixed(1)} r="3.5" fill="var(--color-accent)" />
        <text x={PAD.left} y={H - 6} fontSize="10" fill="var(--color-ink-soft)">{shortDay(first.day)}</text>
        <text x={W - PAD.right} y={H - 6} fontSize="10" fill="var(--color-ink-soft)" textAnchor="end">{shortDay(last.day)}（今天）</text>
        <text x={W - PAD.right} y={PAD.top - 4} fontSize="10" fill="var(--color-ink-soft)" textAnchor="end">峰值 {formatUniverseCount(max)}</text>
      </svg>
    </figure>
  );
}
