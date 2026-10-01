# 6767 词条语料（词库真源）

`words` 表 6767 个词条的**来源文件**。它们原先散落在仓库外的工作目录里，DB 能读不能重建 —— 本目录把它们纳入版本库，让词库可复现。

## 为什么纳管

- `words.source_path` 指向这些文件。**文件不在版本库 → 词库只能读、不能重建**。
- 已有先例：`data/l3-papers/` 同理进 git —— 那份 `pdf-fulltext.txt` 是 2025 试卷选题的唯一溯源依据，抽取脚本已不可重跑。
- 8.9MB 一次性入仓，不是每次提交都膨胀。

## 构成（2026-09-30 实测）

| 语料库 | 文件 | 词条 | 库内分布 |
|---|---:|---:|---|
| `L0_单词集合/` | 91 | 867 | 与 DB 完全一致 |
| `L0_基础词/` | 85 | 1487 | 与 DB 完全一致 |
| `L0_超纲词/` | 66 | 967 | 与 DB 完全一致 |
| `L1_雅思词汇/` | 22 | 3446 | 与 DB 完全一致 |
| **合计** | **264** | **6767** | |

DB 侧的对应值（`select left(source_path,6), count(*) from words group by 1`）逐库相等，合计 6767。**词条集合 100% 匹配，无重复、无缺失。**

## 四份副本的关系

仓库外另有三份内容不同的语料。**都不是本目录的来源，别混用：**

| 路径 | 词条 | 与 DB | 与本目录 |
|---|---:|---|---|
| `_restore/corpus` | 6767 | 逐库相等 | **= 本目录来源** |
| `h1-work/kit/data/corpus` | 6767 | 逐库相等 | 词条集合相同，**264 个文件内容全部不同** |
| `h1-work/outbound/l0-001/data/corpus` | 6767 | 逐库相等 | **与 `kit` 逐字节相同** |
| `h1-outbound-l0-024/data/corpus` | **6777** | **多 10 个词** | `L0_基础词` 多 10 个 `## ` 标题（去重后仍 6767，即 10 个词被写了两次） |

要点：

1. **本目录取自 `_restore/corpus`** —— 词条分布与 DB 逐库精确相等，且命名语义是「从备份恢复的那份」。
2. **`kit` 与 `l0-001` 逐字节相同**，是同一份的两个副本。
3. **`l0-024` 比 DB 新**（`L0_基础词` 多 10 个 a- 词）。若要追平，得单独决策是补 DB 还是回退语料 —— **本 PR 不做**。
4. 三份的 264 个文件**内容全部不同**（md5 逐文件比对无一相同），是同源的不同版本，不是格式差异。

## 可复现性

重建词库：

```bash
# 1) 挂语料
docker compose run --rm -v "<仓库路径>/data:/app/data:ro" \
  -e INGEST_CORPUS_DIR=/app/data/corpus \
  -e BATCH_IMPORT_DATABASE_URL='postgresql://vocab_batch_import:...@postgres:5432/vocab' \
  -e DB_SSLMODE=disable \
  web npx tsx scripts/import-vocab-notes.ts --dry-run

# 2) 真跑（同上，去掉 --dry-run）
```

`scripts/import-vocab-notes.ts` 的 `LIBRARIES` 四项（`L0_基础词` / `L0_单词集合` / `L0_超纲词` / `L1_雅思词汇`）与本目录的四个子目录**完全对应**。

导入必须用 `BATCH_IMPORT_DATABASE_URL`（`vocab_batch_import` 角色）—— 迁移 0025 给 `vocab_app` 建的 UPDATE policy 只放行 stub 行，用应用角色改有释义的词条会**静默命中 0 行**。

## 校验

语料与 DB 的一致性可随时自查（不依赖本目录的 README）：

```sql
-- 语料侧（数 markdown 的 '## ' 二级标题）
--   期望 6767，去重后 6767
-- DB 侧
select count(*) from words where is_deleted = false;              -- 6767
select left(source_path, 6), count(*) from words group by 1;       -- 逐库比对
```

## 约定

- 语料**不改**：它是对齐 DB 的基准，改了就与库不一致了。要改词条内容应改 DB（或走导入流程重生成），并同步更新本目录。
- 新增批次语料时，同步更新上表的「文件 / 词条 / 分布」三列。
- `*.md text eol=lf`（见 `.gitattributes`）已保证入库统一 LF，不受 Windows / Linux 平台影响。原始文件本身换行混用（21.6 万 CRLF + 10.5 万 LF），这是历史遗留，纳管时被规范化属预期。
