/**
 * 离线回填脚本 —— 为所有 words 记录计算 l1_content_hash / l2_content_hash / content_hash。
 *
 * 用法：npm run db:script:backfill-hashes
 *
 * 分批处理，每批 1000 词。幂等（只处理 l1_content_hash IS NULL 的词）。
 *
 * ## 🔴 必须用 BATCH_IMPORT_DATABASE_URL，不能用 DATABASE_URL
 *
 * 迁移 0025（`0025_word_stub_rowlock_policy.sql`）给 `vocab_app` 建的 UPDATE
 * policy 是 `USING (definition_md = '' AND is_published AND NOT is_deleted)` ——
 * **只允许改 stub 行**。而本脚本要改的全是词库内容行（有真实释义，非 stub），
 * 于是 **UPDATE 命中 0 行且不报错**：Postgres 把它当「行对当前角色不可见」。
 *
 * 这个静默失败已经发生过：脚本用 `getPool()` 跑完会打印
 * 「Done. Total: 6767 words backfilled.」，实际库里 6767 条 hash 全是 NULL。
 * `deriveContentStaleness`（`src/domain/content-staleness.ts`）因此永远走
 * 「全量对」降级路径，L1 专属比对从未启用。
 *
 * 0025 自己的注释已经写明约定：
 *   > there is no app-code path that UPDATEs words (writes go through the
 *   > dedicated batch-import role)
 * 脚本违反的正是这条 —— 而没有任何机制会阻止它再违反一次，所以下面两道防线
 * 与 `tests/scripts/backfill-content-hash.test.ts` 的回归锁是必需的，不是保险。
 *
 * 同型脚本 `scripts/backfill-word-pinyin.ts` 曾是同样的形状（同样用 getPool、
 * 同样无校验），已一并修正。
 */
import { getBatchImportPool } from "../src/db/connection";
import {
  computeL1Hash,
  computeL2Hash,
  computeFullHash,
  type WordForHashing,
} from "../src/db/content-hash";

const BATCH_SIZE = 1000;

export interface HashableWord extends WordForHashing {
  id: string;
}

/**
 * 纯计算，不碰库 —— 单测直接覆盖这一段。
 *
 * 注意这里**没有** `as never`：`WordForHashing` 已从 `src/db/content-hash.ts`
 * 导出，所以本文件用的字段集与 computeL1Hash 期望的入参由编译器保证一致。
 * 之前用 `as never` 是为了绕过「类型不导出」，代价是字段名写错也不会报错。
 */
export function computeHashes(word: HashableWord): {
  l1: string;
  l2: string;
  full: string;
} {
  return {
    l1: computeL1Hash(word),
    l2: computeL2Hash(word),
    full: computeFullHash(word),
  };
}

async function backfill(): Promise<void> {
  // 必须是 batch-import 角色：应用角色改有释义的词条会静默命中 0 行（见文件头）。
  const pool = getBatchImportPool();
  let total = 0;
  let zeroRows = 0;

  while (true) {
    const { rows } = await pool.query(
      `SELECT id, definition_md, core_definitions, prototype_text, metadata,
              collocations, corpus_items, synonym_items, antonym_items
       FROM words
       WHERE l1_content_hash IS NULL
       ORDER BY id
       LIMIT $1`,
      [BATCH_SIZE],
    );

    if (rows.length === 0) break;

    for (const word of rows) {
      const { l1, l2, full } = computeHashes(word);
      const res = await pool.query(
        `UPDATE words
         SET l1_content_hash = $1, l2_content_hash = $2, content_hash = $3
         WHERE id = $4::uuid`,
        [l1, l2, full, word.id],
      );
      // rowCount 必须校验：RLS policy 让行不可见时 Postgres 返回 0 且不报错。
      // 不校验就会重演「打印 Done 但一个字没写」。
      if (res.rowCount !== 1) zeroRows++;
      total++;
    }

    console.log(`Backfilled ${total} words...`);
  }

  if (zeroRows > 0) {
    throw new Error(
      `有 ${zeroRows} 行的 UPDATE 未命中（rowCount=0）。` +
        `请确认连接身份是 vocab_batch_import（BATCH_IMPORT_DATABASE_URL）；` +
        `应用角色 vocab_app 的 UPDATE policy 只放行 stub 行（definition_md=''），` +
        `改词库内容行会静默命中 0 行。`,
    );
  }

  // 写后自检：不能只信「跑完了」，要确认库里真的有值。
  // 三列都要查 —— 只查 l1 的话，l2/full 写失败而 l1 成功会被漏报。
  const { rows: check } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE l1_content_hash IS NULL)::int AS l1_null,
            count(*) FILTER (WHERE l2_content_hash IS NULL)::int AS l2_null,
            count(*) FILTER (WHERE content_hash IS NULL)::int AS full_null
       FROM words WHERE is_deleted = false`,
  );
  const total0 = check[0]?.total ?? 0;
  const l1Null = check[0]?.l1_null ?? 0;
  const l2Null = check[0]?.l2_null ?? 0;
  const fullNull = check[0]?.full_null ?? 0;
  if (l1Null > 0 || l2Null > 0 || fullNull > 0) {
    throw new Error(
      `写后自检失败：仍有 l1=${l1Null} l2=${l2Null} full=${fullNull}（共 ${total0} 条）为 NULL。`,
    );
  }

  console.log(`Done. Total: ${total} words backfilled.`);
  console.log(`Verified: 0/${total0} words still have NULL in any of the 3 hash columns.`);
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("backfill-content-hash.ts");
if (invokedDirectly) {
  backfill()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Backfill failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}