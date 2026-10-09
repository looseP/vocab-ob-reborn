import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Spinner } from "@/frontend/components/ui/Spinner";
import { apiFetch } from "@/frontend/api/client";
import { extractRootTokens } from "@/frontend/utils/plazaSlugs";
import { familyStatus } from "./RootMasteryMatrix";

interface NeighborFamily {
  token: string;
  slug: string;
  total: number;
  mastered: number;
  learning: number;
  meaning: string | null;
}

interface GraphProps {
  /** 当前家族 token（中心节点）。 */
  currentToken: string;
  /** 同族变体（0052 词典；虚线边）。 */
  variants: string[];
  /** 家族词的 morphology_root 原始串（提取共享复合 token，实线边）。 */
  wordRoots: Array<string | null>;
}

const SIZE = 380;
const CENTER = SIZE / 2;
const NEIGHBOR_RADIUS = 128;
const CENTER_R = 34;
const NODE_R = 22;
const MAX_SHARED = 8;

/**
 * P2-3 词族邻域图谱（纯 SVG，无新依赖）：中心 = 当前家族；
 * 邻居 = 变体（虚线）+ 共享复合 token（实线，按出现频次取 top）。
 * 节点颜色 = 家族掌握档（复用矩阵端点着色口径），中心圆环 = 已掌握比例。
 */
export function RootNeighborhoodGraph({ currentToken, variants, wordRoots }: GraphProps) {
  const navigate = useNavigate();
  const [families, setFamilies] = useState<Map<string, NeighborFamily> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 共享邻居：词的词根 token 中除自身外按频次排序取 top
  const sharedNeighbors = useMemo(() => {
    const counts = new Map<string, number>();
    for (const raw of wordRoots) {
      if (!raw) continue;
      for (const token of extractRootTokens(raw)) {
        if (token === currentToken) continue;
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([token]) => token)
      .slice(0, MAX_SHARED);
  }, [currentToken, wordRoots]);

  const variantSet = useMemo(() => new Set(variants), [variants]);
  const neighborTokens = useMemo(
    () => [...variants, ...sharedNeighbors.filter((token) => !variantSet.has(token))],
    [variants, sharedNeighbors, variantSet],
  );

  const tokensKey = [currentToken, ...neighborTokens].join(",");

  useEffect(() => {
    if (neighborTokens.length === 0) {
      setFamilies(new Map());
      return;
    }
    const controller = new AbortController();
    setFamilies(null);
    setError(null);
    const params = new URLSearchParams({ tokens: tokensKey });
    apiFetch<{ families: NeighborFamily[] }>(`/api/plaza/roots/mastery-matrix?${params.toString()}`, {
      signal: controller.signal,
    })
      .then((res) => setFamilies(new Map(res.families.map((family) => [family.token, family]))))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "加载词族图谱失败");
      });
    return () => controller.abort();
    // tokensKey 已涵盖 currentToken/neighborTokens 的全部信息
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokensKey]);

  const nodes = useMemo(
    () =>
      neighborTokens.map((token, index) => {
        const angle = (2 * Math.PI * index) / Math.max(neighborTokens.length, 1) - Math.PI / 2;
        return {
          token,
          family: families?.get(token),
          x: CENTER + NEIGHBOR_RADIUS * Math.cos(angle),
          y: CENTER + NEIGHBOR_RADIUS * Math.sin(angle),
          isVariant: variantSet.has(token),
        };
      }),
    [neighborTokens, families, variantSet],
  );

  if (error) {
    return <p className="text-xs text-[var(--color-accent-2)]">{error}</p>;
  }
  if (!families) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-xs text-[var(--color-ink-soft)]">
        <Spinner />
        渲染词族图谱...
      </div>
    );
  }

  const center = families.get(currentToken);
  const circumference = 2 * Math.PI * CENTER_R;
  const centerMasteredPct = center && center.total > 0 ? Math.min(1, center.mastered / center.total) : 0;

  const fillFor = (family: NeighborFamily | undefined) => {
    const status = family ? familyStatus(family) : "fresh";
    if (status === "mastered") return "var(--color-accent-soft)";
    if (status === "learning") return "rgba(243, 220, 162, 0.45)";
    return "var(--color-surface-muted)";
  };

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="mx-auto block max-w-md"
      role="img"
      aria-label={`词根家族 ${currentToken} 的邻域图谱`}
    >
      {nodes.map((node) => (
        <line
          key={`edge-${node.token}`}
          x1={CENTER}
          y1={CENTER}
          x2={node.x}
          y2={node.y}
          stroke={node.isVariant ? "var(--color-accent)" : "var(--color-border-strong)"}
          strokeWidth={node.isVariant ? 1.6 : 1.1}
          strokeDasharray={node.isVariant ? "4 3" : undefined}
          opacity={0.7}
        />
      ))}

      <circle
        cx={CENTER}
        cy={CENTER}
        r={CENTER_R}
        fill="var(--color-panel-strong)"
        stroke="var(--color-border-strong)"
        strokeWidth={1.4}
      />
      <circle
        cx={CENTER}
        cy={CENTER}
        r={CENTER_R}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={3.2}
        strokeDasharray={`${circumference * centerMasteredPct} ${circumference}`}
        transform={`rotate(-90 ${CENTER} ${CENTER})`}
      />
      <text x={CENTER} y={CENTER - 1} textAnchor="middle" fontSize={13} fontWeight={700} fill="var(--color-ink)">
        -{currentToken}-
      </text>
      <text x={CENTER} y={CENTER + 14} textAnchor="middle" fontSize={10} fill="var(--color-ink-soft)">
        {center ? `已掌握 ${center.mastered}/${center.total}` : "…"}
      </text>

      {nodes.map((node) => {
        const status = node.family ? familyStatus(node.family) : "fresh";
        const untrained = node.family
          ? Math.max(0, node.family.total - node.family.mastered - node.family.learning)
          : 0;
        const tooltip =
          `-${node.token}-${node.isVariant ? "（同族变体）" : ""}` +
          (node.family
            ? ` · 已掌握 ${node.family.mastered} · 学习中 ${node.family.learning} · 未学 ${untrained}` +
              (node.family.meaning ? ` · ${node.family.meaning}` : "")
            : " · 词库未收录该家族");
        return (
          <g
            key={node.token}
            onClick={() => navigate(`/plaza/${encodeURIComponent(`root-${node.token}`)}`)}
            style={{ cursor: "pointer" }}
            role="link"
            aria-label={`词根家族 ${node.token}`}
          >
            <title>{tooltip}</title>
            <circle
              cx={node.x}
              cy={node.y}
              r={NODE_R}
              fill={fillFor(node.family)}
              stroke={node.isVariant ? "var(--color-accent)" : "var(--color-border-strong)"}
              strokeWidth={1.4}
              opacity={node.family ? 0.95 : 0.45}
            />
            <text
              x={node.x}
              y={node.y + 3.5}
              textAnchor="middle"
              fontSize={node.token.length > 6 ? 8.5 : 10}
              fontWeight={600}
              fill="var(--color-ink)"
            >
              {node.token}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
