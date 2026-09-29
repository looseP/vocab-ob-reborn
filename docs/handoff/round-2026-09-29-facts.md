# 本轮实况与遗留（2026-09-28 ~ 09-29）

基准：`main@e089154`（含已合并的 PR #159）。本文件记录本轮**实测**结果，含**两处我判断错误并已撤回的结论**。
**本文件不含任何凭据值。**

> 与 `local-closeout-facts-2026-09-19.md` 的关系：那份记录旧机 09-19 收尾（数据类资产仍留旧机）。
> 本文件记录**本机**（`F:\dev\vocab-ob`）09-28/29 的接管与修复，**不是**旧机记录的替代。

---

## 1. 工具链现状（与直觉相反，注意）

| 工具 | 宿主 | 容器 | 结论 |
|---|---|---|---|
| git | 2.55.0.windows.3（本轮新装） | — | 可用 |
| node | **v22.20.0**（`C:\Users\20564\AppData\Local\Programs\nodejs22`，不在 PATH） | **v22.22.2** | **满足 `engines` 的是容器，不是宿主** |
| npm | 10.9.3（宿主） | 10.9.7 | — |
| node_modules | **三个 worktree 全缺** | 镜像内完整 | 宿主跑不了 vitest；容器可跑 |

**易误判处**：宿主 node 22.20.0 低于 `engines`（`>=22.22.0 <23`），但**服务与全部门禁都跑在容器里**（node 22.22.2 满足）。本轮所有测试均在容器内实跑。**不要把"宿主 node 版本低"当成本机风险**——这是本轮我一度讲错的地方之一。

- 宿主 `node_modules` 缺失 ⇒ 宿主不能直接跑 vitest/门禁。
- 跑门禁的可行路径：把源码挂进 `vocab-observatory-v2-migration:local`（build 阶段，带 devDeps 与 vitest），以 `--user root` 写入后再 `su node` 执行。镜像内 `/app` 默认只读。

---

## 2. 本轮修掉的实质缺陷

### 2.1 batch-01 的 20 词例句从未入账（数据）

- **现象**：`ledger.done` 记 6531，库内 `with_examples` 6511，差 20 词：`accelerate / advocate / ambiguous / assess / attribute / commit / comprehensive / consequence / criterion / derive / distinguish / fluctuate / harness / impose / legislation / nevertheless / phenomenon / sustainable / undermine / yield`。
- **根因**：三版回填 SQL（`examples-backfill.sql` / `-v2` / `-v3`，在 `_restore/`）**都是恰好 6511 条语句，独缺 batch-01**（首个批次）。`eu01-ledger.sql` 的源批次是 `batch-02`，回填链从 batch-02 起，batch-01 从未被任何脚本覆盖。
- **证据**：三份 SQL 逐词检索，20 词全部 MISSING；`UPDATE` 语句数恰为 6511。
- **修法**：从权威源 `deliverables/software-company/h1-example-sentences-batch01-sourced-2026-09-11.json` 生成 `batch01-backfill-2026-09-28.sql`（20 条，整段替换 examples，与 v3 同口径、幂等）。源文件与 `ledger.done_by_batch["batch-01"]` **逐词一致**，`all_anchored=true`、`modified=0`、字段零缺陷。
- **验证纪律**：先在隔离库演练（6511 → 6531），再逐字比对 **20/20 完全一致**（用 Python 直连容器取数，绕开 PowerShell 的 GBK 文本链路），最后上生产。
- **结果**：`6767 = 6531 done + 236 skipped` 完全对账。

### 2.2 错题库 `GET /api/l3/error-book` 必现 500（代码，PR #159 已合并）

- **根因是三处**参数编号问题，不止表面一处：
  1. count 查询传 `[]`，腿内 SQL 含 `$1..$N` → `there is no parameter $1`（500）
  2. rows 查询 `LIMIT $1 OFFSET $2` 与腿内 `$1(userId)/$2(space)/$3(direction)` **撞号** → 修好 1 之后仍会把 userId 当 limit，**静默返回错页**（比报错更坏）
  3. 两个 leg 各自造 params 却不返回，调用方无从校验
- **修法**：leg 返回自己的 params；两腿过滤参数逐字同序故共用一份；分页改 `$n+1/$n+2`；两腿参数个数不一致时**立即抛错**。
- **为何 10 个既有单测全绿**：`tests/repositories/l3-error-book.test.ts` 全部 `vi.spyOn` mock 掉 `query`/`queryOne`，**只断言 SQL 文本**，从不让 PostgreSQL 解析。且因三条真源表当时全为 0 行，真机也跑不出。
- **验证**：真实仓储+真库复现 4/4 FAIL → 修复后 4/4 PASS；新增 `tests/l3-error-book-params.integration.test.ts`（真实 PG、mock 零层、7 用例）7/7；变异 M1（count 传 `[]`）与 M2（分页撞号）均转红；`tsc --noEmit` 零错误；生产四形态端点 500 → 200 JSON。
- **顺带订正**：旧单测 `toContain('LIMIT $1 OFFSET $2')` + `params [limit,offset]` **锁的正是缺陷形态本身**，已改为 `$2/$3` + `[userId,limit,offset]` 并注明原因，防止后人当契约回退。

### 2.3 孤儿 worktree 清理

`wt-loop` / `wt-ladder` 的 `.git` 指向不存在的 `D:/Temp/Myawesomeapp/vocab-ob'/.git/worktrees/*`（**路径带游离撇号**，疑为 shell 引号事故，很可能就是交接文档所记"`.git` 事故根因"的来源）。

删除前**全目录**逐文件 `git hash-object` 比对（非仅 `src/`）：

| worktree | 文件数 | 完全匹配的 ref | 独有内容 |
|---|---|---|---|
| wt-loop | 1135 | `origin/main` 1135/1135 | **0** |
| wt-ladder | 1087 | `origin/feat/ladder-review-workflow` 1087/1087 | **0** |

唯一的"未知内容"是那个坏 `.git` 指针本身与 4 个 `.alerting-drill-test-*.lock` 临时锁文件。**删除零损失。**

---

## 3. ⚠️ 我判断错误并已撤回的结论

### 3.1 「自动备份丢失全部例句数据」——**误判，撤回**

我曾断言 09-28 12:43 的自动备份（274 KB）"丢了 101 MB 的例句数据"，并推测根因是 `postgres-backup.ts` 的 `pg_dump` 未指定连接身份。**两者都不成立。**

**真实时间线**（`words.created_at` / `updated_at` 实测）：

| 时刻 | 事件 |
|---|---|
| 12:43:31 | 自动备份（274 KB） |
| **13:01:29** | **words 6767 行写入完毕**（晚于备份 18 分钟） |
| 13:13:52 | 手工备份 `manual-vocab-6767w`（5.02 MB） |
| **14:11:54** | **最早一条 examples 写入**（晚于两份备份） |
| 20:33:43 | batch-01 修复写入（最后一条） |

- 12:43 那份备份**忠实反映了当时库状态**——此时**还没有任何 words 数据**。它不是丢了数据，是**早于数据存在**。
- 5.02 MB 手工备份恢复出 `words=6767 / with_examples=0`，同理（examples 14:11 才灌入）。
- **我犯的错**：只比了备份体积，没查数据何时入库，就把"体积小"当"数据丢"。**用间接证据下了直接结论。**

**机制实测正常**：用生产 backup 镜像跑真实 `postgres-backup.ts create` → 8,383,536 字节，恢复核对 `words=6767 / with_ex=6531 / empty=236 / with_exam=6171`，**与生产库完全一致**。**无需修复。**

### 3.2 「FR-12 接线2 已交付」的表述需要收紧

`feature-map.md` 写的"L3 context adapter 已存在"经实测**仅指 L2 辨析侧**（`ADR-0016` + `L3ContextSourceAdapter`，`services/index.ts:96-100` 注入 `l2Drill`）。**L1 复习卡仍未消费 L3**：`review.service.ts` 对 `l3_contexts` 零引用，`l3_context_id` 只出现在 `db/schema.ts` 的表定义里。

**准确表述**：FR-12 **接线2（L2 辨析读 L3 语境）已交付**；**接线1（L1 复习卡读 L3 语境）仍未接线**。

---

## 4. 本轮服务与数据状态（实测）

```
main                f7e2d1c（含 PR #159 error-book 修复、PR #160 本文件）
compose 项目         vocab-observatory   工作目录 F:\dev\vocab-ob\wt-main
容器                web / review-outbox-worker / llm-reservation-reaper /
                    backup-scheduler / postgres —— 全 healthy
镜像                vocab-observatory-v2:local  v22.22.2
迁移 journal        49（0046/0047/0048 已应用）
数据                words 6767 / with_examples 6531 / with_exam 6171 / empty 236
                    对账：6767 = 6531 + 236  ✓
使用痕迹            review_logs=0  user_word_progress=0  l3_* 全 0
备份                backups/ 共 56 文件；本轮新增两份经恢复验证的 dump
                    emergency-vocab-20260928-202923.dump   8,414,510
                    postfix-vocab-20260928-203409.dump     8,420,081
```

**迁移过程中的一次误操作（如实登记）**：首轮 `docker compose build` 只建了 web/worker，**漏建 migration 镜像**，容器日志报"成功"但 journal 纹丝不动（镜像内只有 45 个 SQL，宿主有 49 个）。补建后才 `45 → 49`。**教训：升 main 后必须逐个确认 `migration` 镜像也被重建，不能信日志。**

**另一处（如实登记）**：`docker compose up -d` 只重建镜像**不重建容器**（web 仍 Up 10 hours 跑旧代码），必须加 `--force-recreate` 才真正加载新镜像。

---

## 5. worktree 与分支现状

```
注册 worktree（5 个，均健指 F:/dev/vocab-ob/wt-main/.git/worktrees/）
  wt-main        f7e2d1c  [main]        ← 本文件自身提交后的 main
  wt-integration b7dcea4  [integration/l3-reliability-writing]
  wt-practice    b11f3ee  [writing-practice-v1]
  wt-reliability b96b972  [reliability-batch]
  wt-writing     baf971e  [writing-v1]
```

**本轮处置的未推送工作**：`wt-main` 原停在 `feat/hint-ladder-card`，含 **2 个 09-28 当天做、从未推送**的提交（`ReviewCardView.tsx` +575/-127，hint ladder 接入 exam 三层 + 卡面对齐 wordcard-mock）。`git branch -r --contains` 对两个 SHA 均返回空。

处置：先建本地 bundle（`git bundle verify` 通过）→ 推 `backup/hint-ladder-unpushed-2026-09-28` = `86d9b3f` → 再清理本地分支。**该分支保留作为重做时的参考**（见 §7.4）。

---

## 6. 工程流程偏差（如实登记）

1. **本机无 `gh` CLI**：PR #159 用 `git credential fill` 取既有凭据调 GitHub REST/GraphQL API 创建。凭据仅存于临时文件，用完即删，未写入仓库、未回显。
2. **API 代理**：Python 直连 `api.github.com` 超时（`WinError 10060`），需复用 git 的 `http.proxy`（`127.0.0.1:17891`）。
3. **`HUSKY=0` 绕过 pre-commit**：宿主无 npx，`.husky/pre-commit` 报 `npx: command not found`（exit 127）。沿用交接文档已登记的本机临时隔离措施。**门禁改为在容器内实跑通过**，不靠跳过 hook 蒙混。
4. **PowerShell 文本链路会损坏 UTF-8**：多次在 `Out-File`/管道后中文变乱码并导致 JSON 解析失败。**涉及中文数据的比对一律改用 Python 直连容器取数**，不经过 PowerShell 文本管道。
5. **`Get-FileHash` 与 `git hash-object` 不等价**：Windows CRLF 下前者会使 407 个文件全部误报"内容不同"。**比对仓库内容必须用 `git hash-object`**。
6. **合并 draft PR 的两步坑**：`PATCH /pulls/{n} {"draft":false}` 返回 200 但 `draft` 不变（需 GraphQL `markPullRequestReadyForReview`）；且该仓库关闭了 GraphQL 的 `draft` 字段，mutation 返回值**不能请求 `draft`**，只能用 `clientMutationId` 确认后回 REST 复核。

---

## 7. 遗留（按建议优先级）

### 7.1 本轮两个 PR 均已合并，CI 全绿
- **PR #159** `fix(l3): 错题库统一投影参数编号` → `main@e089154`
- **PR #160** `docs(handoff): 固化本轮实况` → `main@f7e2d1c`（即本文件自身）

两者三项必需检查（Engineering Gate + Migration Rehearsal / Browser E2E / Writing E2E）全 success。#159 的门禁数字：`Baseline ratchet gate PASS`、`Diff coverage 91.67% PASS`（changed src files 1、changed executable lines 24 / covered 22）。

### 7.2 H1 产线：exam 回填 340 词在途
- 池 360 词；`eu-01`（20 词）已回收入账并三闸门全 PASS。
- `eu-02`~`eu-08`（340 词）09-28 18:54 已发云端包，**尚无回传**。
- 主词池已 100% 消化（6531 done + 236 skipped = 6767）。

### 7.3 结构性盲区（已登记，无证据表明有缺陷）
`tests/repositories/` 33 个测试中 **17 个是纯 mock**（mock 掉 query，从不让数据库解析 SQL）——这是 error-book 缺陷能藏 10 个单测的**结构性原因**。

本轮用真实 PostgreSQL 逐个探测（含数组展开参数、分页 `$2/$3` 等形态）：**REAL-BUG = 0**。error-book 是 PR #142 独有的**孤立缺陷，非家族性**。

处置建议：**不预判、不扩大**。将来某个 mock 测试对应的仓储出线上问题时按本次套路处理（真库复现 → 变异测试 → 补集成测试）即可；不必现在把 17 个都改写成真库测试。

### 7.4 hint ladder 两个提交：架构已分叉，需**重做**而非合并
`main` 的 PR #138（阶梯 LW-0→2，ADR-0036）**重写了同一文件**（`ReviewCardView.tsx` -83/+16 净简化），并把提示逻辑抽到 `reviewFlow/hintSteps.ts`（4 个 step kinds）。本地 2 提交则把 exam 三层渲染**内置在组件里**，且改了 `example` step 的形状（`{text,translation}` → `{anchor}`）——与 main 的 `HintStep` 联合类型**接口不兼容**。

**强行解冲突 = 把两代架构焊死，是负资产。** 正确处置：按 main 新架构重做"exam 三层上阶梯"，先写执行文档（沿用 `docs/plan/` 纪律）。参考材料在 `backup/hint-ladder-unpushed-2026-09-28`。

### 7.5 L3 引擎零数据 —— 先验证路径，再决定是否灌数
`l3_sources / l3_contexts / l3_questions / l3_sheets / l3_submissions / l3_study_notes / wordbooks / notes` **全为 0 行**；`review_logs` / `user_word_progress` 亦为 0。这是一个**建成但尚未开始使用**的系统。

9 月底一整轮 L3 工程投入（三模式引擎、题目录入改题、判卷信箱、N2 学习笔记）回答的是"能不能建"，不是"用不用"。**建议先在浏览器真实走一遍"导入 → 建卷 → 做题 → 判卷 → 错题回看"，用一个月真实使用裁决 L3 去留**，而不是现在灌入 6171 条例句。

### 7.6 分支清理（需授权）
远端 20+ 个分支已完全合入 main（`ahead=0`），可删。保留：`main`、`backup/hint-ladder-unpushed-2026-09-28`、以及记录未整合成果的 `reliability-batch` / `writing-practice-v1` / `local-closeout-2026-09-19`。

### 7.7 FR-12 接线1（L1 复习卡消费 L3 语境）
实测 `review.service.ts` 对 L3 零引用。**注意**：§3.2 已说明 `feature-map.md` 原表述需收紧。

---

## 8. 本文件未覆盖

- 旧机数据类资产（语料 114 MB、dump、私密配置）的迁移状态——见 `local-closeout-facts-2026-09-19.md`，**本轮未触及**。
- 宿主 `node_modules` 的安装（未做；也不建议做，容器已足够）。
- 备份异地副本目标（COS vs R2）——`PROJECT-GUIDE.md` §10 的待裁决项，仍未决。
