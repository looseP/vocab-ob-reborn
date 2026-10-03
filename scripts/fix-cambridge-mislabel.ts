/**
 * 数据修正脚本 —— 纠正 22 条「声称来自 Cambridge Dictionary」的虚假署名。
 *
 * 用法：npm run db:script:fix-cambridge-mislabel [-- --dry-run]
 *
 * ## 为什么需要它
 *
 * 实测（**2026-10-03**）：22 个词的 `examples[0]` 写着
 * `source = "Cambridge Dictionary · <lemma>"`、`source_type = reference`、
 * `url` 指向 Cambridge 词条页，但**正文是自撰教学句**。抽样抓取 6 条
 * （accuse / biophilia / characterise / accessibility / adequate / ambiguous）
 * 逐个核对 Cambridge 页面，**库内句子一条都不在页面上** ——
 * 例如 accuse 存的是
 * "The opposition party accused the minister of hiding the full cost of the project from parliament."
 * 而 Cambridge 该页的实际例句是 "It wasn't my fault." / "He's been accused of robbery/murder." 等。
 *
 * 完整取证见 `data/cambridge-mislabel-audit-2026-10-03.md`（含逐条明细与抓取对照）。
 *
 * 这不是"标注不精确"，是**虚假署名**：把自撰内容归到 Cambridge 名下，既误导学习者，
 * 也是对他方来源的错误归属。同库另有 216 条同类自撰句如实标着
 * `构造参考 · <lemma>`，说明"如实标注"在本仓已有既定表述 —— 这 22 条是漏标。
 *
 * ## 修正口径（只改三个字段）
 *
 * | 字段 | 改前 | 改后 |
 * | --- | --- | --- |
 * | `source` | `Cambridge Dictionary · <lemma>` | `构造参考 · <lemma>` |
 * | `url` | Cambridge 词条页 | 删除该键（置空） |
 * | `note` | 原值 | 追加「自撰教学例句，非词典原文」 |
 *
 * `source_type` **不动**：全库只有 press/reference/institution/academic/quote/media
 * 六类，没有「自撰」这一类。新增 `constructed` 取值是独立的结构性问题
 * （也是"UI 无法可靠区分来源"的根因），涉及卡面设计与迁移，不在本次范围。
 *
 * `url` 为什么**删键**而不是设 `null`：`jsonb_set(..., to_jsonb($1::text))` 在
 * `$1` 为 SQL NULL 时会把整个 `examples` 写成 SQL NULL（`to_jsonb(NULL::text)`
 * 返回 SQL NULL 而非 jsonb `null`），这是本条最危险的写法陷阱。删键用 `#-`，
 * 不经过任何 NULL 转换。删掉也符合语义：没有出处就不该有这个键。
 *
 * ## 范围（刻意保守）
 *
 * - 判据是 `examples[0].source ILIKE '%Cambridge%'`，实测 22 条。
 * - 脚本内嵌这 22 个 slug 的**期望清单**，并与库中实际命中集合**双向比对**：
 *   库里有而清单没有 → 报错（防漏改）；清单有而库里 source 既不是 Cambridge
 *   也不是已修正态 → 报错（防误改）。
 * - 不动 `verified.checked` / `assertions_avoided`（产线自检记录，历史事实）、
 *   不动 `translation` / `exam` 三层 / `anchor` / `modified` / 主句。
 * - 不清理 `source` 里「待网页核验」的尾巴（那是另一件事，本 PR 明确不含）。
 *
 * ## 跑法 —— 必须用 batch-import 角色，不能用应用角色
 *
 * 数据库不对宿主暴露，要**在栈内跑**（`postgres:5432` 才解析得到）。镜像里
 * 没有新脚本与 `data/`，所以要挂载：
 *
 *   docker compose run --rm -v "<repo>/scripts:/app/scripts:ro" \
 *     -e NODE_ENV=development -e DB_SSLMODE=disable \
 *     -e BATCH_IMPORT_DATABASE_URL='postgresql://vocab_batch_import:...@postgres:5432/vocab' \
 *     web npx tsx scripts/fix-cambridge-mislabel.ts [--dry-run]
 *
 * **为什么必须是 `BATCH_IMPORT_DATABASE_URL` 而不是 `DATABASE_URL`**：
 * 迁移 0025 给 `vocab_app` 建的 UPDATE policy 是
 * `USING (definition_md = '' AND is_published AND NOT is_deleted)` —— 只允许改
 * stub 行。本脚本要改的 22 个词全都有真实释义（非 stub），用应用角色 UPDATE
 * 会命中 0 行且不报错（Postgres 当作「行对当前角色不可见」），脚本若不查
 * rowCount 就会一路报「写入成功」。实测两角色的 policy 差异：
 *   vocab_app           words_stub_update_app      USING (definition_md = '')
 *   vocab_batch_import  vocab_batch_import_update  USING (true)
 *
 * ## 幂等
 *
 * 已修正的条目（`source` 已是 `构造参考 · <lemma>`）在计划阶段就归入
 * `alreadyFixed` 并跳过。整个修正**在单个事务里执行**，重复执行第二次必然是
 * 0 改动。任何一条 UPDATE 命中 0 行 → 整体回滚并报错。
 *
 * ## 安全性
 *
 * `examples` **不参与 content_hash**（`src/db/content-hash.ts`：L1 = definition_md +
 * core_definitions + prototype_text + morphology + mnemonic + semantic_chain；
 * L2 = collocations + corpus_items + synonym_items + antonym_items），
 * 所以改 examples 的 source/url/note 不会造成哈希漂移，不会让任何 L1 复习卡
 * 被判「内容已变」而失效。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBatchImportPool } from "../src/db/connection";

/** 改后 source 的前缀（与库内 216 条同类自撰句同款表述）。 */
export const CONSTRUCTED_SOURCE_PREFIX = "构造参考 · ";

/** note 追加语：防止后续再被当成词典原文/真实语料。 */
export const NOTE_APPENDIX = "自撰教学例句，非词典原文";

/** 判据：source 含 Cambridge 即命中（与审计清单同源）。 */
export const CAMBRIDGE_SOURCE_PATTERN = "%Cambridge%";

/**
 * 期望修正清单 —— 22 个 slug。
 *
 * 与 `data/cambridge-mislabel-audit-2026-10-03.md` 的明细表逐条对应。
 * 库中命中 Cambridge 的 slug 集合必须**恰好**是这 22 个，多一个少一个都拒绝执行。
 */
export const EXPECTED_SLUGS: readonly string[] = [
  "accessibility",
  "accord",
  "accuse",
  "adequate",
  "ambiguous",
  "archaeological",
  "archaeologist",
  "assassinate",
  "assertion",
  "assume",
  "biophilia",
  "catalogue",
  "characterise",
  "civilisation",
  "congratulate",
  "emphasise",
  "endeavour",
  "fertilise",
  "figure",
  "futurologist",
  "geneticist",
  "geocentric",
];

/** 库中一个词的当前状态（本脚本只关心这三个字段 + lemma）。 */
export interface ExistingRow {
  slug: string;
  lemma: string;
  source: string | null;
  url: string | null;
  note: string | null;
}

export type PlanAction = "fix" | "already-fixed";

export interface PlanEntry {
  slug: string;
  lemma: string;
  action: PlanAction;
  /** 改前 source（already-fixed 时为当前值）。 */
  currentSource: string | null;
  /** 改后 source。 */
  nextSource: string;
  /** 改前 url（fix 时应指向 Cambridge）。 */
  currentUrl: string | null;
  /** 改后 note。 */
  nextNote: string;
}

export interface Plan {
  entries: PlanEntry[];
  fixes: PlanEntry[];
  alreadyFixed: PlanEntry[];
  /** 清单里有、库中查不到（或 source 状态异常）的 slug —— 非空即整体拒绝。 */
  problems: string[];
  /** 库中命中 Cambridge 但不在清单里的 slug —— 非空即整体拒绝（防漏改）。 */
  unexpected: string[];
}

/** 由 slug + lemma 拼出改后 source（唯一真源，避免各处手写前缀）。 */
export function constructedSource(lemma: string): string {
  return `${CONSTRUCTED_SOURCE_PREFIX}${lemma}`;
}

/** 追加 note：原值为空则直接设为追加语，否则用「；」连接（不覆盖原值）。 */
export function appendNote(current: string | null): string {
  const trimmed = (current ?? "").trim();
  return trimmed === "" ? NOTE_APPENDIX : `${trimmed}；${NOTE_APPENDIX}`;
}

/** 该行是否已被修正过（source 已是「构造参考 · <lemma>」）。 */
function isFixed(row: ExistingRow): boolean {
  return (row.source ?? "") === constructedSource(row.lemma);
}

/**
 * 把库现状算成一份执行计划。**纯函数**，不碰数据库，所以单测能直接覆盖。
 *
 * 三类分流：
 * - `source` 是 Cambridge 态 → `fix`（要改）
 * - `source` 已是「构造参考 · <lemma>」→ `already-fixed`（幂等跳过）
 * - 其它 → `problems`（状态异常，拒绝执行 —— 可能是人工改过，脚本不该覆盖）
 *
 * 另有 `unexpected`：库中命中 Cambridge 却不在清单里的 slug（防漏改）。
 */
export function planCambridgeFix(rows: ExistingRow[], cambridgeSlugs: readonly string[]): Plan {
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const entries: PlanEntry[] = [];
  const problems: string[] = [];
  const expected = new Set(EXPECTED_SLUGS);

  for (const slug of EXPECTED_SLUGS) {
    const row = bySlug.get(slug);
    if (!row) {
      problems.push(`${slug}：库中不存在该 slug`);
      continue;
    }
    const current = row.source ?? "";
    const nextSource = constructedSource(row.lemma);
    if (isFixed(row)) {
      entries.push({
        slug,
        lemma: row.lemma,
        action: "already-fixed",
        currentSource: row.source,
        nextSource,
        currentUrl: row.url,
        nextNote: appendNote(row.note),
      });
      continue;
    }
    if (!current.includes("Cambridge")) {
      problems.push(
        `${slug}：source 既不是 Cambridge 态也不是已修正态（当前「${current}」）—— ` +
          `可能已被人工修改，脚本不覆盖`,
      );
      continue;
    }
    entries.push({
      slug,
      lemma: row.lemma,
      action: "fix",
      currentSource: row.source,
      nextSource,
      currentUrl: row.url,
      nextNote: appendNote(row.note),
    });
  }

  const unexpected = cambridgeSlugs.filter((s) => !expected.has(s)).sort();
  return {
    entries,
    fixes: entries.filter((e) => e.action === "fix"),
    alreadyFixed: entries.filter((e) => e.action === "already-fixed"),
    problems,
    unexpected,
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  // 必须是 batch-import 角色：应用角色的 UPDATE policy 只放行 stub 行，
  // 改有释义的词条会静默命中 0 行（见文件头「跑法」一节）。
  const pool = getBatchImportPool();

  // 两路查询：① 清单里的 22 个词的现状；② 全库命中 Cambridge 的 slug（防漏改）。
  const { rows } = await pool.query<{
    slug: string;
    lemma: string;
    source: string | null;
    url: string | null;
    note: string | null;
  }>(
    `SELECT slug, lemma,
            examples->0->>'source' AS source,
            examples->0->>'url'    AS url,
            examples->0->>'note'   AS note
       FROM words
      WHERE slug = ANY($1::text[])`,
    [[...EXPECTED_SLUGS]],
  );
  const cambridge = await pool.query<{ slug: string }>(
    `SELECT slug FROM words WHERE examples->0->>'source' ILIKE $1 ORDER BY slug`,
    [CAMBRIDGE_SOURCE_PATTERN],
  );

  const existing: ExistingRow[] = rows.map((r) => ({
    slug: r.slug,
    lemma: r.lemma,
    source: r.source,
    url: r.url,
    note: r.note,
  }));
  const plan = planCambridgeFix(existing, cambridge.rows.map((r) => r.slug));

  console.log(`期望修正：${EXPECTED_SLUGS.length} 条（判据 source ILIKE '${CAMBRIDGE_SOURCE_PATTERN}'）`);
  console.log(`库中命中 Cambridge 态：${cambridge.rows.length} 条`);

  if (plan.unexpected.length > 0) {
    throw new Error(
      `以下 slug 的 source 含 Cambridge 但不在清单内（清单与库不同步），` +
        `整体拒绝执行：\n  - ${plan.unexpected.join("\n  - ")}\n` +
        `  请先更新 data/cambridge-mislabel-audit-*.md 与脚本内 EXPECTED_SLUGS。`,
    );
  }
  if (plan.problems.length > 0) {
    throw new Error(
      `以下条目状态异常，整体拒绝执行（不写入任何数据）：\n  - ${plan.problems.join("\n  - ")}`,
    );
  }

  console.log("");
  console.log(`将修正 ${plan.fixes.length} 条，已修正跳过 ${plan.alreadyFixed.length} 条`);
  for (const e of plan.fixes) {
    console.log(`  + ${e.slug.padEnd(16)} 「${e.currentSource}」 ⇒ 「${e.nextSource}」`);
    console.log(`      url: ${e.currentUrl ?? "(空)"} ⇒ (删除)`);
    console.log(`      note: ⇒ 「${e.nextNote}」`);
  }
  for (const e of plan.alreadyFixed) {
    console.log(`  = ${e.slug.padEnd(16)} 已是「${e.nextSource}」，跳过`);
  }

  if (dryRun) {
    console.log("");
    console.log("[dry-run] 未写入任何数据。去掉 --dry-run 即执行。");
    return;
  }

  if (plan.fixes.length === 0) {
    console.log("");
    console.log("无需改动（幂等：22 条已全部修正过）。");
    return;
  }

  // 单事务：要么全部写入，要么全不写。
  //
  // **必须校验 rowCount**：Postgres 对「RLS policy 让行不可见」的 UPDATE 返回
  // rowCount=0 且不报错。用应用角色改有释义的词条就会这样静默失败
  // （backfill-word-aliases.ts 真的踩过：打印「已写入 25 个词条」而库里没变）。
  //
  // 写入用 `#-` 删 url 键 + `jsonb_set` 定点打 source/note：
  //   - 内层 `examples #- '{0,url}'` 删掉 url（避免 to_jsonb(NULL) 把整列写成 NULL）
  //   - 中层改 source
  //   - 外层改 note（引用的是**原始** examples 的 note，内层没碰它）
  // `source_type` **不写**（任务范围：只改 source / url / note）。
  // WHERE 里再核一次「source 仍是 Cambridge 态」，确保改的是预期那一行。
  const zeroRows: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const e of plan.fixes) {
      const res = await client.query(
        `UPDATE words
            SET examples = jsonb_set(
                  jsonb_set(
                    examples #- '{0,url}',
                    '{0,source}',
                    to_jsonb($2::text)
                  ),
                  '{0,note}',
                  to_jsonb($3::text)
                )
          WHERE slug = $1
            AND examples->0->>'source' ILIKE $4`,
        [e.slug, e.nextSource, e.nextNote, CAMBRIDGE_SOURCE_PATTERN],
      );
      if (res.rowCount !== 1) zeroRows.push(`${e.slug}(rowCount=${res.rowCount})`);
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
      // ROLLBACK 自身失败 —— 仍然抛出原始错误
    }
    throw error;
  } finally {
    client.release();
  }
  console.log("");
  console.log(`已修正 ${plan.fixes.length} 条。`);

  // 写后自检：重读一遍，确认 source 已改、url 已删、note 已写。
  const verify = await pool.query<{
    slug: string;
    source: string | null;
    has_url: boolean;
    note: string | null;
  }>(
    `SELECT slug,
            examples->0->>'source' AS source,
            (examples->0 ? 'url') AS has_url,
            examples->0->>'note'   AS note
       FROM words
      WHERE slug = ANY($1::text[])`,
    [plan.fixes.map((e) => e.slug)],
  );
  const landed = new Map(verify.rows.map((r) => [r.slug, r]));
  const notLanded: string[] = [];
  for (const e of plan.fixes) {
    const row = landed.get(e.slug);
    if (!row) {
      notLanded.push(`${e.slug}(查不到)`);
      continue;
    }
    if (row.source !== e.nextSource) notLanded.push(`${e.slug}(source=${row.source})`);
    if (row.has_url) notLanded.push(`${e.slug}(url 未删除)`);
    if ((row.note ?? "") !== e.nextNote) notLanded.push(`${e.slug}(note 不符)`);
  }
  if (notLanded.length > 0) {
    throw new Error(`写后自检失败：\n  - ${notLanded.join("\n  - ")}`);
  }
  console.log(`写后自检通过：${plan.fixes.length} 条 source/url/note 全部符合预期。`);

  // 终态复查：全库不应再有 Cambridge 标注。
  const remaining = await pool.query<{ slug: string }>(
    `SELECT slug FROM words WHERE examples->0->>'source' ILIKE $1 ORDER BY slug`,
    [CAMBRIDGE_SOURCE_PATTERN],
  );
  if (remaining.rows.length > 0) {
    throw new Error(
      `终态复查失败，仍有 ${remaining.rows.length} 条 Cambridge 标注：${remaining.rows.map((r) => r.slug).join(", ")}`,
    );
  }
  console.log("终态复查通过：全库已无 source ILIKE '%Cambridge%' 的主句。");
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
