/**
 * 2025 考研英语（二）试卷 seed —— 建 6 篇文章来源 + 1 份 48 题试卷。
 *
 * ## 这份数据从哪来
 *
 * 原始 PDF 已不在本机。`data/l3-papers/2025-kaoyan-en2/pdf-fulltext.txt` 是当时
 * 的 PDF 全文抽取（177,224 字，含其他题型与页眉页脚噪声），`paper.json` 是从它
 * 里**手工筛出**的 6 篇文章正文（14,930 字）+ 48 道题。抽取脚本是一次性的
 * （`tmp-extract-pdf.py` / `tmp-parse-2025.py`，2026-09-30 随其它 tmp 产物一并
 * 清理），**已不可重跑** —— 所以 `pdf-fulltext.txt` 必须留在版本库里：它是这批
 * 选题的**唯一溯源依据**。将来要补 Text 5 或订正某题，只能回到它。
 *
 * ## 跑法
 *
 * 数据库不对宿主暴露，所以要**在栈内跑**（`postgres:5432` 才解析得到）：
 *
 *   docker compose exec -T -e NODE_ENV=development -e DB_SSLMODE=disable \
 *     web npx tsx scripts/seed-l3-paper-2025-en2.ts [--dry-run]
 *
 * 连接串走 `DATABASE_URL`（`src/db/connection.ts` 只认这一个变量名）。栈内 `web`
 * 容器自带该变量，通常无需显式传。
 *
 * ## 幂等
 *
 * 试卷按标题存在性判重，重复执行直接退出（不覆盖、不追加题目）。**这是有意的**：
 * 试卷一旦被做过（attempts），覆盖重建会毁掉作答记录。
 *
 * ## actor
 *
 * 传 `{ role: "owner" }`：owner 建卷题目直接落 `active`（ADR-0037）。若传
 * `agent`，48 道题会全进 `pending` 等审 —— 对「已定稿的真考卷」是错的。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Json } from "../src/domain";
import { createRepositories } from "../src/repositories/factory";
import { L3ContextService } from "../src/services/l3-context.service";
import { L3PaperService } from "../src/services/l3-paper.service";
import { withTransaction } from "../src/db/transaction";

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.join(here, "..", "data", "l3-papers", "2025-kaoyan-en2", "paper.json");
const OWNER_ID = "00000000-0000-4000-8000-000000000001";

/**
 * seed 数据位置。默认在仓库内 `data/`；生产镜像不含 `data/`（运行镜像刻意最小化，
 * 只白名单拷了本脚本），所以栈内跑时要靠挂载把数据送进去：
 *
 *   docker compose run --rm -v "<repo>/data:/app/data:ro" \
 *     -e NODE_ENV=development -e DB_SSLMODE=disable \
 *     web npx tsx scripts/seed-l3-paper-2025-en2.ts
 */
function resolveSeedPath(): string {
  const override = process.env.L3_PAPER_SEED_PATH;
  return override ? path.resolve(override) : SEED_PATH;
}

type QuestionType =
  | "cloze" | "reading_choice" | "new_question"
  | "sentence_translation" | "short_essay" | "long_essay" | "grammar_blank";

interface SeedQuestion {
  ordinal: number;
  stem: string;
  options: Array<{ key: string; text: string }>;
  answer: Record<string, unknown>;
  explanation: string;
}

interface SeedSection {
  title: string;
  questionType: QuestionType;
  sourceKey?: string;
  fileKey?: string;
  questions: SeedQuestion[];
}

interface Seed {
  paper: {
    title: string;
    direction: "通用" | "考研" | "雅思";
    metadata: Record<string, unknown>;
  };
  sources: Array<{ key: string; title: string; text: string; type: string }>;
  sections: SeedSection[];
}

async function main(): Promise<void> {
  const seedPath = resolveSeedPath();
  const seed = JSON.parse(await readFile(seedPath, "utf8")) as Seed;
  const dryRun = process.argv.includes("--dry-run");
  const repos = createRepositories();

  // ── 幂等：标题已存在则整份跳过 ──────────────────────────────────────────
  // 判重放在事务里读，避免并发执行时两个进程都判定「不存在」。
  const alreadySeeded = await withTransaction(async (tx) => {
    const existing = await createRepositories(tx).l3Paper.listPapers({
      userId: OWNER_ID,
      limit: 100,
      offset: 0,
    });
    return existing.items.some((p) => p.title === seed.paper.title);
  }, { actorId: OWNER_ID });

  // 干跑先于幂等短路：已入库时也把「本来要做什么」讲清楚，否则 `--dry-run`
  // 在最常见的情形（跑过一次之后）只会打一行「跳过」，等于没报。
  if (dryRun) {
    console.log(`seed: ${seedPath}`);
    const questionCount = seed.sections.reduce((n, s) => n + s.questions.length, 0);
    const charCount = seed.sources.reduce((n, s) => n + s.text.length, 0);
    console.log(`[dry-run] ${alreadySeeded ? "已存在同名试卷 → 本次会整份跳过" : "将执行导入"}`);
    console.log(`[dry-run] ${seed.sources.length} 个来源（${charCount} 字）`);
    for (const s of seed.sources) console.log(`           - ${s.title}（${s.text.length} 字）`);
    console.log(`[dry-run] 1 份试卷「${seed.paper.title}」`);
    for (const s of seed.sections) {
      console.log(`           · ${s.title} · ${s.questionType} · ${s.questions.length} 题`);
    }
    console.log(`[dry-run] 合计 ${questionCount} 题 / ${seed.sections.length} 个 section`);
    return;
  }

  if (alreadySeeded) {
    console.log(`已存在同名试卷，跳过：${seed.paper.title}`);
    return;
  }

  // ── 1) 六篇文章来源 ────────────────────────────────────────────────────
  // content_text 全量入库；圈记（cloze/选项/翻译）与补全学习同走
  // L3ContextService 既有通路，本步骤不生成语境行。
  const context = new L3ContextService(repos.l3Context, undefined);
  const sourceIdByKey = new Map<string, string>();
  for (const source of seed.sources) {
    if (!source.text.trim()) throw new Error(`source ${source.key} 正文为空，拒绝建空来源`);
    const created = await context.createSource({
      userId: OWNER_ID,
      sourceType: "article",
      title: source.title,
      contentText: source.text,
      spaces: ["阅读"],
    });
    sourceIdByKey.set(source.key, created.source.id);
    console.log(`来源 ${source.key} → ${created.source.id}  ${source.title}`);
  }

  // ── 2) 试卷 + 48 题 ───────────────────────────────────────────────────
  // actor=owner ⇒ resolveAuthoringLifecycle 直接给 active（不走 pending 评审）。
  const paperService = new L3PaperService(repos.l3Paper, repos.l3Context);
  const result = await paperService.createPaper({
    userId: OWNER_ID,
    actor: { role: "owner" },
    title: seed.paper.title,
    direction: seed.paper.direction,
    metadata: seed.paper.metadata as unknown as Json,
    sections: seed.sections.map((section) => ({
      title: section.title,
      questionType: section.questionType,
      sourceId: section.sourceKey ? (sourceIdByKey.get(section.sourceKey) ?? null) : null,
      fileKey: section.fileKey ?? null,
      questions: section.questions.map((q) => ({
        ordinal: q.ordinal,
        stem: q.stem,
        options: q.options,
        answer: q.answer,
        explanation: q.explanation || null,
      })),
    })),
  });

  console.log(`试卷 ${result.paper.id} · ${result.paper.title}`);
  console.log(`题目 ${result.questionCount} 道，状态 ${result.questions[0]?.status ?? "?"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
