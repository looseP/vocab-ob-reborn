/**
 * 词详情 → 广场集合反链推导（E2）。
 *
 * 与后端 PlazaService 的聚合逻辑保持一致：
 * - 语义场：metadata.source_path 形如 `L1_雅思词汇/L1_雅思词汇_<场名>.md` → slug `semantic-<场名>`
 * - 词根：metadata.morphology_root 提取首个 token（同 extractRootTokens：按 `+` 拆分、
 *   每部分取括号（半/全角）前首个连续字母串小写、过滤非 [a-z]{2,} 噪声）→ slug `root-<token>`
 *
 * 说明：此处是显示徽标用的轻量推导，与后端聚合的完整逻辑（含复合词根多 token、
 * 家族规模过滤）不完全等价；词根只取首个有效 token，匹配广场词根家族。
 */

interface PlazaCollectionRef {
  slug: string;
  title: string;
}

const SEMANTIC_PREFIX = "semantic";
const ROOT_PREFIX = "root";

function metadataValue(metadata: unknown, key: string): string | null {
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>)[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  return null;
}

/** 语义场反链：从 source_path 提取场名。 */
export function deriveSemanticCollection(metadata: unknown): PlazaCollectionRef | null {
  const sourcePath = metadataValue(metadata, "source_path");
  if (!sourcePath) return null;
  const match = /^L1_雅思词汇\/L1_雅思词汇_(.+)\.md$/.exec(sourcePath);
  if (!match) return null;
  const title = match[1].trim();
  if (!title) return null;
  return { slug: `${SEMANTIC_PREFIX}-${title}`, title };
}

/** 词根反链：从 morphology_root 提取首个有效 token（与后端 extractRootTokens 一致）。 */
export function deriveRootCollection(metadata: unknown): PlazaCollectionRef | null {
  const raw = metadataValue(metadata, "morphology_root");
  if (!raw || raw === "EMPTY") return null;
  for (const part of raw.split("+")) {
    const match = /^[A-Za-z][A-Za-z'-]*/.exec(part.trim());
    if (!match) continue;
    const token = match[0].toLowerCase();
    if (token.length < 2 || !/^[a-z]{2,}$/.test(token)) continue;
    return { slug: `${ROOT_PREFIX}-${token}`, title: token };
  }
  return null;
}

/** 词详情可反链的全部集合（语义场 + 词根家族）。 */
export function deriveWordCollections(metadata: unknown): PlazaCollectionRef[] {
  const refs: PlazaCollectionRef[] = [];
  const semantic = deriveSemanticCollection(metadata);
  if (semantic) refs.push(semantic);
  const root = deriveRootCollection(metadata);
  if (root) refs.push(root);
  return refs;
}
