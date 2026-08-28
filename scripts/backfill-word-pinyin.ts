/**
 * 离线回填脚本 —— 为所有 words 记录生成 pinyin / pinyin_initial（中文释义拼音）。
 *
 * 用法：npm run db:script:backfill-pinyin
 *
 * 分批处理，每批 1000 词。幂等（只处理 pinyin IS NULL 的词）。
 * 需在迁移 0015（新增 pinyin 列）应用后运行。
 */
import { getPool } from "../src/db/connection";
import { computePinyinFromCjk } from "../src/domain/ingest/pinyin";

const BATCH_SIZE = 1000;

async function backfill(): Promise<void> {
  const pool = getPool();
  let total = 0;

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
      await pool.query(
        `UPDATE words
         SET pinyin = $1, pinyin_initial = $2
         WHERE id = $3::uuid`,
        [pinyin, pinyinInitial, word.id],
      );
      total++;
    }

    console.log(`Backfilled ${total} words...`);
  }

  console.log(`Done. Total: ${total} words backfilled.`);
}

backfill()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  });
