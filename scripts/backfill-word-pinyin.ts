/**
 * 离线回填脚本 —— 为所有 words 记录生成 pinyin / pinyin_initial（中文释义拼音）。
 *
 * 用法：npm run db:script:backfill-pinyin
 *
 * 分批处理，每批 1000 词。幂等（只处理 pinyin IS NULL 的词）。
 * 需在迁移 0015（新增 pinyin 列）应用后运行。
  *
 * ## 🔴 必须用 BATCH_IMPORT_DATABASE_URL，不能用 DATABASE_URL
 *
 * 迁移 0025（`0025_word_stub_rowlock_policy.sql`）给 `vocab_app` 建的 UPDATE
 * policy 是 `USING (definition_md = '' AND is_published AND NOT is_deleted)` ——
 * 只允许改 stub 行。本脚本要改的是词库内容行，于是 **UPDATE 命中 0 行且不报错**。
 *
 * 本脚本历史上躲过了这个坑（pinyin 数据是 0025 之前跑出来的，6767 条全非空），
 * 但那是**时序侥幸**，不是修好了：现在重跑会静默命中 0 行并打印「Done」。
 * 与 `scripts/backfill-content-hash.ts` 是同型问题，那边的静默失败真的发生过
 * （6767 条 hash 全是 NULL）。
 */

import { getBatchImportPool } from "../src/db/connection";
import { computePinyinFromCjk } from "../src/domain/ingest/pinyin";

const BATCH_SIZE = 1000;

async function backfill(): Promise<void> {
  // 必须是 batch-import 角色：应用角色改有释义的词条会静默命中 0 行（见文件头）。
  const pool = getBatchImportPool();
  let total = 0;
  let zeroRows = 0;

  while (true) {
    const { rows } = await pool.query(
      `SELECT id, short_definition, definition_md
       FROM words
       WHERE pinyin IS NULL
       ORDER BY id
       LIMIT $1`,
      [BATCH_SIZE],
    );

    if (rows.length === 0) break;

    for (const word of rows) {
      const { pinyin, pinyinInitial } = computePinyinFromCjk(
        word.short_definition,
        word.definition_md,
      );
      const res = await pool.query(
        `UPDATE words
         SET pinyin = $1, pinyin_initial = $2
         WHERE id = $3::uuid`,
        [pinyin, pinyinInitial, word.id],
      );
      // rowCount 必须校验：RLS 让行不可见时 Postgres 返回 0 且不报错。
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
  const { rows: check } = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE pinyin IS NULL)::int AS pinyin_null,
            count(*) FILTER (WHERE pinyin_initial IS NULL)::int AS initial_null
       FROM words WHERE is_deleted = false`,
  );
  const total0 = check[0]?.total ?? 0;
  const pinyinNull = check[0]?.pinyin_null ?? 0;
  const initialNull = check[0]?.initial_null ?? 0;
  if (pinyinNull > 0 || initialNull > 0) {
    throw new Error(
      `写后自检失败：仍有 pinyin=${pinyinNull} pinyin_initial=${initialNull}（共 ${total0} 条）为 NULL。`,
    );
  }

  console.log(`Done. Total: ${total} words backfilled.`);
  console.log(`Verified: 0/${total0} words still have NULL in either pinyin column.`);
}

backfill()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
