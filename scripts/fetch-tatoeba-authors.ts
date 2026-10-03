/**
 * 离线抓取工具（**不参与构建/门禁**）—— 从 Tatoeba 抓取句子的作者，产出
 * `data/real-usage-authors/<日期>.json` 清单，供 `backfill-real-usage-author.ts` 消费。
 *
 * ## 为什么单独拆一个工具、清单还要进仓库
 *
 * 回填脚本（`backfill-real-usage-author.ts`）**只消费清单、不在运行时联网**：
 * 联网抓取不可重放（句子可能被删、作者可能改名、网络可能抖动），而署名是
 * 许可证义务的一部分，必须留痕可复核。清单进版本库后，任何人可以逐条核对
 * 「这句的作者是谁、什么时候抓的、当时许可怎么写」，也可以离线重跑回填。
 *
 * ## 抓取口径
 *
 * 逐条 GET `https://api.tatoeba.org/unstable/sentences/<id>`（Tatoeba 官方 API，
 * 返回 `data.owner` / `data.license` / `data.text`）。选择逐条抓而不是下整份
 * CC0 导出：81 条样本量下逐条更省带宽，且能顺带核对**句子文本是否漂移**。
 *
 * - **限速**：每条之间固定间隔（默认 1200ms），串行不发并发 —— 不给上游压力。
 * - **续跑**：输出文件已存在时先读入，已抓到作者的条目直接跳过；每抓完一条
 *   立刻落盘，中途 Ctrl-C 不丢进度。重复跑最终收敛到同一份清单。
 * - **不猜**：抓不到（404 / 网络失败 / 响应缺字段 / 文本对不上）的条目在清单里
 *   标 `"author": null` 且 `"status": "missing"`，附 `reason`，**绝不填占位符**。
 * - **文本核对**：库里存的句子与 Tatoeba 当前返回的文本不一致时标 `"status": "text-mismatch"`，
 *   同样不填作者 —— 文本都对不上，那个作者就不是这句的作者。
 *
 * ## 跑法（宿主即可，不需要数据库）
 *
 *   node --experimental-strip-types scripts/fetch-tatoeba-authors.ts \
 *     --input <tsv: slug|url|license|text> --out data/real-usage-authors/2026-10-03.json
 *
 * 或 tsx：`npx tsx scripts/fetch-tatoeba-authors.ts --input ... --out ...`
 *
 * 输入 TSV 由下列 SQL 导出（库不对宿主暴露，走 docker exec）：
 *
 *   docker exec vocab-observatory-postgres-1 psql -U vocab -d vocab -t -A -F'|' -c "
 *     SELECT w.slug, ru->>'url', ru->>'license', ru->>'text'
 *     FROM words w, jsonb_array_elements(w.examples->0->'verified'->'real_usage') ru
 *     WHERE jsonb_array_length(COALESCE(w.examples->0->'verified'->'real_usage','[]'::jsonb)) > 0
 *     ORDER BY w.slug;"
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface InputRow {
  slug: string;
  url: string;
  license: string;
  text: string;
}

export interface AuthorEntry {
  slug: string;
  sentence_url: string;
  /** Tatoeba 用户名（`data.owner`）。抓不到时为 null —— 不填占位符。 */
  author: string | null;
  /** 句子页声明的许可（以抓取时 Tatoeba 返回为准）。 */
  license: string | null;
  /** 抓取时间（ISO 8601，UTC）。 */
  fetched_at: string | null;
  /** `ok` = 作者已拿到；其余为未补齐，附 reason。 */
  status: "ok" | "missing" | "text-mismatch";
  /** 未补齐原因（status != ok 时必有）。 */
  reason?: string;
}

export interface AuthorManifest {
  $comment: string;
  meta: {
    version: number;
    measuredAt: string;
    source: string;
    method: string;
    fetched: number;
    missing: number;
  };
  entries: AuthorEntry[];
}

export const API_BASE = "https://api.tatoeba.org/unstable/sentences/";
export const SENTENCE_ID_RE = /\/sentences\/show\/(\d+)/;

/** 从句子页 URL 里取数字 id；取不到返回 null（清单里标 missing，不猜）。 */
export function sentenceIdFromUrl(url: string): string | null {
  const m = SENTENCE_ID_RE.exec(url);
  return m ? m[1] : null;
}

/** 解析 TSV 输入（`slug|url|license|text`，文本里可能含 `|`，故只切前三刀）。 */
export function parseInput(tsv: string): InputRow[] {
  const rows: InputRow[] = [];
  for (const line of tsv.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const [slug, url, license] = parts;
    const text = parts.slice(3).join("|");
    rows.push({ slug: slug.trim(), url: url.trim(), license: license.trim(), text: text.trim() });
  }
  return rows;
}

/** 从 API 响应里抽 `data.owner` / `data.license` / `data.text`；形状不符返回 null。 */
export function parseApiResponse(raw: unknown): { owner: string | null; license: string | null; text: string | null } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = (raw as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const owner = typeof d.owner === "string" && d.owner.trim() !== "" ? d.owner.trim() : null;
  const license = typeof d.license === "string" && d.license.trim() !== "" ? d.license.trim() : null;
  const text = typeof d.text === "string" ? d.text.trim() : null;
  return { owner, license, text };
}

/**
 * 归一化比较句子文本：库里存的与 Tatoeba 返回的都要是同一句。
 * 容忍首尾空白与弯/直引号差异，不容忍词句差异。
 */
export function sameSentence(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchOne(id: string, retries: number): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  let lastReason = "unknown";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(`${API_BASE}${id}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 404) return { ok: false, reason: "http-404" };
      if (!res.ok) {
        lastReason = `http-${res.status}`;
      } else {
        return { ok: true, body: await res.json() };
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    if (attempt < retries) await sleep(1500 * (attempt + 1));
  }
  return { ok: false, reason: lastReason };
}

async function loadExisting(outPath: string): Promise<Map<string, AuthorEntry>> {
  try {
    const raw = JSON.parse(await readFile(outPath, "utf8")) as AuthorManifest;
    return new Map((raw.entries ?? []).map((e) => [e.slug, e]));
  } catch {
    return new Map();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const argOf = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const inputPath = argOf("--input");
  const outPath = argOf("--out");
  const intervalMs = Number(argOf("--interval-ms") ?? "1200");
  const retries = Number(argOf("--retries") ?? "3");
  const limitRaw = argOf("--limit");
  const limit = limitRaw ? Number(limitRaw) : Number.POSITIVE_INFINITY;
  if (!inputPath || !outPath) {
    throw new Error("用法：fetch-tatoeba-authors.ts --input <tsv> --out <json> [--interval-ms 1200] [--retries 3] [--limit N]");
  }

  const rows = parseInput(await readFile(inputPath, "utf8"));
  const previous = await loadExisting(outPath);
  const results = new Map<string, AuthorEntry>();
  const startedAt = new Date().toISOString();

  let fetchedNow = 0;
  for (const row of rows) {
    if (fetchedNow >= limit) break;
    const prior = previous.get(row.slug);
    if (prior && prior.status === "ok" && prior.author) {
      results.set(row.slug, prior);
      continue;
    }
    const id = sentenceIdFromUrl(row.url);
    if (id === null) {
      results.set(row.slug, {
        slug: row.slug,
        sentence_url: row.url,
        author: null,
        license: row.license,
        fetched_at: null,
        status: "missing",
        reason: "url 里没有句子 id",
      });
      continue;
    }
    const res = await fetchOne(id, retries);
    if (!res.ok) {
      results.set(row.slug, {
        slug: row.slug,
        sentence_url: row.url,
        author: null,
        license: row.license,
        fetched_at: new Date().toISOString(),
        status: "missing",
        reason: res.reason,
      });
    } else {
      const parsed = parseApiResponse(res.body);
      if (parsed === null) {
        results.set(row.slug, {
          slug: row.slug,
          sentence_url: row.url,
          author: null,
          license: row.license,
          fetched_at: new Date().toISOString(),
          status: "missing",
          reason: "响应形状不符（缺 data）",
        });
      } else if (parsed.text !== null && !sameSentence(parsed.text, row.text)) {
        results.set(row.slug, {
          slug: row.slug,
          sentence_url: row.url,
          author: null,
          license: parsed.license ?? row.license,
          fetched_at: new Date().toISOString(),
          status: "text-mismatch",
          reason: `库内文本与 Tatoeba 不一致：库「${row.text}」/ Tatoeba「${parsed.text}」`,
        });
      } else if (parsed.owner === null) {
        results.set(row.slug, {
          slug: row.slug,
          sentence_url: row.url,
          author: null,
          license: parsed.license ?? row.license,
          fetched_at: new Date().toISOString(),
          status: "missing",
          reason: "Tatoeba 未提供 owner（匿名/已注销）",
        });
      } else {
        results.set(row.slug, {
          slug: row.slug,
          sentence_url: row.url,
          author: parsed.owner,
          license: parsed.license ?? row.license,
          fetched_at: new Date().toISOString(),
          status: "ok",
        });
      }
    }
    fetchedNow += 1;
    // 每条落盘 —— 中断可续，且清单始终是「抓到现在」的真实状态。
    await writeManifest(outPath, rows, results, startedAt);
    process.stdout.write(`  ${row.slug.padEnd(20)} ${results.get(row.slug)?.author ?? "(缺)"}\n`);
    await sleep(intervalMs);
  }

  await writeManifest(outPath, rows, results, startedAt);
  const all = rows.map((r) => results.get(r.slug)).filter((e): e is AuthorEntry => e !== undefined);
  const ok = all.filter((e) => e.status === "ok").length;
  console.log(`\n抓到 ${ok} / ${rows.length}，缺 ${all.length - ok}。清单：${outPath}`);
}

async function writeManifest(
  outPath: string,
  rows: InputRow[],
  results: Map<string, AuthorEntry>,
  startedAt: string,
): Promise<void> {
  const entries = rows.map((r) => results.get(r.slug)).filter((e): e is AuthorEntry => e !== undefined);
  const ok = entries.filter((e) => e.status === "ok").length;
  const manifest: AuthorManifest = {
    $comment:
      "words.examples[0].verified.real_usage[*].author 回填清单。author 取自 Tatoeba 官方 API 的 data.owner；" +
      "status != ok 的条目一律 author=null（不猜），由 backfill-real-usage-author.ts 跳过并在报告里列出。",
    meta: {
      version: 1,
      measuredAt: startedAt.slice(0, 10),
      source: "https://api.tatoeba.org/unstable/sentences/<id>",
      method:
        "逐条 GET（串行，条间固定间隔），核对返回文本与库内文本一致后取 data.owner；不一致标 text-mismatch 不取作者。",
      fetched: ok,
      missing: entries.length - ok,
    },
    entries,
  };
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]).replace(/\.(ts|js)$/, "") === fileURLToPath(import.meta.url).replace(/\.(ts|js)$/, "");
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
