/**
 * 离线回填脚本 —— 把「语料里真实出现、但点不开」的屈折/所有格形式登记进 words.aliases。
 *
 * 用法：npm run db:script:backfill-aliases [-- --dry-run]
 *
 * ## 为什么需要它
 *
 * `words.aliases` 承担查词时的变体命中（`word.repository.ts` 的 P1-5 分层：
 * lemma → slug → title → aliases，aliases 走 ILIKE）。但登记是**手工且不一致**的：
 *
 *   abandon  -> abandons, abandoned, abandoning   ✓ 屈折形式齐全
 *   hospital -> hospice, hostel, hotel             ✗ 没有 hospitals
 *   system   -> (空)                               ✗ 什么都没有
 *
 * 结果（**2026-09-30 实测，时点须写清**）：
 *   补登前  6767 词里有 1712 个 aliases 为空数组，其中 1491 个长度 ≥ 5
 *   补登后  1698 个为空（本次 26 个形式落在 15 个原为空的词条上）
 * 也就是最该有屈折形式的那些词反而一个都没有。语料里读到 `hospitals` 点进去
 * 就是 404，尽管 `hospital` 就在库里。
 *
 * ## 范围（刻意保守）
 *
 * 本脚本**不生成**屈折形式，只消费一份显式清单
 * `data/word-aliases/2025-en2-inflections.json`。清单里每一条都是对真实语料
 * （2025 考研英语（二）6 篇文章 + 48 题）实测出来的、逐条人工确认过的缺口。
 *
 * 之所以不写形态学生成器：那 1491 个（补登前口径）空 aliases 词才是真正的洞，
 * 但批量生成屈折形式要形态学正确性保证（不规则变化、`e` 结尾吞 `e`、y→ies、
 * 双写辅音……），
 * 猜错就会往库里写脏数据。宁可先补实测确认的，剩下的单独立项。
 *
 * ## 跑法 —— 必须用 batch-import 角色，不能用应用角色
 *
 * 数据库不对宿主暴露，要**在栈内跑**（`postgres:5432` 才解析得到）：
 *
 *   docker compose run --rm -v "<repo>/data:/app/data:ro" \
 *     -e NODE_ENV=development -e DB_SSLMODE=disable \
 *     -e BATCH_IMPORT_DATABASE_URL='postgresql://vocab_batch_import:...@postgres:5432/vocab' \
 *     web npx tsx scripts/backfill-word-aliases.ts [--dry-run]
 *
 * **为什么必须是 `BATCH_IMPORT_DATABASE_URL` 而不是 `DATABASE_URL`**：
 * 迁移 0025 给 `vocab_app` 建的 UPDATE policy 是
 * `USING (definition_md = '' AND is_published AND NOT is_deleted)` —— 只允许改
 * stub 行。而本脚本要改的 25 个基词全都有真实释义（非 stub），于是
 * UPDATE 命中 0 行且不报错：Postgres 把它当「行对当前角色不可见」，
 * rowCount = 0，脚本若不查 rowCount 就会一路报「写入成功」。
 * （这条 policy 的存在有其必要：运行时角色只该改 stub，词库内容写入要走
 * 专用通道 —— 见 `0025_word_stub_rowlock_policy.sql` 与
 * `scripts/import-vocab-notes.ts` 的同款约定。）
 *
 * 换角色后 `rowCount = 0` 就真的是异常，本脚本会据此报错并回滚。
 *
 * 清单默认在仓库内 `data/word-aliases/`；生产镜像不含 `data/`，栈内跑时要靠
 * 挂载把数据送进去，或用 `WORD_ALIASES_PATH` 指向别处。
 *
 * ## 幂等
 *
 * 逐条按 `lemma` 取当前 aliases，已存在该形式则跳过（不算已改）。整个回填在
 * **单个事务**里执行：任何一条基词不存在就整体回滚，不留半截数据。重复执行
 * 第二次必然是 0 改动。
 *
 * ## 安全性
 *
 * - 只 UPDATE `aliases` 一列，不动 definition / core_definitions / examples。
 * - `aliases` **不参与 content_hash**（`src/db/content-hash.ts`：L1 = 释义/词根/
 *   记忆锚点/语义链，L2 = 搭配/语料/同义/反义），所以补登不会造成哈希漂移，
 *   不会让任何 L1 复习卡被判为「内容已变」而失效。
 * - 不新增词条行 —— 26 个形式都没有独立的 lemma/slug，补登不产生「两个词条
 *   争同一个形式」的歧义（清单落库前已逐条验证）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBatchImportPool } from "../src/db/connection";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = path.join(here, "..", "data", "word-aliases", "2025-en2-inflections.json");

export type InflectionKind =
  | "plural"
  | "past"
  | "gerund"
  | "third-person"
  | "possessive";

export interface ManifestEntry {
  form: string;
  lemma: string;
  kind: InflectionKind;
}

export interface Manifest {
  meta?: Record<string, unknown>;
  entries: ManifestEntry[];
}

export interface ExistingRow {
  lemma: string;
  aliases: string[];
}

export type PlanAction = "append" | "already-present";

export interface PlanEntry {
  form: string;
  lemma: string;
  kind: InflectionKind;
  action: PlanAction;
}

export interface LemmaUpdate {
  lemma: string;
  /** 补登前的 aliases（原样） */
  before: string[];
  /** 补登后的 aliases —— 同一 lemma 的多个形式已累积进去 */
  after: string[];
}

export interface Plan {
  entries: PlanEntry[];
  appends: PlanEntry[];
  alreadyPresent: PlanEntry[];
  /** 每个需要写入的 lemma 的终态；同一 lemma 只出现一次 */
  lemmaUpdates: LemmaUpdate[];
  /** 清单里 lemma 在库中不存在的项 —— 非空即应整体拒绝执行 */
  missingLemmas: string[];
  /** 清单自身的形式级问题（重复项、空串、形式与基词相同） */
  invalidEntries: string[];
}

/** 清单自身校验：与库无关，纯粹是「这份数据站不站得住」。 */
export function validateManifest(manifest: Manifest): string[] {
  const problems: string[] = [];
  if (!Array.isArray(manifest?.entries) || manifest.entries.length === 0) {
    return ["清单 entries 为空"];
  }
  const seenForms = new Set<string>();
  for (const [i, e] of manifest.entries.entries()) {
    const at = `entries[${i}]`;
    if (!e || typeof e.form !== "string" || typeof e.lemma !== "string") {
      problems.push(`${at} 缺少 form/lemma 字符串字段`);
      continue;
    }
    const form = e.form.trim();
    const lemma = e.lemma.trim();
    if (!form) problems.push(`${at} form 为空`);
    if (!lemma) problems.push(`${at} lemma 为空`);
    if (form && lemma && form.toLowerCase() === lemma.toLowerCase()) {
      problems.push(`${at} 形式与基词相同（${form}）—— 补登无意义`);
    }
    const key = form.toLowerCase();
    if (seenForms.has(key)) problems.push(`${at} 形式重复：${form}`);
    seenForms.add(key);
  }
  return problems;
}

/**
 * 把清单 + 库现状算成一份执行计划。**纯函数**，不碰数据库，所以单测能直接覆盖。
 *
 * 大小写：aliases 里大小写混存是既有事实（`Marxists` / `Realtor` / `Junes`），
 * 而命中判定走 ILIKE，所以判重按小写比；写入时对**新增**项一律小写，
 * 不动已有项的大小写。
 */
export function planAliasBackfill(manifest: Manifest, rows: ExistingRow[]): Plan {
  const invalidEntries = validateManifest(manifest);
  const byLemma = new Map(rows.map((r) => [r.lemma, r.aliases ?? []]));

  const entries: PlanEntry[] = [];
  const missingLemmas = new Set<string>();
  const seenForms = new Set<string>();
  // 同一 lemma 可能要补多个形式（introduce → introduced / introducing），
  // 终态在这里累积，避免后一条把前一条挤掉。
  const accumulated = new Map<string, LemmaUpdate>();

  for (const e of manifest.entries) {
    const form = e.form.trim();
    const lemma = e.lemma.trim();
    if (!form || !lemma) continue;
    if (seenForms.has(form.toLowerCase())) continue;
    seenForms.add(form.toLowerCase());

    if (!byLemma.has(lemma)) {
      missingLemmas.add(lemma);
      continue;
    }
    const before = [...(byLemma.get(lemma) ?? [])];
    const already = before.some((a) => a.trim().toLowerCase() === form.toLowerCase());
    entries.push({ form, lemma, kind: e.kind, action: already ? "already-present" : "append" });
    if (already) continue;

    const acc = accumulated.get(lemma) ?? { lemma, before, after: [...before] };
    if (!accumulated.has(lemma)) accumulated.set(lemma, acc);
    acc.after.push(form.toLowerCase());
  }

  return {
    entries,
    appends: entries.filter((e) => e.action === "append"),
    alreadyPresent: entries.filter((e) => e.action === "already-present"),
    lemmaUpdates: [...accumulated.values()].sort((a, b) => a.lemma.localeCompare(b.lemma)),
    missingLemmas: [...missingLemmas].sort(),
    invalidEntries,
  };
}

function resolveManifestPath(): string {
  const override = process.env.WORD_ALIASES_PATH;
  return override ? path.resolve(override) : DEFAULT_MANIFEST;
}

function fmtAliases(list: string[], cap = 56): string {
  if (list.length === 0) return "(空)";
  const joined = list.join(", ");
  return joined.length <= cap ? joined : `${joined.slice(0, cap - 1)}…`;
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

  const lemmas = [...new Set(manifest.entries.map((e) => e.lemma.trim()))];
  // 必须是 batch-import 角色：应用角色的 UPDATE policy 只放行 stub 行，
  // 改有释义的词条会静默命中 0 行（见文件头「跑法」一节）。
  const pool = getBatchImportPool();
  const { rows } = await pool.query<{ lemma: string; aliases: string[] }>(
    `SELECT lemma, aliases FROM words WHERE lemma = ANY($1::text[])`,
    [lemmas],
  );
  const existing: ExistingRow[] = rows.map((r) => ({ lemma: r.lemma, aliases: r.aliases ?? [] }));
  const plan = planAliasBackfill(manifest, existing);

  console.log(`清单：${manifestPath}`);
  console.log(`条目：${manifest.entries.length} 条 / ${lemmas.length} 个基词`);
  console.log(`库现状：命中 ${existing.length} 个基词，缺 ${plan.missingLemmas.length} 个`);

  // 基词缺失 = 清单与库不同步（词表换过 / 清单写错）。此时整体拒绝，不写半截。
  if (plan.missingLemmas.length > 0) {
    throw new Error(
      `以下基词在 words 表中不存在，整体拒绝执行（不写入任何数据）：\n  - ${plan.missingLemmas.join("\n  - ")}`,
    );
  }

  console.log("");
  console.log(`将补登 ${plan.appends.length} 条，已存在跳过 ${plan.alreadyPresent.length} 条`);
  for (const u of plan.lemmaUpdates) {
    const forms = plan.appends.filter((e) => e.lemma === u.lemma);
    const kinds = [...new Set(forms.map((e) => e.kind))].join("/");
    console.log(`  + ${u.lemma.padEnd(12)} [${kinds}]  ${fmtAliases(u.before)}  ⇒  ${fmtAliases(u.after)}`);
  }
  for (const e of plan.alreadyPresent) {
    console.log(`  = ${e.form.padEnd(14)} → ${e.lemma.padEnd(12)} [${e.kind}]  已存在，跳过`);
  }

  if (dryRun) {
    console.log("");
    console.log("[dry-run] 未写入任何数据。去掉 --dry-run 即执行。");
    return;
  }

  if (plan.lemmaUpdates.length === 0) {
    console.log("");
    console.log("无需改动（幂等：本次清单已全部登记过）。");
    return;
  }

  // 单事务：要么全部写入，要么全不写。
  //
  // **必须校验 rowCount**。Postgres 对「RLS policy 让行不可见」的 UPDATE 返回
  // rowCount=0 且不报错 —— 迁移 0025 的 words_stub_update_app 只放行 stub 行，
  // 用应用角色改有释义的词条就会静默命中 0 行。曾经真的踩过：脚本一路打印
  // 「已写入 25 个词条」，实际库里一个字节都没变。
  const zeroRows: string[] = [];
  // 注意：**写入必须用 batch-import 连接**。`withTransaction` 内部走
  // `getPool()`（应用角色），不能直接拿 batch-import 的 client 开事务 ——
  // 那样会绕过角色约定。正确做法是把 batch-import 的 client 显式传进回调，
  // 由本脚本自己控制 BEGIN/COMMIT。
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const u of plan.lemmaUpdates) {
      const res = await client.query(
        `UPDATE words SET aliases = $1::text[] WHERE lemma = $2`,
        [u.after, u.lemma],
      );
      if (res.rowCount !== 1) zeroRows.push(`${u.lemma}(rowCount=${res.rowCount})`);
    }
    if (zeroRows.length > 0) {
      await client.query("ROLLBACK");
      throw new Error(
        `以下 lemma 的 UPDATE 未命中任何行，事务已回滚：\n  - ${zeroRows.join("\n  - ")}\n` +
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
  console.log(
    `已写入 ${plan.lemmaUpdates.length} 个词条的 aliases` +
      `（新增形式 ${plan.appends.length} 个，涉及 lemma ${plan.lemmaUpdates.length} 个）。`,
  );

  // 写后自检：重读一遍，确认每个形式都真的落库了。
  const verify = await pool.query<{ aliases: string[] }>(
    `SELECT aliases FROM words WHERE lemma = ANY($1::text[])`,
    [lemmas],
  );
  const landed = new Set(verify.rows.flatMap((r) => (r.aliases ?? []).map((a) => a.toLowerCase())));
  const notLanded = plan.appends.map((e) => e.form).filter((f) => !landed.has(f.toLowerCase()));
  if (notLanded.length > 0) {
    throw new Error(`写后自检失败，以下形式未落库：${notLanded.join(", ")}`);
  }
  console.log(`写后自检通过：${plan.appends.length} 个形式全部可查。`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
