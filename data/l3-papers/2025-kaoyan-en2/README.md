# 2025 考研英语（二）

一次性试卷 seed：**6 篇文章来源 + 1 份 48 题试卷**。

## 文件

| 文件 | 内容 | 用途 |
|---|---|---|
| `paper.json` | 6 篇正文（14,930 字）+ 48 道题 + 试卷元数据 | **入库脚本读这个** |
| `pdf-fulltext.txt` | 原 PDF 全文抽取（177,224 字） | 溯源，**不入库** |

## 为什么要留 pdf-fulltext.txt

原始 PDF 已不在本机，抽取脚本是一次性的、**已不可重跑**。`paper.json` 里的文章
正文与 48 道题是从这份抽取里**手工筛出**的 —— 也就是说，`pdf-fulltext.txt` 是
这批选题的**唯一溯源依据**。将来要补选 Text 5、订正某道题、或核对某段原文，
只能回到它。

`paper.json` 自带 6 篇正文（不是索引），所以**入库不依赖** `pdf-fulltext.txt`；
留它是为了可审计，不是为了跑。

## 跑法

数据库不对宿主暴露，所以要**在栈内跑**（`postgres:5432` 才解析得到）。运行镜像
刻意最小化（只白名单拷了本脚本，**不含 `data/`**），所以数据要**挂载**进去：

```bash
# 先干跑，确认要写什么
docker compose run --rm -v "<仓库路径>/data:/app/data:ro" \
  -e NODE_ENV=development -e DB_SSLMODE=disable \
  web npx tsx scripts/seed-l3-paper-2025-en2.ts --dry-run

# 真跑
docker compose run --rm -v "<仓库路径>/data:/app/data:ro" \
  -e NODE_ENV=development -e DB_SSLMODE=disable \
  web npx tsx scripts/seed-l3-paper-2025-en2.ts
```

`<仓库路径>` 在 Windows 上要注意 Docker 只接受正斜杠或引号包起来的绝对路径。

在**开发容器**里（源码完整挂载、`data/` 已在位）可以直接 `npm run
db:seed:l3-paper-2025-en2 -- --dry-run`，无需挂载。数据位置也可用
`L3_PAPER_SEED_PATH` 覆盖。

连接串走 **`DATABASE_URL`**（`src/db/connection.ts` 只认这一个变量名）。栈内 `web`
容器自带该变量，通常不用显式传 —— 上面显式写 `-e` 只是把 `NODE_ENV` 和
`DB_SSLMODE` 固定住，避免继承宿主环境。

## 幂等

按试卷标题判重，重复执行整份跳过（不覆盖、不追加题目）。**这是有意的** ——
试卷一旦被做过（attempts），覆盖重建会毁掉作答记录。要重新导入得先手工清卷。

## actor

脚本传 `{ role: "owner" }`，题目直接落 `active`（ADR-0037）。传 `agent` 会让
48 道题全进 `pending` 等审核 —— 对「已定稿的真考卷」是错的。

## 校对状态

**未经第二人核对。** 题目与答案由单人从 PDF 抽取结果整理，可能有错。若要拿它
当练习用，建议先自己抽查几道。`answer.explanation` 大多为空 —— 解析未做。
