/**
 * 数据修正脚本 —— 清洗 216 条 `examples[0].source` 里的「待网页核验」尾巴。
 *
 * 用法：`npm run db:script:clean-pending-web-verify [-- --dry-run]`
 *
 * ## 为什么需要它
 *
 * 实测（**2026-10-07**，自用栈与 dev 双库一致）：**216 条**词条的
 * `examples[0].source` 形如
 *
 *     "构造参考 · absolutist（迁移包 SD 取材，待网页核验）"
 *
 * —— 把「取材方式」与「核验状态」两种**内部工作状态**挤进了一个给学习者看的
 * 人类可读字符串。UI 与导出都读不可靠（要么整串照抄，要么不敢解析），且属已登记
 * 8 天的合规残留。设计判断见 `docs/design/后续推进-设计指导-2026-10-06.md` §2。
 *
 * ## 口径（与设计稿 §2 一致）
 *
 * | 字段 | 改前 | 改后 |
 * | --- | --- | --- |
 * | `examples[0].source` | `构造参考 · <lemma>（迁移包 SD 取材，待网页核验）` | `构造参考 · <lemma>` |
 * | `examples[0].verified.pending_web_check` | （无） | `true` |
 *
 * 其余键（`url` / `source_type` / `text` / `translation` / `exam` / `anchor` /
 * `modified` / `verified.checked`）**一律不动**。
 *
 * ### 状态为什么没有丢
 *
 * 「待网页核验」是**真实待办状态**，不因清洗而消失。它已有载体：这 216 条的 `url`
 * 全是占位符 `about:blank?todo=web-verify-<slug>`（实测 216/216）。本次按设计稿建议
 * **再补一个显式字段** `verified.pending_web_check = true`（无需解析 URL 即可判定）；
 * 两条并存 —— 将来若清理占位 url，状态仍在。
 *
 * ### 与既有 22 条的关系
 *
 * 全库「构造参考」示例共 **238** 条：其中 **22** 条已是干净形态 `构造参考 · <lemma>`
 * （`fix-cambridge-mislabel.ts` 的产物），另 **216** 条带尾巴（本脚本的对象）。
 * **改后形态与那 22 条完全一致** —— 这也是「本仓既定表述」的出处。
 *
 * ### 范围外残留（刻意不动）
 *
 * 216 条里有 **135 行**的 `verified.assertions_avoided` 也写着同一句话
 * （`"句层为构造参考句（取材自迁移包 SD，待网页核验）"`）。那是**产线自检记录**
 * ——记录"当时**没有**声称什么"，属历史事实；先例 `fix-cambridge-mislabel.ts`
 * 对 `verified.checked` / `assertions_avoided` 的处置明写「不动」，本脚本同口径。
 * 它不是对外署名，UI/导出都不读它，不构成合规残留。
 *
 * ## 范围与三道防线（照 `fix-cambridge-mislabel.ts` 的惯例）
 *
 * - 判据：`examples[0]->>'source' LIKE '%待网页核验%'`（实测 216 条 / 216 行，全部
 *   落在 `examples[0]`；这些行的 `jsonb_array_length(examples) = 1`）。
 * - **索引越界防线**：另查「**非 `[0]` 位置**的 `element.source` 含标记」的行数，非 0
 *   即拒绝执行（防有条目把尾巴写在 `[1..]` 而只改一半）。
 *   ⚠️ 判据必须落在 `element.source` 上，**不能用 `examples::text`** —— 后者会连
 *   `verified.assertions_avoided` 里的产线自检记录一起算进来（实测 135 行），
 *   与「尾巴在不在 `[0]`」无关，拿它做防线会在清洗后误报（2026-10-07 在 dev 上踩到）。
 * - **形态防线**：尾巴必须**在末尾**，且剥离后必须以「构造参考 · 」开头、lemma 非空
 *   且无残缺标点；否则归入 `problems` 并整体拒绝（可能已被人工改过，脚本不覆盖）。
 * - **总数防线**：`带尾巴的行 + 已清洗行（有 pending_web_check 且无尾巴）` 必须恰为
 *   **216**；不等即拒绝（防漏改，也防「半清洗」状态被当成正常）。
 *
 * ## 跑法 —— 必须用 batch-import 角色
 *
 * 与 `backfill-word-aliases` / `fix-cambridge-mislabel` 同款理由：`words` 的**内容行**
 * 用应用角色 `vocab_app` 改会**静默命中 0 行**（迁移 0025 的 UPDATE policy 只放行
 * stub 行 `definition_md = ''`）。`examples` 属词条内容，故用 `vocab_batch_import`
 * （其 UPDATE policy 是 `USING true`），并逐条校验 `rowCount`。
 *
 * 生产镜像只带 7 个运行时脚本（不含 `backfill-*` 与本脚本），**对自用栈跑要用一次性
 * 容器 + 只读挂载**（2026-10-07 实测跑通）：
 *
 *     docker run --rm --network vocab-observatory_default \
 *       -v F:/dev/vocab-ob/wt-main/scripts:/app/scripts:ro \
 *       -v F:/dev/vocab-ob/wt-main/src:/app/src:ro \
 *       -e NODE_ENV=development -e DB_SSLMODE=disable \
 *       -e BATCH_IMPORT_DATABASE_URL='postgresql://vocab_batch_import:...@postgres:5432/vocab' \
 *       -w /app --entrypoint ./node_modules/.bin/tsx \
 *       vocab-observatory-v2:local scripts/clean-source-pending-web-verify.ts [--dry-run]
 *
 * ## 幂等
 *
 * 已清洗条目（无尾巴、有 `pending_web_check`）不在判据命中集内 ⇒ 第二次执行命中 0 条，
 * 报「无需改动」。整个修正在**单事务**里，任何一条 UPDATE 命中 0 行则整体回滚。
 *
 * ## 安全性
 *
 * `examples` **不参与 content_hash**（`src/db/content-hash.ts` 实测：L1 =
 * definition_md + core_definitions + prototype_text + morphology + mnemonic +
 * semantic_chain；L2 = collocations + corpus_items + synonym_items + antonym_items，
 * 无 `examples`），所以清洗不会造成哈希漂移，不会让任何 L1 复习卡被判「内容已变」。
 *
 * ## 未做（如实登记）
 *
 * **上游回潮**：本仓 grep 不到生成侧（写「迁移包 SD 取材」/「待网页核验」的）脚本 ——
 * 该文案是**外部迁移包工具**产出。上游不改，下次导入会**回潮**；本脚本只能治已入库数据。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBatchImportPool } from "../src/db/connection";
import { CONSTRUCTED_SOURCE_PREFIX } from "./fix-cambridge-mislabel";

/** 库内尾巴的唯一形态（216/216 全等，含全角括号）。 */
export const PENDING_WEB_VERIFY_TAIL = "（迁移包 SD 取材，待网页核验）";

/** 判据（干跑与真跑共用，避免两处漂移）。 */
export const PENDING_MARKER = "待网页核验";

/**
 * 期望总数 —— 审计基线：**2026-10-07** 自用栈与 dev 双库实测均为
 * `带尾巴 216 + 已清洗 0`。库侧数量变化说明有导入/人工改动，须先复核再改本常量。
 */
export const EXPECTED_TOTAL = 216;

/** 显式状态字段（jsonb 路径）：该例句尚未上网核验。 */
export const PENDING_FIELD = "pending_web_check";

/** 命中行的库侧投影。 */
export interface SourceRow {
  slug: string;
  source: string | null;
  /** 改前 `verified.checked` 的条目数（写后自检用，防 jsonb_set 误伤）。 */
  checkedCount: number;
}

export interface CleanChange {
  slug: string;
  before: string;
  after: string;
  checkedCount: number;
}

export interface CleanPlan {
  changes: CleanChange[];
  /** 形态异常的条目（非空即整体拒绝执行，不写入任何数据）。 */
  problems: string[];
}

/**
 * 剥掉尾巴，返回清洗后的 `source`；**形态无法识别时返回 `null`**（调用方归入
 * `problems` 并拒绝执行 —— 不猜、不覆盖人工改动）。
 *
 * 纯函数：不碰数据库，单测直接覆盖。
 */
export function cleanSource(source: string | null): string | null {
  if (typeof source !== "string") return null;
  // 尾巴必须在**末尾**：不在末尾说明形态不是本脚本认得的（例如后面还有别的尾巴）。
  if (!source.endsWith(PENDING_WEB_VERIFY_TAIL)) return null;
  const cleaned = source.slice(0, source.length - PENDING_WEB_VERIFY_TAIL.length);
  // 剥一层之后**不得仍含标记**（如双重尾巴）：否则会带着残留写回去（终态复查也会红）。
  // 未知形态一律拒绝，不猜要剥几层。
  if (cleaned.includes(PENDING_MARKER)) return null;
  // 剥离后必须是本仓既定的「构造参考 · <lemma>」形态（与既有 22 条同款）。
  if (!cleaned.startsWith(CONSTRUCTED_SOURCE_PREFIX)) return null;
  const lemma = cleaned.slice(CONSTRUCTED_SOURCE_PREFIX.length);
  if (lemma.trim() === "") return null;
  // 残缺标点 = 只剥了一半（如「构造参考 · x（（…）」「构造参考 · x，…」），拒绝。
  if (/[（(，,、（]$/.test(lemma)) return null;
  return cleaned;
}

/** 把库现状算成执行计划。**纯函数**，不碰数据库。 */
export function planClean(rows: SourceRow[]): CleanPlan {
  const changes: CleanChange[] = [];
  const problems: string[] = [];
  for (const row of rows) {
    const after = cleanSource(row.source);
    if (after === null) {
      problems.push(
        `${row.slug}：source 含「${PENDING_MARKER}」但形态不是「构造参考 · <lemma>${PENDING_WEB_VERIFY_TAIL}」` +
          `（当前「${row.source ?? "(空)"}」）—— 可能已被人工改过，脚本不覆盖`,
      );
      continue;
    }
    changes.push({ slug: row.slug, before: row.source as string, after, checkedCount: row.checkedCount });
  }
  return { changes, problems };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  // 必须是 batch-import 角色：应用角色改 words 内容行会静默命中 0 行（见文件头「跑法」）。
  const pool = getBatchImportPool();
  const like = `%${PENDING_MARKER}%`;

  // ① 判据命中（`examples[0]`），带出改前 `checked` 条目数供写后自检比对。
  const hits = await pool.query<{ slug: string; source: string | null; checked: string }>(
    `SELECT slug,
            examples->0->>'source' AS source,
            jsonb_array_length(coalesce(examples->0->'verified'->'checked', '[]'::jsonb))::text AS checked
       FROM words
      WHERE examples->0->>'source' LIKE $1
      ORDER BY slug`,
    [like],
  );
  // ② 索引越界防线：任何**非 [0] 位置**的 `element.source` 含标记 → 拒绝（本脚本只改 [0]）。
  //    注意判据必须是「element 的 source」，不能用 `examples::text` —— 后者会连
  //    `verified.assertions_avoided` 里的**产线自检记录**一起算进来（实测 135 行），
  //    与「尾巴在不在 [0]」无关，用它做防线会在清洗后误报。
  const offIndex = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM words w
      WHERE EXISTS (
              SELECT 1
                FROM jsonb_array_elements(w.examples) WITH ORDINALITY AS t(e, ord)
               WHERE ord > 1 AND coalesce(e->>'source', '') LIKE $1
            )`,
    [like],
  );
  // ③ 已清洗行（有 pending_web_check 且**无**尾巴）—— 幂等与总数防线的另一半。
  const cleaned = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM words w
      WHERE EXISTS (
              SELECT 1 FROM jsonb_array_elements(w.examples) e
               WHERE e #> '{verified,${PENDING_FIELD}}' = 'true'::jsonb
            )
        AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(w.examples) e2
               WHERE coalesce(e2->>'source', '') LIKE $1
            )`,
    [like],
  );

  const rows: SourceRow[] = hits.rows.map((r) => ({
    slug: r.slug,
    source: r.source,
    checkedCount: Number(r.checked),
  }));
  const plan = planClean(rows);
  const cleanedCount = Number(cleaned.rows[0].n);

  console.log(`期望清洗：${EXPECTED_TOTAL} 条（判据 examples[0].source LIKE '${like}'）`);
  console.log(
    `库中现状：带尾巴 ${rows.length} 条 + 已清洗 ${cleanedCount} 条 = ${rows.length + cleanedCount} 条`,
  );

  if (Number(offIndex.rows[0].n) !== 0) {
    throw new Error(
      `索引越界防线触发：有 ${offIndex.rows[0].n} 行的 [1..] 位置 element.source 含「${PENDING_MARKER}」，` +
        `本脚本只改 [0]，会漏改。整体拒绝执行（先确认这些条目的形态）。`,
    );
  }
  if (plan.problems.length > 0) {
    throw new Error(
      `以下条目形态异常，整体拒绝执行（不写入任何数据）：\n  - ${plan.problems.join("\n  - ")}`,
    );
  }
  if (rows.length + cleanedCount !== EXPECTED_TOTAL) {
    throw new Error(
      `总数防线触发：带尾巴 ${rows.length} + 已清洗 ${cleanedCount} = ${rows.length + cleanedCount}，` +
        `与审计基线 ${EXPECTED_TOTAL} 不符（有新导入或人工改动）。请先复核再改 EXPECTED_TOTAL。`,
    );
  }

  console.log("");
  console.log(`将清洗 ${plan.changes.length} 条（另 ${cleanedCount} 条已清洗）：`);
  for (const c of plan.changes) {
    console.log(`  + ${c.slug.padEnd(18)} 「${c.before}」`);
    console.log(`    ⇒ 「${c.after}」 + verified.${PENDING_FIELD}=true`);
  }

  if (dryRun) {
    console.log("");
    console.log("[dry-run] 未写入任何数据。去掉 --dry-run 即执行。");
    return;
  }
  if (plan.changes.length === 0) {
    console.log("");
    console.log(`无需改动（幂等：${EXPECTED_TOTAL} 条已全部清洗过）。`);
    return;
  }

  // 单事务：要么全部写入，要么全不写。
  // **必须校验 rowCount**：Postgres 对「RLS policy 让行不可见」的 UPDATE 返回
  // rowCount=0 且不报错（本仓已踩过两次：backfill-word-aliases / fix-cambridge-mislabel）。
  // 写入只做两件事：删尾巴后的 source（`jsonb_set` 定点打 `{0,source}`）+ 补状态字段。
  // WHERE 里再核一次「source 仍是改前的完整串」，确保改的是预期那一行。
  const zeroRows: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const c of plan.changes) {
      const res = await client.query(
        `UPDATE words
            SET examples = jsonb_set(
                  jsonb_set(examples, '{0,source}', to_jsonb($3::text)),
                  '{0,verified,${PENDING_FIELD}}',
                  'true'::jsonb
                )
          WHERE slug = $1
            AND examples->0->>'source' = $2`,
        [c.slug, c.before, c.after],
      );
      if (res.rowCount !== 1) zeroRows.push(`${c.slug}(rowCount=${res.rowCount})`);
    }
    if (zeroRows.length > 0) {
      await client.query("ROLLBACK");
      throw new Error(
        `以下条目的 UPDATE 未命中任何行，事务已回滚：\n  - ${zeroRows.join("\n  - ")}\n` +
          `  请确认用的是 BATCH_IMPORT_DATABASE_URL（vocab_batch_import 角色）；` +
          `应用角色 vocab_app 的 UPDATE policy 只放行 stub 行（definition_md = ''）。`,
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
  console.log(`已清洗 ${plan.changes.length} 条。`);

  // 写后自检：重读确认 source 已改、状态字段已写、`verified.checked` 条目数未变。
  const verify = await pool.query<{
    slug: string;
    source: string | null;
    field: string | null;
    checked: string;
  }>(
    `SELECT slug,
            examples->0->>'source' AS source,
            (examples #> '{0,verified,${PENDING_FIELD}}')::text AS field,
            jsonb_array_length(coalesce(examples->0->'verified'->'checked', '[]'::jsonb))::text AS checked
       FROM words
      WHERE slug = ANY($1::text[])`,
    [plan.changes.map((c) => c.slug)],
  );
  const landed = new Map(verify.rows.map((r) => [r.slug, r]));
  const notLanded: string[] = [];
  for (const c of plan.changes) {
    const row = landed.get(c.slug);
    if (!row) {
      notLanded.push(`${c.slug}(查不到)`);
      continue;
    }
    if (row.source !== c.after) notLanded.push(`${c.slug}(source=${row.source})`);
    if (row.field !== "true") notLanded.push(`${c.slug}(${PENDING_FIELD}=${row.field})`);
    if (Number(row.checked) !== c.checkedCount) {
      notLanded.push(`${c.slug}(verified.checked 条目数 ${c.checkedCount} → ${row.checked})`);
    }
  }
  if (notLanded.length > 0) {
    throw new Error(`写后自检失败：\n  - ${notLanded.join("\n  - ")}`);
  }
  console.log(`写后自检通过：${plan.changes.length} 条 source/状态字段符合预期，verified.checked 未动。`);

  // 终态复查：**scope 内**（`examples[0].source`）不应再有尾巴，且带状态字段的行数应为基线总数。
  const remaining = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM words WHERE examples->0->>'source' LIKE $1`,
    [like],
  );
  const finalCleaned = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM words w
      WHERE EXISTS (
              SELECT 1 FROM jsonb_array_elements(w.examples) e
               WHERE e #> '{verified,${PENDING_FIELD}}' = 'true'::jsonb
            )`,
  );
  // 范围外残留（**如实报，不算失败**）：`verified.assertions_avoided` 是产线自检记录
  // （历史事实，先例明写「不动」），里面也写着同一句话。实测 135 行。
  const historical = await pool.query<{ n: string }>(
    `SELECT count(distinct w.id)::text AS n
       FROM words w, jsonb_array_elements(w.examples) e
      WHERE coalesce(e->>'source', '') NOT LIKE $1
        AND (e->'verified')::text LIKE $1`,
    [like],
  );
  if (Number(remaining.rows[0].n) !== 0) {
    throw new Error(
      `终态复查失败：仍有 ${remaining.rows[0].n} 行的 examples[0].source 含「${PENDING_MARKER}」。`,
    );
  }
  if (Number(finalCleaned.rows[0].n) !== EXPECTED_TOTAL) {
    throw new Error(
      `终态复查失败：带 ${PENDING_FIELD} 的行数为 ${finalCleaned.rows[0].n}，期望 ${EXPECTED_TOTAL}。`,
    );
  }
  console.log(
    `终态复查通过：examples[0].source 已 0 行含「${PENDING_MARKER}」，${finalCleaned.rows[0].n} 行带 ${PENDING_FIELD}。`,
  );
  console.log(
    `范围外残留（刻意不动，产线自检记录）：${historical.rows[0].n} 行的 verified.assertions_avoided 里仍含该句 —— ` +
      `那是历史事实记录，不是对外署名。`,
  );
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
