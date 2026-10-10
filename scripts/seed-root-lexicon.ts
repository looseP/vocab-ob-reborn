/**
 * 数据脚本 —— 词根词典 root_lexicon 的 curated 种子（0052 表）。
 *
 * 用法：`npm run db:script:seed-root-lexicon [-- --dry-run]`
 *
 * ## 用途与边界
 *
 * 广场的词根家族聚合是**自生长**的（从 `words.metadata->>'morphology_root'`
 * 实时推导，不改）；本表只补两类**展示增强**信息，未命中时展示降级为现样：
 *
 *   * `meaning_zh`：词根核心义（家族页的语义锚，如 par = 相等；使相等）；
 *   * `variants`：同族变体 token（port/porti、spect/spic —— 词源音变合并，
 *     家族页可跨族跳转）。
 *
 * 数据口径：**通用词源常识**整理的高频词根（首批面向雅思 L1 常见族），
 * token 一律小写拉丁、与 `extractRootTokens`（src/services/plaza.service.ts）
 * 的产物同形；变体仅收录能在本词库真实命中的拼写（宁可少、不可错配）。
 *
 * ## 跑法 —— 必须在栈内、用 migration 角色
 *
 * 数据库不对宿主暴露（`postgres:5432` 只在容器网络内解析），且**本表只有
 * owner（vocab_migration）能写**：RLS 只有 public read policy，vocab_app 仅
 * SELECT（0052 迁移与 bootstrap-database-roles converge 双处授权）。owner
 * 天然绕过 RLS，故用 MIGRATION_DATABASE_URL：
 *
 *   docker run --rm --network vocab-observatory_default \
 *     -v F:/dev/vocab-ob/wt-plaza/scripts:/app/scripts:ro \
 *     -v F:/dev/vocab-ob/wt-plaza/src:/app/src:ro \
 *     -e NODE_ENV=development -e DB_SSLMODE=disable \
 *     -e MIGRATION_DATABASE_URL='postgresql://vocab_migration:...@postgres:5432/vocab' \
 *     -w /app --entrypoint ./node_modules/.bin/tsx \
 *     vocab-observatory-v2:local scripts/seed-root-lexicon.ts [--dry-run]
 *
 * ## 幂等
 *
 * 全量 upsert（ON CONFLICT (token) DO UPDATE），重复执行收敛到同一终态；
 * `--dry-run` 全程 BEGIN + ROLLBACK，只报告不落库。
 */

import { Pool } from "pg";

/**
 * 释义分支（2026-10-10）：一个词根常有多个词源支（par 等同 / parare 备好 /
 * parere 显现），每支各自扩展出一批词。`words` 是该支的**代表词例**（lemma，
 * 必须在词库真实存在——写入前用词库校验，宁少不错）；家族页按「分支 → 词例」
 * 成对渲染。存储在 `root_lexicon.notes`（JSON 字符串，该列 seed 前闲置）。
 */
export interface RootLexiconSense {
  /** 分支释义（含拉丁原形注记，如「备好（拉丁 parare）」）。 */
  meaning: string;
  /** 该支扩展出的代表词（lemma）。 */
  words: string[];
}

export interface RootLexiconSeedEntry {
  /** 规范词根（canonical，小写拉丁，与词库 token 同形）。 */
  token: string;
  /** 核心义（中文，家族页语义锚）。 */
  meaningZh: string;
  /** 同族变体 token（可为空数组；不含自身）。 */
  variants: string[];
  /** 释义分支 → 词例（可选；缺省时家族页走通用降级展示）。 */
  senses?: RootLexiconSense[];
}

/**
 * 首批 curated 词根（47 条）。排序仅按主题聚类，与执行无关。
 * 维护纪律：新增/修改前先对照词库实际 token（见脚本尾部命中报告）。
 */
export const ROOT_LEXICON_SEED: RootLexiconSeedEntry[] = [
  // 动作类：拿/送/放/转/看/说/写
  { token: "port", meaningZh: "携带；搬运", variants: ["porti"] },
  { token: "fer", meaningZh: "带来；承载", variants: [] },
  { token: "mit", meaningZh: "送；放出", variants: ["miss"] },
  { token: "ject", meaningZh: "投掷", variants: [] },
  { token: "pon", meaningZh: "放置", variants: ["pos", "posit"] },
  { token: "tract", meaningZh: "拉；拖", variants: [] },
  { token: "press", meaningZh: "压", variants: [] },
  { token: "vert", meaningZh: "转", variants: ["vers"] },
  { token: "volv", meaningZh: "滚；转", variants: ["volut"] },
  { token: "mov", meaningZh: "移动", variants: ["mot", "mob"] },
  { token: "spect", meaningZh: "看；观察", variants: ["spic"] },
  { token: "vid", meaningZh: "看", variants: ["vis"] },
  { token: "dict", meaningZh: "说；讲", variants: [] },
  { token: "scrib", meaningZh: "写", variants: ["script"] },
  { token: "graph", meaningZh: "写；画；记录", variants: ["gram"] },
  { token: "leg", meaningZh: "选；读；法律", variants: ["lect", "lig"] },

  // 拿取/持有/抓住
  { token: "cap", meaningZh: "拿；抓；头", variants: ["capit", "cept", "cip"] },
  { token: "ten", meaningZh: "持有；保持", variants: ["tain"] },
  { token: "prehend", meaningZh: "抓住", variants: ["prehens"] },

  // 引导/走/切割/断裂
  { token: "duce", meaningZh: "引导；带领", variants: ["duct"] },
  { token: "cede", meaningZh: "走；让步", variants: ["ceed", "cess"] },
  { token: "sect", meaningZh: "切割", variants: ["seg"] },
  { token: "frag", meaningZh: "破碎", variants: ["fract"] },
  { token: "rupt", meaningZh: "断裂", variants: [] },
  { token: "solv", meaningZh: "松开；解开", variants: ["solut"] },

  // 建造/形状/测量/标准
  { token: "struct", meaningZh: "建造", variants: [] },
  { token: "form", meaningZh: "形状；形成", variants: [] },
  { token: "meter", meaningZh: "测量", variants: ["metr"] },

  // 相信/价值
  { token: "cred", meaningZh: "相信", variants: [] },
  { token: "fid", meaningZh: "信任；忠诚", variants: [] },
  { token: "val", meaningZh: "价值；强壮", variants: ["vail"] },

  // 生命/死/心/身/手/脚
  { token: "bio", meaningZh: "生命", variants: [] },
  { token: "viv", meaningZh: "活；生命", variants: ["vit"] },
  { token: "anim", meaningZh: "生命；精神", variants: [] },
  { token: "mort", meaningZh: "死", variants: [] },
  { token: "cord", meaningZh: "心", variants: ["cardi"] },
  { token: "corp", meaningZh: "身体", variants: ["corpor"] },
  { token: "man", meaningZh: "手", variants: ["manu"] },
  { token: "ped", meaningZh: "脚；儿童", variants: ["pod"] },

  // 自然/科学
  { token: "geo", meaningZh: "地球；土地", variants: [] },
  { token: "hydr", meaningZh: "水", variants: [] },
  { token: "therm", meaningZh: "热", variants: ["thermo"] },
  { token: "phon", meaningZh: "声音", variants: [] },
  { token: "tele", meaningZh: "远", variants: [] },

  // 时间/感受
  { token: "chron", meaningZh: "时间", variants: [] },
  { token: "tempor", meaningZh: "时间", variants: [] },
  { token: "path", meaningZh: "感觉；情感；疾病", variants: [] },

  // ── 2026-10-10 增补批（29 条）：广场家族页按归一化口径实测「有家族、无词典」
  // 的真词根（家族 ≥7；英文主题词 / 误标值如 day / work / latin / 拉丁语 一律不收）。
  // variants 只收录已在词库真实命中的拼写；senses 词例全部经词库存在性校验。
  {
    token: "par",
    meaningZh: "相等；备好；显现（par「等同」/ parare「备好」/ parere「显现、生育」三支同源）",
    variants: ["parere"],
    senses: [
      { meaning: "等同（拉丁 par）", words: ["compare", "comparison", "pair", "peer", "parity"] },
      { meaning: "备好（拉丁 parare）", words: ["repair", "prepare", "apparatus", "separate", "parade"] },
      { meaning: "显现、生育（拉丁 parere）", words: ["appear", "apparent", "parent"] },
    ],
  },
  {
    token: "facere",
    meaningZh: "做；制作（fac / fact / fic 同族）",
    variants: ["fac", "fact", "fic"],
    senses: [
      { meaning: "做、造（fac / fact）", words: ["factory", "factor", "manufacture", "facility"] },
      { meaning: "向…做（fect，factum）", words: ["affect", "effect", "perfect", "defect"] },
    ],
  },
  {
    token: "fact",
    meaningZh: "做；已做成之事（facere 的分词 factum）",
    variants: ["fac", "facere"],
    senses: [
      { meaning: "已做成之事（factum）", words: ["affect", "effect", "perfect", "defect"] },
    ],
  },
  {
    token: "fic",
    meaningZh: "做；使成为（facere 的音变）",
    variants: ["fac", "fact"],
    senses: [
      { meaning: "使成为…的（ficus）", words: ["sufficient", "efficient", "artificial", "fiction", "benefit"] },
    ],
  },
  {
    token: "dare",
    meaningZh: "给；给予（data / date / donate 同族）",
    variants: [],
    senses: [
      { meaning: "给予（dare）", words: ["data", "date", "donate", "tradition", "edit"] },
    ],
  },
  {
    token: "late",
    meaningZh: "带来；宽广（latus，ferre「带来」的分词）",
    variants: [],
    senses: [
      { meaning: "带回、传送（latus）", words: ["relate", "relation", "relative", "translate"] },
    ],
  },
  {
    token: "plic",
    meaningZh: "折叠（plicare）",
    variants: [],
    senses: [
      { meaning: "折向、叠合（plicare）", words: ["apply", "applicant", "application", "complicate", "replicate", "reply", "imply"] },
    ],
  },
  {
    token: "legere",
    meaningZh: "读；收集；挑选（lect 同族）",
    variants: ["lect"],
    senses: [
      { meaning: "收集、挑选、读（legere / lect）", words: ["lecture", "select", "collect", "elect", "election", "legend"] },
    ],
  },
  {
    token: "log",
    meaningZh: "词；理性；学说（希腊 logos）",
    variants: [],
    senses: [
      { meaning: "说话、道理（logos）", words: ["dialogue", "logic", "biology", "technology", "psychology", "apology"] },
    ],
  },
  {
    token: "tendere",
    meaningZh: "伸展；趋向",
    variants: [],
    senses: [
      { meaning: "伸向（tendere）", words: ["tend", "tendency", "attend", "attention", "extend", "pretend", "intense"] },
    ],
  },
  {
    token: "pos",
    meaningZh: "放置；摆（ponere 分支）",
    variants: [],
    senses: [
      { meaning: "摆放（ponere）", words: ["compose", "component", "position", "deposit", "purpose", "postpone", "oppose", "expose"] },
    ],
  },
  {
    token: "vis",
    meaningZh: "看（videre 分支）",
    variants: ["vid"],
    senses: [
      { meaning: "看（videre / vid）", words: ["visible", "vision", "video", "evident", "provide", "review", "revise", "survey"] },
    ],
  },
  {
    token: "ducere",
    meaningZh: "引导；带领（duce / duct 同族）",
    variants: ["duct"],
    senses: [
      { meaning: "引导（ducere / duct）", words: ["educate", "reduce", "produce", "product", "introduce", "conduct"] },
    ],
  },
  {
    token: "ced",
    meaningZh: "走；让步（cedere）",
    variants: ["cess"],
    senses: [
      { meaning: "走、退让（cedere / cess）", words: ["proceed", "succeed", "success", "concede", "exceed"] },
    ],
  },
  {
    token: "sist",
    meaningZh: "站立；安置（sistere）",
    variants: ["stat"],
    senses: [
      { meaning: "站在…（sistere）", words: ["assist", "persist", "resist", "insist", "consist"] },
    ],
  },
  {
    token: "stare",
    meaningZh: "站立（sta / stat 系）",
    variants: ["stat", "sist"],
    senses: [
      { meaning: "站立（stare / stat）", words: ["stable", "statue", "status", "state", "obstacle"] },
    ],
  },
  {
    token: "pet",
    meaningZh: "追求；寻求（petere）",
    variants: [],
    senses: [
      { meaning: "朝…冲、求取（petere）", words: ["compete", "competition", "petition", "appetite", "repeat"] },
    ],
  },
  {
    token: "part",
    meaningZh: "部分（pars / parti-）",
    variants: [],
    senses: [
      { meaning: "一部分（pars）", words: ["partial", "participate", "particular", "partner", "apartment"] },
    ],
  },
  {
    token: "ven",
    meaningZh: "来（venire）",
    variants: [],
    senses: [
      { meaning: "来到（venire）", words: ["prevent", "invent", "event", "convene", "revenue"] },
    ],
  },
  {
    token: "miss",
    meaningZh: "送；放出（mittere 的分词 missum）",
    variants: ["mit"],
    senses: [
      { meaning: "送出（mittere / missum）", words: ["mission", "dismiss", "admit", "permit", "submit"] },
    ],
  },
  {
    token: "pend",
    meaningZh: "悬挂；称量；支付（pendere）",
    variants: [],
    senses: [
      { meaning: "挂着、称量（pendere）", words: ["depend", "suspend", "spend", "expense", "pension"] },
    ],
  },
  {
    token: "cern",
    meaningZh: "筛分；辨明（cernere）",
    variants: [],
    senses: [
      { meaning: "筛分、看清（cernere）", words: ["discern", "concern", "certain", "secret"] },
    ],
  },
  {
    token: "capere",
    meaningZh: "拿取（cap / capt / cept / cip 同族）",
    variants: ["capt", "cept", "cip"],
    senses: [
      { meaning: "拿、取（capere 及其分词 capt/cept）", words: ["capture", "capable", "accept", "recipe", "occupy"] },
    ],
  },
  {
    token: "specere",
    meaningZh: "看；观察（spect / spic 同族）",
    variants: ["spect", "spic"],
    senses: [
      { meaning: "看、注视（specere / spect）", words: ["inspect", "respect", "suspect", "spectator", "prospect"] },
    ],
  },
  {
    token: "put",
    meaningZh: "思考；计算（putare）",
    variants: [],
    senses: [
      { meaning: "计算、认为（putare）", words: ["compute", "dispute", "reputation", "deputy"] },
    ],
  },
  {
    token: "mod",
    meaningZh: "量度；方式（modus）",
    variants: [],
    senses: [
      { meaning: "合乎尺度（modus）", words: ["model", "modify", "moderate", "accommodate"] },
    ],
  },
  {
    token: "lev",
    meaningZh: "轻；举起（levis / levare）",
    variants: [],
    senses: [
      { meaning: "变轻、举起（levare）", words: ["relieve", "elevate", "elevator", "leverage"] },
    ],
  },
  {
    token: "ag",
    meaningZh: "做；驱动（agere）",
    variants: ["act"],
    senses: [
      { meaning: "驱动、做（agere）", words: ["action", "agent", "agenda", "agile", "exact"] },
    ],
  },
  {
    token: "sign",
    meaningZh: "标记（signum）",
    variants: [],
    senses: [
      { meaning: "做标记（signare）", words: ["signal", "design", "signature", "assign", "significant"] },
    ],
  },
];

const TOKEN_PATTERN = /^[a-z]{2,}$/;

/**
 * 种子数据自检（纯函数，供单测）。
 * 与 `extractRootTokens` 的过滤口径一致：token/变体必须是 [a-z]{2,}。
 */
export function validateRootLexiconSeed(entries: RootLexiconSeedEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!TOKEN_PATTERN.test(entry.token)) {
      problems.push(`token 非法（须为 [a-z]{2,}）：${JSON.stringify(entry.token)}`);
    }
    if (seen.has(entry.token)) {
      problems.push(`token 重复：${entry.token}`);
    }
    seen.add(entry.token);
    if (!entry.meaningZh.trim()) {
      problems.push(`核心义为空：${entry.token}`);
    }
    const variantSeen = new Set<string>();
    for (const variant of entry.variants) {
      if (!TOKEN_PATTERN.test(variant)) {
        problems.push(`变体非法（须为 [a-z]{2,}）：${entry.token} -> ${JSON.stringify(variant)}`);
      }
      if (variant === entry.token) {
        problems.push(`变体不得是自身：${entry.token}`);
      }
      if (variantSeen.has(variant)) {
        problems.push(`变体重复：${entry.token} -> ${variant}`);
      }
      variantSeen.add(variant);
    }
    const senseSeen = new Set<string>();
    for (const sense of entry.senses ?? []) {
      if (!sense.meaning.trim()) {
        problems.push(`分支释义为空：${entry.token}`);
      }
      if (sense.words.length === 0) {
        problems.push(`分支词例为空：${entry.token} -> ${sense.meaning}`);
      }
      for (const word of sense.words) {
        const normalized = word.trim().toLowerCase();
        if (!normalized || senseSeen.has(normalized)) {
          problems.push(`分支词例为空或重复：${entry.token} -> ${JSON.stringify(word)}`);
        }
        senseSeen.add(normalized);
      }
    }
  }
  return problems;
}

// notes 列存释义分支 JSON（senses；seed 前该列闲置）。无 senses 时写 NULL，
// 幂等语义：重复执行收敛到同一终态（包括"清掉手写的坏 notes"）。
const UPSERT_SQL = `
  INSERT INTO root_lexicon (token, meaning_zh, variants, notes, updated_at)
  VALUES ($1, $2, $3::text[], $4::text, now())
  ON CONFLICT (token) DO UPDATE SET
    meaning_zh = EXCLUDED.meaning_zh,
    variants = EXCLUDED.variants,
    notes = EXCLUDED.notes,
    updated_at = now()
`;

/** 词库当前真实出现的全部词根 token（与聚合 SQL 同口径）。 */
async function fetchLibraryTokens(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ token: string }>(
    `SELECT DISTINCT btrim(lower(substring(btrim(part) FROM '^[^ (（+]+'))) AS token
     FROM words w
     CROSS JOIN LATERAL unnest(string_to_array(w.metadata->>'morphology_root', '+')) AS part
     WHERE w.is_published = true AND w.is_deleted = false AND w.definition_md <> ''
       AND w.metadata->>'morphology_root' IS NOT NULL
       AND w.metadata->>'morphology_root' NOT IN ('', 'EMPTY')`,
  );
  return new Set(result.rows.map((row) => row.token).filter((token) => TOKEN_PATTERN.test(token)));
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "MIGRATION_DATABASE_URL is not configured. root_lexicon 的 owner 是 vocab_migration" +
        "（RLS 仅 public read；vocab_app / vocab_batch_import 均无写权），seed 必须以" +
        " migration 角色执行 —— 参见本文件头部『跑法』。",
    );
  }

  const problems = validateRootLexiconSeed(ROOT_LEXICON_SEED);
  if (problems.length > 0) {
    throw new Error(`种子数据自检未通过（${problems.length} 条）：\n  - ${problems.join("\n  - ")}`);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const libraryTokens = await fetchLibraryTokens(pool);
    const matched = ROOT_LEXICON_SEED.filter(
      (entry) =>
        libraryTokens.has(entry.token) || entry.variants.some((variant) => libraryTokens.has(variant)),
    );

    await pool.query("BEGIN");
    for (const entry of ROOT_LEXICON_SEED) {
      await pool.query(UPSERT_SQL, [
        entry.token,
        entry.meaningZh,
        entry.variants,
        entry.senses ? JSON.stringify(entry.senses) : null,
      ]);
    }
    if (dryRun) {
      await pool.query("ROLLBACK");
    } else {
      await pool.query("COMMIT");
    }

    const total = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM root_lexicon");
    console.log(
      `[seed-root-lexicon] ${dryRun ? "DRY-RUN（已回滚）" : "已写入"} ${ROOT_LEXICON_SEED.length} 条；` +
        `词库命中 ${matched.length} 条（含变体命中）；表内现有 ${total.rows[0]?.count ?? "?"} 条。`,
    );
    const unmatched = ROOT_LEXICON_SEED.filter(
      (entry) =>
        !libraryTokens.has(entry.token) && !entry.variants.some((variant) => libraryTokens.has(variant)),
    );
    if (unmatched.length > 0) {
      console.log(
        `[seed-root-lexicon] 词库未命中 ${unmatched.length} 条（保留待词库扩充后生效）：` +
          unmatched.map((entry) => entry.token).join(", "),
      );
    }
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith("seed-root-lexicon.ts");
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`[seed-root-lexicon] FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
