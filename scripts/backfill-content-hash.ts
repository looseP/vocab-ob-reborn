/**
 * 离线回填脚本 —— 为所有 words 记录计算 l1_content_hash / l2_content_hash / content_hash。
 *
 * 用法：npm run db:script:backfill-hashes
 *
 * 分批处理，每批 1000 词。幂等（只处理 l1_content_hash IS NULL 的词）。
 */
import { getPool } from "../src/db/connection";
import { computeL1Hash, computeL2Hash, computeFullHash } from "../src/db/content-hash";

const BATCH_SIZE = 1000;

async function backfill(): Promise<void> {
  const pool = getPool();
  let total = 0;

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
      const l1Hash = computeL1Hash(word);
      const l2Hash = computeL2Hash(word);
      const fullHash = computeFullHash(word);
      await pool.query(
        `UPDATE words
         SET l1_content_hash = $1, l2_content_hash = $2, content_hash = $3
         WHERE id = $4::uuid`,
        [l1Hash, l2Hash, fullHash, word.id],
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
