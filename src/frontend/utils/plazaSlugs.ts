/**
 * 词详情 → 广场集合反链推导（E2）。
 *
 * 与后端 PlazaService 的聚合逻辑保持一致：
 * - 语义场：metadata.source_path 形如 `L1_雅思词汇/L1_雅思词汇_<场名>.md` → slug `semantic-<场名>`
 * - 词根：metadata.morphology_root 提取 token（同后端 extractRootTokens：按 `+` 拆分、
 *   每部分取括号（半/全角）前首个连续字母串小写、过滤非 [a-z]{2,} 噪声）→ slug `root-<token>`
 *
 * B4-1 增强：多词根词（如 `air + condition`）现在反链到**全部**所属词根家族，
 * 而非只取首个 token——与后端 findByRootToken 的 EXISTS 语义一致，保证词详情
 * 展示的家族徽标与广场家族聚合完全对应。
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

/** 提取 morphology_root 的全部有效词根 token（与后端 PlazaService.extractRootTokens 一致）。 */
export function extractRootTokens(morphologyRoot: string | null | undefined): string[] {
  if (!morphologyRoot || morphologyRoot === "EMPTY") return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of morphologyRoot.split("+")) {
    const match = /^[A-Za-z][A-Za-z'-]*/.exec(part.trim());
    if (!match) continue;
    const token = match[0].toLowerCase();
    if (token.length < 2 || !/^[a-z]{2,}$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
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

/** 词根反链（兼容旧签名）：取首个有效 token（无 token 时返回 null）。 */
export function deriveRootCollection(metadata: unknown): PlazaCollectionRef | null {
  const tokens = extractRootTokens(metadataValue(metadata, "morphology_root"));
  if (tokens.length === 0) return null;
  return { slug: `${ROOT_PREFIX}-${tokens[0]}`, title: tokens[0] };
}

/** 词根反链（B4-1）：返回全部有效 token 的家族引用（多词根词显示所有所属家族）。 */
export function deriveRootCollections(metadata: unknown): PlazaCollectionRef[] {
  const tokens = extractRootTokens(metadataValue(metadata, "morphology_root"));
  return tokens.map((token) => ({ slug: `${ROOT_PREFIX}-${token}`, title: token }));
}

/** 词详情可反链的全部集合（语义场 + 全部词根家族）。 */
export function deriveWordCollections(metadata: unknown): PlazaCollectionRef[] {
  const refs: PlazaCollectionRef[] = [];
  const semantic = deriveSemanticCollection(metadata);
  if (semantic) refs.push(semantic);
  refs.push(...deriveRootCollections(metadata));
  return refs;
}
