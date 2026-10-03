/**
 * 离线回填脚本 —— 给 `words.examples[0].verified.real_usage[*]` 补上 `author`（作者署名）。
 *
 * 用法：npm run db:script:backfill-real-usage-author [-- --dry-run]
 *
 * ## 为什么需要它
 *
 * `real_usage` 是「真实语料佐证」块：每条指向一句从 Tatoeba 引入的真实句子，
 * 用来给教学构造句提供语料背书。其中 **79 条标 CC BY 2.0 FR**，而 CC BY 2.0 FR
 * §4.2 明文要求再分发者 "conveying the name (or pseudonym if applicable) of the
 * Original Author if supplied" —— 我们已经在分发这些句子（复习卡卡背 + 词条详情页
 * 都会渲染），但**库里根本没有 author 字段**，前端也就无从显示。
 *
 * 实测（**2026-10-03，时点须写清**）：
 *   81 条 real_usage 分布于 81 个词（每词 1 条），字段只有
 *   has_official_zh / license / note / source / source_type / text / url
 *   —— `author` 键 **0 条存在**。
 *   许可分布：CC BY 2.0 FR = 79 条（有署名义务），CC0 1.0 = 2 条（公有领域奉献，无义务）。
 *
 * 所以这是**实打实的合规缺口**，不是锦上添花：句子在分发，作者名没给。
 *
 * ## 范围（刻意保守）
 *
 * 本脚本**不联网、不抓取**，只消费一份显式清单
 * `data/real-usage-authors/<日期>.json`。清单由 `scripts/fetch-tatoeba-authors.ts`
 * 从 Tatoeba 官方 API 逐条抓取（串行 + 条间固定间隔 + 每抓一条落盘可续跑），
 * 抓取时**核对返回文本与库内文本一致**才取作者：文本都对不上，那个作者就不是
 * 这句的作者。清单进版本库 → 可人工复核、可离线重放。
 *
 * 抓不到作者的条目在清单里是 `"author": null` + `"status": "missing"`，
 * 本脚本**跳过并单独报告**，绝不填占位符。
 *
 * ## 跑法 —— 必须用 batch-import 角色，不能用应用角色
 *
 * 数据库不对宿主暴露，要**在栈内跑**（`postgres:5432` 才解析得到）。镜像里
 * 没有新脚本与 `data/`，所以要挂载：
 *
 *   docker compose run --rm -v "<repo>/data:/app/data:ro" \
 *     -v "<repo>/scripts:/app/scripts:ro" \
 *     -e NODE_ENV=development -e DB_SSLMODE=disable \
 *     -e BATCH_IMPORT_DATABASE_URL='postgresql://vocab_batch_import:...@postgres:5432/vocab' \
 *     web npx tsx scripts/backfill-real-usage-author.ts [--dry-run]
 *
 * **为什么必须是 `BATCH_IMPORT_DATABASE_URL` 而不是 `DATABASE_URL`**：
 * 迁移 0025 给 `vocab_app` 建的 UPDATE policy 是
 * `USING (definition_md = '' AND is_published AND NOT is_deleted)` —— 只允许改
 * stub 行。而本脚本要改的 81 个词全都有真实释义（非 stub），于是 UPDATE 命中
 * 0 行且不报错：Postgres 把它当「行对当前角色不可见」，rowCount = 0，
 * 脚本若不查 rowCount 就会一路报「写入成功」。
 * 实测两个角色的 policy 差异：
 *   vocab_app           words_stub_update_app      USING (definition_md = '')
 *   vocab_batch_import  vocab_batch_import_update  USING (true)
 *
 * 换角色后 `rowCount = 0` 就真的是异常，本脚本会据此报错并回滚。
 *
 * ## 幂等
 *
 * 逐条比对：该 `real_usage` 条目的 `author` 已等于清单值 → 跳过（不算已改）。
 * 整个回填在**单个事务**里执行：任何一条 slug 缺失、URL 对不上、或 UPDATE
 * 命中 0 行，都整体回滚，不留半截数据。重复执行第二次必然是 0 改动。
 *
 * ## 安全性
 *
 * - 只写 `examples[0].verified.real_usage[i].author` 一个键，用 `jsonb_set` 定点写入，
 *   **不动** text / license / url / note / source / source_type，也不碰主句
 *   （`examples[0].text`）、exam 三层、`verified.checked`、`assertions_avoided`。
 * - 写入前逐条核对 `url` 与清单 `sentence_url` 一致 —— 防止清单与库不同步时
 *   把 A 句的作者写到 B 句上（这是本脚本最怕的错误类型：静默的错署名）。
 * - `examples` **不参与 content_hash**（`src/db/content-hash.ts`：L1 = definition_md +
 *   core_definitions + prototype_text + morphology + mnemonic + semantic_chain；
 *   L2 = collocations + corpus_items + synonym_items + antonym_items），
 *   所以补署名不会造成哈希漂移，不会让任何 L1 复习卡被判「内容已变」而失效。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBatchImportPool } from "../src/db/connection";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = path.join(
  here,
  "..",
  "data",
  "real-usage-authors",
  "2026-10-03.json",
);

export interface ManifestEntry {
  slug: string;
  sentence_url: string;
  author: string | null;
  license: string | null;
  fetched_at: string | null;
  status: string;
  reason?: string;
}

export interface Manifest {
  meta?: Record<string, unknown>;
  entries: ManifestEntry[];
}

/** 库中一个词的 real_usage 现状（只取本脚本要用的两个字段）。 */
export interface ExistingRealUsage {
  slug: string;
  /** 每条 real_usage 的 `url` 与当前 `author`（无该键则 null）。 */
  items: Array<{ url: string | null; author: string | null }>;
}

export type PlanAction = "set-author" | "already-present" | "skip-no-author";

export interface PlanEntry {
  slug: string;
  sentenceUrl: string;
  license: string | null;
  author: string | null;
  /** 库中该条目当前 author（无 → null）。 */
  currentAuthor: string | null;
  action: PlanAction;
}

export interface Plan {
  entries: PlanEntry[];
  updates: PlanEntry[];
  alreadyPresent: PlanEntry[];
  /** 清单里 author 为 null（抓不到）的条目 —— 跳过并报告，不算失败。 */
  skippedNoAuthor: PlanEntry[];
  /** 清单 slug 在库中不存在 —— 非空即应整体拒绝执行。 */
  missingSlugs: string[];
  /** 清单 sentence_url 在该词的 real_usage 里找不到 —— 非空即应整体拒绝执行。 */
  unmatchedUrls: string[];
  /** 清单自身的形式级问题。 */
  invalidEntries: string[];
  /** CC BY 2.0 FR 条目的补齐情况（用于「补到 N / 79」报告）。 */
  ccBy: { total: number; resolved: number; missing: number };
}

/** 清单自身校验：与库无关，纯粹是「这份数据站不站得住」。 */
export function validateManifest(manifest: Manifest): string[] {
  const problems: string[] = [];
  if (!Array.isArray(manifest?.entries) || manifest.entries.length === 0) {
    return ["清单 entries 为空"];
  }
  const seenSlugs = new Set<string>();
  for (const [i, e] of manifest.entries.entries()) {
    const at = `entries[${i}]`;
    if (!e || typeof e.slug !== "string" || typeof e.sentence_url !== "string") {
      problems.push(`${at} 缺少 slug/sentence_url 字符串字段`);
      continue;
    }
    const slug = e.slug.trim();
    if (!slug) problems.push(`${at} slug 为空`);
    if (!e.sentence_url.trim()) problems.push(`${at} sentence_url 为空`);
    if (e.author !== null && (typeof e.author !== "string" || e.author.trim() === "")) {
      problems.push(`${at} author 既不是非空字符串也不是 null（slug=${slug}）`);
    }
    // 抓到了作者就必须有抓取时间与许可 —— 否则无从复核「这是哪次抓的」。
    if (typeof e.author === "string" && e.author.trim() !== "" && !e.fetched_at) {
      problems.push(`${at} 有 author 但缺 fetched_at（slug=${slug}）`);
    }
    if (typeof e.author === "string" && e.author.trim() !== "" && !e.license) {
      problems.push(`${at} 有 author 但缺 license（slug=${slug}）`);
    }
    if (seenSlugs.has(slug)) problems.push(`${at} slug 重复：${slug}`);
    seenSlugs.add(slug);
  }
  return problems;
}

const CC_BY_FR = "CC BY 2.0 FR";

/**
 * 把清单 + 库现状算成一份执行计划。**纯函数**，不碰数据库，所以单测能直接覆盖。
 *
 * 三路分流：
 * - `author` 非空且与库中现值不同 → `set-author`（要写）
 * - `author` 非空且与库中现值相同 → `already-present`（幂等跳过）
 * - `author` 为空（抓不到）→ `skip-no-author`（跳过并报告，不写 null）
 *
 * 另外两路是**硬错误**（非空即整体拒绝执行）：slug 不在库中、sentence_url
 * 在该词的 real_usage 里对不上。
 */
export function planAuthorBackfill(manifest: Manifest, rows: ExistingRealUsage[]): Plan {
  const invalidEntries = validateManifest(manifest);
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  const entries: PlanEntry[] = [];
  const missingSlugs = new Set<string>();
  const unmatchedUrls = new Set<string>();

  for (const e of manifest.entries) {
    const slug = e.slug?.trim();
    const url = e.sentence_url?.trim();
    if (!slug || !url) continue;

    const row = bySlug.get(slug);
    if (!row) {
      missingSlugs.add(slug);
      continue;
    }
    // URL 必须精确命中该词 real_usage 里的某一条 —— 对不上说明清单与库不同步，
    // 此时写入就是把作者按到别的句子上。
    const item = row.items.find((it) => it.url === url);
    if (!item) {
      unmatchedUrls.add(`${slug}(${url})`);
      continue;
    }

    const author = typeof e.author === "string" && e.author.trim() !== "" ? e.author.trim() : null;
    const action: PlanAction =
      author === null ? "skip-no-author" : item.author === author ? "already-present" : "set-author";
    entries.push({
      slug,
      sentenceUrl: url,
      license: e.license ?? null,
      author,
      currentAuthor: item.author,
      action,
    });
  }

  const ccByEntries = entries.filter((e) => e.license === CC_BY_FR);
  return {
    entries,
    updates: entries.filter((e) => e.action === "set-author"),
    alreadyPresent: entries.filter((e) => e.action === "already-present"),
    skippedNoAuthor: entries.filter((e) => e.action === "skip-no-author"),
    missingSlugs: [...missingSlugs].sort(),
    unmatchedUrls: [...unmatchedUrls].sort(),
    invalidEntries,
    ccBy: {
      total: ccByEntries.length,
      resolved: ccByEntries.filter((e) => e.author !== null).length,
      missing: ccByEntries.filter((e) => e.author === null).length,
    },
  };
}

function resolveManifestPath(): string {
  const override = process.env.REAL_USAGE_AUTHORS_PATH;
  return override ? path.resolve(override) : DEFAULT_MANIFEST;
}

/** 从 `words.examples[0].verified.real_usage` 里抽出 url/author 两列。 */
export function extractRealUsage(slug: string, examples: unknown): ExistingRealUsage {
  const items: Array<{ url: string | null; author: string | null }> = [];
  if (!Array.isArray(examples) || examples.length === 0) return { slug, items };
  const first = examples[0];
  if (typeof first !== "object" || first === null) return { slug, items };
  const verified = (first as Record<string, unknown>).verified;
  if (typeof verified !== "object" || verified === null) return { slug, items };
  const realUsage = (verified as Record<string, unknown>).real_usage;
  if (!Array.isArray(realUsage)) return { slug, items };
  for (const raw of realUsage) {
    if (typeof raw !== "object" || raw === null) continue;
    const rec = raw as Record<string, unknown>;
    items.push({
      url: typeof rec.url === "string" ? rec.url : null,
      author: typeof rec.author === "string" && rec.author.trim() !== "" ? rec.author.trim() : null,
    });
  }
  return { slug, items };
}

async function main(): Promise<void> {
  const manifestPath = resolveManifestPath();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const dryRun = process.argv.includes("--dry-run");

  // 清单自身有问题就别连库了 —— 那是数据错误，不是环境错误。
  const invalid = validateManifest(manifest);
  if (invalid.length > 0) {
    throw new Error(`清单校验失败：\n  - ${invalid.join("\n  - ")}`);
  }

  const slugs = [...new Set(manifest.entries.map((e) => e.slug.trim()))];
  // 必须是 batch-import 角色：应用角色的 UPDATE policy 只放行 stub 行，
  // 改有释义的词条会静默命中 0 行（见文件头「跑法」一节）。
  const pool = getBatchImportPool();
  const { rows } = await pool.query<{ slug: string; examples: unknown }>(
    `SELECT slug, examples FROM words WHERE slug = ANY($1::text[])`,
    [slugs],
  );
  const existing = rows.map((r) => extractRealUsage(r.slug, r.examples));
  const plan = planAuthorBackfill(manifest, existing);

  console.log(`清单：${manifestPath}`);
  console.log(`条目：${manifest.entries.length} 条 / ${slugs.length} 个词`);
  console.log(`库现状：命中 ${existing.length} 个词，缺 ${plan.missingSlugs.length} 个`);

  // 硬错误：清单与库不同步。整体拒绝，不写半截。
  if (plan.missingSlugs.length > 0) {
    throw new Error(
      `以下 slug 在 words 表中不存在，整体拒绝执行（不写入任何数据）：\n  - ${plan.missingSlugs.join("\n  - ")}`,
    );
  }
  if (plan.unmatchedUrls.length > 0) {
    throw new Error(
      `以下清单条目的 sentence_url 在该词的 real_usage 里找不到（清单与库不同步），` +
        `整体拒绝执行（不写入任何数据）：\n  - ${plan.unmatchedUrls.join("\n  - ")}`,
    );
  }

  console.log("");
  console.log(`将写入 ${plan.updates.length} 条 author，已存在跳过 ${plan.alreadyPresent.length} 条`);
  for (const u of plan.updates) {
    const prev = u.currentAuthor === null ? "(空)" : u.currentAuthor;
    console.log(`  + ${u.slug.padEnd(20)} ${prev} ⇒ ${u.author}  [${u.license ?? "许可未知"}]`);
  }
  for (const e of plan.alreadyPresent) {
    console.log(`  = ${e.slug.padEnd(20)} 已是 ${e.author}，跳过`);
  }
  if (plan.skippedNoAuthor.length > 0) {
    console.log("");
    console.log(`清单里 ${plan.skippedNoAuthor.length} 条未抓到作者，跳过（不填占位符）：`);
    for (const e of plan.skippedNoAuthor) {
      const reason = manifest.entries.find((m) => m.slug === e.slug)?.reason ?? "未知";
      console.log(`  ! ${e.slug.padEnd(20)} ${reason}`);
    }
  }

  if (dryRun) {
    console.log("");
    console.log("[dry-run] 未写入任何数据。去掉 --dry-run 即执行。");
    console.log(reportLine(plan));
    return;
  }

  if (plan.updates.length === 0) {
    console.log("");
    console.log("无需改动（幂等：本次清单已全部写入过）。");
    console.log(reportLine(plan));
    return;
  }

  // 单事务：要么全部写入，要么全不写。
  //
  // **必须校验 rowCount**。Postgres 对「RLS policy 让行不可见」的 UPDATE 返回
  // rowCount=0 且不报错 —— 迁移 0025 的 words_stub_update_app 只放行 stub 行，
  // 用应用角色改有释义的词条就会静默命中 0 行（backfill-word-aliases.ts 真的
  // 踩过：脚本一路打印「已写入 25 个词条」，实际库里一个字节都没变）。
  //
  // 写入用 jsonb_set 定点打键：只动 `real_usage[i].author`，其余字段原样。
  // WHERE 里再核一次 url，确保写的是这一条（防清单/库在读取后发生位移）。
  const zeroRows: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const u of plan.updates) {
      const idx = existing
        .find((e) => e.slug === u.slug)
        ?.items.findIndex((it) => it.url === u.sentenceUrl);
      if (idx === undefined || idx < 0) {
        zeroRows.push(`${u.slug}(索引丢失)`);
        continue;
      }
      const res = await client.query(
        `UPDATE words
            SET examples = jsonb_set(
                  examples,
                  ARRAY['0', 'verified', 'real_usage', $2::text, 'author'],
                  to_jsonb($3::text),
                  true
                )
          WHERE slug = $1
            AND examples->0->'verified'->'real_usage'->$2::int->>'url' = $4`,
        [u.slug, String(idx), u.author, u.sentenceUrl],
      );
      if (res.rowCount !== 1) zeroRows.push(`${u.slug}(rowCount=${res.rowCount})`);
    }
    if (zeroRows.length > 0) {
      await client.query("ROLLBACK");
      throw new Error(
        `以下条目的 UPDATE 未命中任何行，事务已回滚：\n  - ${zeroRows.join("\n  - ")}\n` +
          `  请确认用的是 BATCH_IMPORT_DATABASE_URL（vocab_batch_import 角色）；` +
          `应用角色 vocab_app 的 UPDATE policy 只放行 stub 行（definition_md = ''），` +
          `改有释义的词条会静默命中 0 行。`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ROLLBACK 自身失败 —— 仍然抛原始错误
    }
    throw error;
  } finally {
    client.release();
  }
  console.log("");
  console.log(`已写入 ${plan.updates.length} 条 author。`);

  // 写后自检：重读一遍，确认每条 author 都真的落库了。
  const verify = await pool.query<{ slug: string; examples: unknown }>(
    `SELECT slug, examples FROM words WHERE slug = ANY($1::text[])`,
    [plan.updates.map((u) => u.slug)],
  );
  const landed = new Map(
    verify.rows.map((r) => [r.slug, extractRealUsage(r.slug, r.examples)]),
  );
  const notLanded = plan.updates.filter((u) => {
    const items = landed.get(u.slug)?.items ?? [];
    return !items.some((it) => it.url === u.sentenceUrl && it.author === u.author);
  });
  if (notLanded.length > 0) {
    throw new Error(
      `写后自检失败，以下条目未落库：${notLanded.map((u) => u.slug).join(", ")}`,
    );
  }
  console.log(`写后自检通过：${plan.updates.length} 条 author 全部可查。`);
  console.log(reportLine(plan));
}

/** 「补到 N / 79，缺 M」——按任务口径单列 CC BY 2.0 FR 的补齐情况。 */
export function reportLine(plan: Plan): string {
  const line =
    `补到 ${plan.ccBy.resolved} / ${plan.ccBy.total}，缺 ${plan.ccBy.missing}` +
    `（口径：CC BY 2.0 FR 条目；另有 CC0 1.0 等无署名义务条目见上）`;
  return line;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
