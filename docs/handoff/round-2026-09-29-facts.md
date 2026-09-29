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

> **本轮共撤回 12 条。共同根因与三类纪律：**
> - **用局部证据下全局结论** —— 「用体积推断丢数据」「用 grep 范围推断未接线」
>   「用未完成的操作序列推断功能有 bug」「用『页面上看不到』推断『功能不存在』」
>   「拿两个不同时刻的观测做比对」（§3.5）
> - **没先确认测量环境与目标环境一致** —— §3.6 与 §3.7：把容器 `NODE_ENV` 差异
>   当成代码缺陷；把自动化脚本不认识某个组件的 DOM 标记当成产品死锁。
> - **证据指向了错误的层面**（§3.8-3.10、§3.11-3.12，第二三轮追加）—— 这五条与第一类同族，
>   但不是"证据不足就推广"，而是**证据本身查错了层**：
>   只查数据层没查门控（§3.8）、只做单侧 grep 没做双侧（§3.9）、
>   只读文档没验现状（§3.10）、**把手上正在查的对象当成了查询结果**（§3.11）、
>   **把上下文里的词当成了被搜的东西**（§3.12）。共同的正确动作是**往下再走一层**：
>   读调用点、两侧对照、验证现象当前仍存在、**让结果带上被检查对象的标识**。
>
> **给后续工作的纪律**：
> 1. 断言「功能不存在」前，先**触发**它一次，不只看代码或页面；
> 2. 断言「某层没接线」前，grep **全调用链**（路由→service→repository），不是只 grep 路由层；
> 3. 断言「数据丢了」前，先查**时间线**（数据何时写入 vs 备份何时生成）；
> 4. 报告缺陷时附**基线对照**（本 PR 未改动的 `origin/main` 上是否同样复现）；
> 5. 比对两个观测前，先确认**它们描述同一个状态**（见 §3.5 的教训）；
> 6. **报缺陷前先对齐运行环境**（Node/NODE_ENV/依赖版本/镜像 tag），别拿本机观测
>    直接代表 CI 或生产（见 §3.6）；
> 7. **自动化脚本探针只覆盖它认得的 DOM 标记** —— 「脚本没动」不等于「页面卡死」，
>    须先确认脚本能看见那个组件（见 §3.7）。


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

### 3.3 「阶梯结算表恒为空」与「服务端不感知 ladder」——两次误判

实测阶梯会话（`vocab-ladder-mode=on`）走完一轮后，我断言：① 结算表「0 词已调度」是缺陷；
② grep `src/http/routes/review.ts` 零命中，据此说"服务端完全不感知 ladder、`RUNG_SHIFT` 是死代码"。**两条都错**：

- ① 结算表**只统计产出轮**（`L3ReviewSession` 的 `setSettlement` 仅在默写 `dictResult` 分支调用）。
  我全程点「我认识 / 良好」，走的是再认轮与首学编码轮，**从未进入产出轮** → `settlement.length===0` 是**正确行为**。
- ② 我只 grep 了**路由层**。服务层完整接线：`review.service.ts:549` 调用
  `settleLadderRung(rung, input.rating, scheduling.stability)` → `saveAnswer` →
  `review.repository.ts:455` 的 `COALESCE($17, ladder_rung)` 落库。
  且 `abnormal` 实测 `rv=2, S=0.21d, last=hard → rung=1`，代入 `shiftLadderRung(1,"hard")=clamp(1+0)=1`
  **完全正确**（`hard` 位移为 0 是设计）。

**根因**：① 用**未完成的操作序列**推断功能有 bug；② 用 **grep 范围不足**推断未接线。

**顺带确认阶梯引擎可用**：双通路（再认轮 / 首学编码轮）、四级提示、缺失级自动跳过、
评分上限随用级下降（用 1 级后「轻松」被禁用）、揭示前无剧透、无 exam 层时降级 —— 均实测通过。

### 3.4 「能力域勾选不生效」——误判

我在导入表单勾了「阅读」，入库 `direction` 是「通用」，据此断言勾选项不生效。**错**：
那次导入在提交前表单被重渲染，勾选状态已丢失。**粘贴建卷后实测 `l3_questions.space=阅读`**，
能力域正确落库（同批 `status=active`，符合 ADR-0037 owner 直写）。

### 3.5 「错题库页面空但 API 有数据」——**我的测试自己污染了状态**

判卷打通后我先后做了两次观测，得出"前端空、后端有 1 条 ⇒ 前端消费链有 bug"，
并准备按 P0 上报。**两个观测描述的不是同一个状态**：

```
T1  API 观测   → verdict=wrong  / grader-local  → error-book items=1   ✅
T2  浏览器观测 → verdict=correct / owner        → error-book items=0   ✅ 正确行为
```

中间发生了什么：T1 之后我写的「负向验证」脚本里，为了确认 owner 身份能否调
`POST /grading`，**顺手提交了一条 `verdict: "correct"`**。该表有
`UNIQUE (sheet_id, question_id)`（幂等覆盖，见 §7.7a），于是把 `wrong` 覆盖成了 `correct`。
错题库只收 `latest_outcome='wrong'`，所以**正确地**不再显示它。

**三重错误**：
1. **没有意识到自己的验证脚本会改状态** —— 所谓"负向验证"用的是 `owner` 身份，
   而 owner 提交是**合法的**（ADR-0035：owner 与 agent 同一 actorId），根本不是负向用例；
2. **拿 T1 与 T2 比对**，没确认两者状态一致；
3. 差点又一次把**测试污染**当成产品缺陷 —— 与前四条同类，但这条最不该犯：
   **缺陷报告的对象本该是产品，而不是我自己刚写的数据。**

**新增纪律 5（见 §3 开头）**：比对两个观测前，先确认它们描述同一个状态。
**更根本的纪律**：任何"验证/探针"脚本若会写数据，必须与只读检查分开，
否则它既是测量工具也是污染源。

### 3.6 「全仓 32 个测试文件的 `act` 导入是坏的」——**环境差异当成了代码缺陷**

为给 P0 补回归测试，我在容器里跑 vitest，全仓报 `TypeError: act is not a function`，
`grep 'import { act } from "react"'` 命中 **32 个文件**。我据此判定这是 React 19 移除
`act` 导出的家族缺陷，准备**批量修 32 个文件**。

**错。** 逐层排查后：

```
容器 NODE_ENV=production  → require("react").act === undefined   ← 我测的是这个
NODE_ENV=development（CI） → require("react").act === function   ← 正常
```

React 的 `act` 只存在于 **development** 构建；migration 镜像的环境变量是 `production`。
**那 32 个测试文件一直是好的，CI 也一直是绿的。**

**根因**：我把自己的**执行环境**当成了**目标环境**，且未核对 CI 到底用什么环境跑。
更值得注意的是：我一度用**干净 `origin/main` 拉 worktree 做基线对照**，对照结果同样是
4/4 失败 —— **基线对照本身也用了同一个错误环境**，所以对照"通过"了，错误被确认了两遍。
**基线对照只有在同一环境、同一命令下做才有意义。**

**新增纪律 6**：报缺陷前先对齐运行环境（Node / NODE_ENV / 依赖版本 / 镜像 tag），
且基线对照必须与被测用**完全相同**的运行环境。

> **本机跑 vitest 的正确姿势**（宿主无 `node_modules`）：
> 挂源码进 `vocab-observatory-v2-migration:local`，`--user root` 写入后
> `su node` 执行，并**显式 `NODE_ENV=development`**。该镜像默认 `production`，
> 会让所有 `act is not a function` 类假故障出现。
> 另：`docker cp src <c>:/app/` 若 `/app/src` 已存在会形成 `/app/src/src` 嵌套，
> 污染 tsc —— 用 `docker cp src/frontend <c>:/app/src/` 或先 `rm -rf`。

### 3.7 「切档后连点 8 次不推进 = 第二个死锁」——**探针看不见那个组件**

修完 P0 后我继续压测，点「照着打 · 上限重来」8 次会话位置不动，
据此说"还有第二个死锁"。**错**：那个界面是 `TypingDictationView`（产出轮），
它的输入框 `aria-label` 是「默写输入」、跟写区是「默写键入区」；
而我的脚本只认 `FollowCopyView` 的「跟写输入」/「逐字跟写区」。
**脚本从来没看见那个组件**，"没推进"是探针失灵，不是产品卡死。
改用正确标记后，会话正常 7/9 → 8/9 走通。

**根因**：把**探针的盲区**读成**产品的故障**。
与 §3.4「页面上看不到就说不存在」同源 —— 只不过这次是"脚本看不到"。

**新增纪律 7**：自动化探针报"无反应"时，先确认探针能看见目标组件
（用 evaluate 直接查 DOM，而不是只匹配自己熟悉的 aria-label）。

### 3.8 「例句层 `ex-layer` 不在 DOM = 移植漏了」——**假设链太长，每一环都没验证**

500 词试点入队后实测：`clue-zone` / `clue-split` / `clue-mask` /
`training-fold` / `key-point` ×2 / `pattern-box` 全在，唯独 `[data-testid="ex-layer"]`
计数为 0。我判定 PR #168 的移植漏了例句层，并连排三个假设去找证据：

| 我假设的原因 | 查证结果 |
|---|---|
| `examples[0].text` 缺失 | **假** —— 库查询 `6767/6767` 都有 `text` |
| testid 记错了 | **假** —— 核对源码 `data-testid="ex-layer"` 确实存在 |
| 漏了 `data-testid` 属性 | **假** —— 属性在，且带 `data-no-flip` |

**真相**：`ExampleLayerBlock` 挂在 `ReviewCardView` 的 `flipBody` 里
`showDefinition ?` 的**卡背分支**（`L3ExamPaper` 无关，此处为 `ReviewCardView.tsx:785`），
而 `ClueZone` 在卡正面 —— 正面给遮盖后的语境线索、背面才给完整例句 + 译文 + 来源徽章。
**是互补的两面，不是遗漏。**

**更该记的是**：我想翻卡验证，但空格键与评分按钮**都推不动卡**（自动化能力不足），
于是"验证手段失效"与"结论未坐实"叠在一起。补了 5 例
`ExampleLayerBlock` 组件测试（#170）才把结论锁住。

**根因**：没先读**调用点的门控条件**就下结论。假设链一长，每一环都建立在
上一环未验证的前提上，纠错成本指数上升。

**新增纪律 8**：判定"某组件不渲染"前，**先读调用点**（它在哪个 JSX 分支 /
被哪个 state 门控），再查数据。数据对而组件不出现，答案几乎总在门控里。

### 3.9 「`restoreSession` / `encodeCard` 在 main 命中 0 = 阶梯功能缺失」——**把描述词当符号**

清理分支时查 `feat/ladder-review-workflow`（3 个提交、13613 行、落后 main 83 个提交），
`git grep` 这些符号在 main 上命中 **0 个文件**，我据此准备上报"阶梯会话的
session restore 与 encode card 功能未进 main"。

**错。** 回到该分支上 grep 同样两个词 —— **也是 0 命中**。它们根本不是代码符号，
而是**提交信息里的自然语言描述**（`58d70e6 ... encode card + TTS dictation + session restore`）。
实际功能在：`tests/frontend/ladder-encode-card.test.ts` 在 main 上（我当天跑过，PASS），
`LadderReviewSession.tsx` 用了 `sessionStorage`（会话恢复在），`reviewFlow/` 5 个文件全在。

**根因**：只做**单侧 grep** 就下结论。符号是否存在，只能靠"目标侧与参照侧都比一次"来判定；
单侧命中 0 与"符号根本不存在"无法区分。

**新增纪律 9**：用符号名做存在性/缺失判断时，**必须两侧都 grep**（目标与参照）。
单侧 0 命中只能证明"目标侧没有"，不能推出"功能缺失"。

### 3.10 「待签字文档里的剧透 bug = 当前仍存在」——**文档的未决清单会过期**

`plan/exam-mode-engine` 分支里的执行文档（2026-09-27）写着：

> 发现一处*当前就存在的剧透 bug*：`stats` 的计算与渲染**都不受 `revealAll`**，
> 草稿态用户未揭示答案时就能看到「答对 N」「估算 X 分」。

我读 `L3ExamPaper.tsx` 看到 `L2413` 裸渲染 `{stats.correct}`，判断**两天过去仍未修**。

**错。** 读到 `L2403-2417` 才看清：

```tsx
{/* 剧透门控（G-0）：判对与估分只在**解析档**显示。 */}
{vis.showScore ? (… 答对 {stats.correct} … 估算 {stats.score} …) : null}
```

`vis = visibilityFor(mode)` 来自 `src/frontend/viewModels/examModeVisibility.ts` ——
**219 行纯逻辑模块已完整落地**，`practice` / `pure` 两档统一走 `ALL_HIDDEN_ANSWER_FACE`
（`showScore: false`），三档判定表 `VISIBILITY` 逐字段对齐设计卡 §2.4。
`L2413` 的"裸渲染"只是在 `vis.showScore` 条件的**内部**。

**根因**：把**两天前的文档**当今天的现状。计划文档的"待修 / 未做"清单与代码之间
存在时差，越老的文档时差越大（该文档自己也标注了同类问题：§1.1 专门更正了
另一份文档"上一/下一文件已实现却标未做"的过期条目）。

**新增纪律 10**：文档写下的缺陷/未做项，动手前**先验证现象当前仍存在**。
文档的未决清单是**待核假设**，不是事实。

### 3.11 「`bear` / `abide` 释义互相污染」——**把手上正在查的对象当成了查询结果**

查 `words.core_definitions` 是否有重复内容时，我跑
`group by core_definitions::text having count(*) > 1`，得到「**1 组，2 词**」。
因为此刻我正在查 `bear` 与 `abide`，**没让结果打印 slug 就认定那 2 个词就是它们**，
据此上报「两个词的释义互相污染」并准备排查导入器。

**错。** 补上 slug 后：

```
真正重复的：enormous / huge（各 1 义项，逐字相同）
abide      3 义项  sense0="忍受；容忍"  en0="to tolerate or put up with something"
bear       3 义项  sense0=空           en0="large mammal of family Ursidae"
```

两者 `core_definitions::text` **并不相同**。污染不存在。

**根因**：SQL 返回了一个**不带被检查对象标识**的聚合结果，我却用"上下文里正在看
什么"去补全这个标识。上下文不是证据。

**新增纪律 11**：任何"哪些对象有问题"的查询，**必须让结果自带对象标识**
（`select slug, ...`），不能用"我正在查谁"来推断。

### 3.12 「`a/b/c` 就是 tag 映射」——**把上下文里的词当成了被搜的东西**

定位 `core → A/B/C` 的转换代码时，我 grep `"A".*"B".*"C"`，
命中 `h1-work/kit/work/h1p13_final_check.py` L13。**没看上下文就断定**
"转换规则在这行"，差点顺着它去改。

**错。** 打开看：那是**批次文件名**（`pilot-P13a/b/c-sourced-*.json`），
文档头写的是「P13 全片兜底：30 词分 a/b/c 三批 + skips」。**与 tag 无关。**

顺带查出真正的位置线索：该文件里 `KIT = Path(r"D:/tmp/h1-kit")`，
而 **`D:\tmp\h1-kit` 已不存在** —— A/B/C 转换工具随那个一次性目录消失了。

**根因**：grep 命中只说明"这些字符同处一行/一片"，不说明"它们构成同一个概念"。
必须看**命中的那一行的语义**，而不是它在什么文件里。

**新增纪律 12**：grep 命中后**必须读那一行 / 那一段的语义**再下结论。
同处一行不等于构成同一概念。

> 3.8-3.12 与 §3.1-3.5 同族（**用局部证据下全局结论**），
> 但触发面不同：那几条是"证据不足就推广"，这五条是
> **证据本身指向了错误的层面**（数据层 / 符号层 / 文档层 / 标识层 / 语义层），
> 而正确的层面要靠**读代码调用点**才能拿到。

---

## 4. 本轮服务与数据状态（实测）

```
main                0a2317f（含 #159 error-book、#160/#161 本文件、#162 L3 分页契约、
                    #163 L3 链路实测、#164 agent 判卷通道、#165 复习视图 key 死锁、
                    #167 词卡 exam 扩展、#168 例句三件套、#169 阶梯/打字流可达性、
                    #170 例句层测试补齐）
compose 项目         vocab-observatory   工作目录 F:\dev\vocab-ob\wt-main
容器                web / review-outbox-worker / llm-reservation-reaper /
                    backup-scheduler / postgres —— 全 healthy
镜像                vocab-observatory-v2:local  v22.22.2
迁移 journal        49（0046/0047/0048 已应用）
数据                words 6767 / with_examples 6767 / with_exam 6767   ← 已 100%
                    （本文件初稿写的是 6531 / 6171 / empty 236，那是 15:12 前的
                      快照；H1 产线随后补完 eu-10~eu-21，台账 `running: None`、
                      `done: 6767`，6767 条全部带 `exam`）
core_definitions    6767/6767 非空；重复组 0（enormous/huge 已差异化，见 #173）
tags 形态 ⚠️        **库里只有 A / B / C 三种**（A=源 tag 含 `core`；B/C=其余）
                    **源 markdown 有 67 种语义 tag**（n/v/adj/abstract/object/
                    person/formal/historical/manner/physical…，11023 义项），
                    导入时被压成一个比特。
                    **A/B/C 转换代码已随 `D:\tmp\h1-kit` 一次性工具消失**，
                    `src/` 内无此转换（`collection-parser.ts:145` 只做 trim）。
使用痕迹            user_word_progress=501（其中 497 立即到期）ladder_rung 已写入
                    ↑ 2026-09-29 下午 500 词试点入队所致；入队前仅 4 条。
                      试点动因：到期卡查询硬绑 `user_word_progress`，
                      所以在此之前 **6767 份 exam 只有 4 份能被复习卡消费（0.06%）**
                    review_logs=2
                    L3：sources=1 contexts=1 occurrences=1 papers=1 questions=1
                        submissions=1(sealed) question_attempts=1
                        **grading=1（wrong / grader-local）**  ← L3 七环打通
                        另有 examModeVisibility.ts（219 行）三模式可见性引擎已落地
agent 接入           AGENT_API_TOKENS 已配（agentId=grader-local，值只在 .env，gitignore 排除）
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

### 7.0 本轮实测的 L3 全链路（浏览器真实操作，真实语料）

用真实语料（USA TODAY 关于 abnormal 脂肪水平的句子，非造数据）走完整链路：

| 步骤 | 结果 | 落库证据 |
|---|---|---|
| ① 导入素材 | ✅ | `l3_sources=1` |
| ② 粘贴建卷 | ✅（**修完 PR #162 后**才通） | `l3_papers=1` / `l3_questions=1`（`space=阅读`、`status=active`，符合 ADR-0037 owner 直写） |
| ③ 圈记语境 | ✅ | `l3_contexts=1` / `l3_occurrences=1`（**L3 语境层首次有数据**） |
| ④ 开卷做题 | ✅ | 三模式（纯净/做题/解析）齐全，作答 1/1 |
| ⑤ 定格题纸 | ✅ | `status=sealed`、`seal_mode=full`、**迁移 0046 的 `question_ids=1` 定格生效** |
| ⑥ 解析模式 | ✅ | 正确显示 `✕ B`（答错）/ `✓ C`（正确）+ 录入的解析 |
| ⑦ 判卷 → 错题库 | ✅ | **补配 agent token 后打通**（见 §7.6）。`l3_grading_results` 落 `verdict=wrong / graded_by=grader-local`，`/l3/error-book` 投影 1 条，错题库页面显示「已加载 1 / 共 1 条 · 题级 1 条 · 最近判定：错 · 错误 1 次」 |

**PR #162** `fix(l3): 素材列表分页契约漂移` → `main@8c15b15`。P0 缺陷：前端硬编码
`/l3/sources?limit=100` 越过后端上限 50 → 400 → 素材下拉恒空 → 建卷无法选材料 →
点击「建卷」零请求零提示（`.catch(() => setSources([]))` 吞掉 400）。修法是引入
`src/domain/l3-list-limits.ts` 作契约单一真源（前后端共用），并用测试 G-1 扫源码
**禁止硬编码 `limit=\d`**。**同类漂移已全仓排查，仅此一处。**

### 7.1 六个 PR 均已合并，CI 全绿
- **PR #159** `fix(l3): 错题库统一投影参数编号` → `main@e089154`
- **PR #160** `docs(handoff): 固化本轮实况` → `main@f7e2d1c`
- **PR #161** 同步 main 值 → `main@ccda0ac`
- **PR #162** `fix(l3): 素材列表分页契约漂移` → `main@8c15b15`
- **PR #163** 登记 L3 全链路实测 → `main@09c099c`
- **PR #164** `feat(compose): 透传 AGENT_API_TOKENS`（本节 §7.6）→ 唯一代码改动
- **PR #165** `fix(review): 复习视图缺 key 致跨卡状态残留`（本节 §7.10）→ P0 死锁 + FSRS 污染

全部三项必需检查（Engineering Gate + Migration Rehearsal / Browser E2E / Writing E2E）全 success。#159 的门禁数字：`Baseline ratchet gate PASS`、`Diff coverage 91.67% PASS`。

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

### 7.5 L3 引擎已从零数据走到可用（2026-09-29 更新，推翻本节原结论）
**原结论已过时**：本节原写"全为 0 行，建议先走一遍链路裁决去留"。实测已完成该链路
（见 §7.0），L3 六张表**全部有数据**：`l3_sources=1 / l3_contexts=1 / l3_occurrences=1 /
l3_papers=1 / l3_questions=1 / l3_submissions=1(sealed) / l3_question_attempts=1`。

**agent 判卷通道已于同日补配打通**（详见 §7.6）。故题级错题库已非空。

结论：L3 七环已全部走通 —— 从"建成未用"进入"端到端可用"。

### 7.6 agent 判卷通道：配置缺口已补（PR #164）

**先纠正一个理解偏差**：判卷**不经 MCP**。ADR-0035 明确「agent 静态形态 = **无可改的
MCP server 包装层**，agent = HTTP Bearer 客户端」。实测 `scripts/run-mcp-server.mjs` 的
13 个工具全是 L2 内容 / L3 语料 / proposal 类，`grep grading|assessment|sheet|paper|question`
**零命中** —— 与 ADR-0029 决策 3 一致（写入仍限 proposal，`confirm`/`accept`/`validate` 不进 MCP）。

**也不需要任何 LLM API key**：判卷内容由客户端自行生成，服务器侧只需一个 agent token
认证 + 一个 `grading-context` 端点喂数据，两者代码里都已实现。缺的只是**部署配置**。

三处缺口，只有一处是代码：

| # | 缺口 | 性质 | 处置 |
|---|---|---|---|
| 1 | `compose.yaml` web 服务**未透传** `AGENT_API_TOKENS` | **代码层**（代码侧 4 处都读，只有 compose 没传） | 加 `AGENT_API_TOKENS: ${AGENT_API_TOKENS:-}` |
| 2 | `.env` 无该键 | 配置 | 加 `AGENT_API_TOKENS=grader-local:<32 字符 base64url>` |
| 3 | 本机无 agent 客户端 | 配置 | 一次性脚本（规则判卷，未接 LLM） |

**实测验证（5 项）**：

1. agent 身份 `GET /api/l3/capabilities` → 200，`role=agent`，
   `grading.inbox="agent_readable"`、`annotationWriteScope="review_only"`
2. agent 身份 `GET /api/l3/sheets/:id/grading-context` → 200，`questions=1 / sources=1`，
   单题含 `stem / options / answerIndex / attempt.answer / explanation / gradable / space` —— **判卷输入齐备**
3. agent 身份 `POST /api/l3/sheets/:id/grading` → 200，库落 `verdict=wrong / graded_by=grader-local`
   （`graded_by` 由服务端从 `Principal.agentId` 认定，非调用方自述 —— ADR-0035 要求）
4. `/api/l3/error-book` 投影正确：`kind=question / latest_outcome=wrong / wrong_count=1 /
   space=阅读 / source_title=Nada Hassanein, USA TODAY, 26 Feb. 2023`
5. 负向：伪造 token → 401

**契约细节（首次提交踩到）**：`results[].answerIndex` **不被接受**（`.strict()` 拒绝），
答案比对是**客户端责任**，服务端不重复校验。字段是驼峰 `analysisMd` 非 `analysis_md`。
正确形状见 `src/domain/l3-grading.ts:61` `gradingResultInputSchema`。
`superRefine` 另对 `questionId` 与 `annotationId` 做**批内去重**（fail-closed）。

**⚠️ ADR-0029 Tradeoffs 明示的风险**：agent token 读权限是**全量语料**。本机 `127.0.0.1`
绑定下风险低；一旦走 ADR-0024 公网暴露，**token 泄漏 = 全量语料可读**。故该值只进 `.env`
（已被 `.gitignore:30` 排除），不进文档、不回显、不入库。

### 7.7 两个附带发现（均非本轮引入）

**(a) 重复判卷是覆盖不是追加 —— 设计如此，非缺陷。**
`l3_grading_results` 有 `UNIQUE (sheet_id, question_id)`（约束名
`l3_grading_results_sheet_question_unique`），判卷按题纸粒度**幂等 upsert**。
实测：同一题先由 `grader-local` 判 `wrong`、再由 owner 判 `correct` → 行被覆盖，
`graded_by` 变为 `owner`，全表仍 1 行。计数范围是"这张题纸内"，重新作答产生新
`sheet_id` 故天然隔离。**符合 ADR-0035 的题纸定稿判一次语义。**

**(b) 题级 `wrong_count` 结构性恒 ≤1 —— 语义与页面文案有错配，列为待确认。**
`l3-error-book.repository.ts` 两条腿算法不同：
- 句级 L183：`count(*) FILTER (WHERE w.outcome='wrong')` —— **真计数**，可 >1
- 题级 L237：`count(*)::int` —— 因上述 UNIQUE 约束，**恒为 1**

而页面文案写「每条给出最近判定、**错误次数**与来源」，卡面渲染「错误 N 次」。
**题级的 N 永远显示 1。** 这算缺陷还是文案问题，取决于设计意图 ——
而代码注释引用的设计文档 `eb1-error-book-aggregation-cursor-2026-09-12.md`
**不在仓库内**（全仓 `*.md` 搜 `eb1` 零命中），无法据以定性。
**处置：登记为 P3 待确认项，不擅自改语义。** 若要真计数，需把约束放宽到
`(user_id, question_id)` 或引入判卷历史表 —— 那属独立设计决策，不在 bug 修复范围。

### 7.8 分支清理（已完成，删 38 个）
远端 37 个分支经 `git branch -r --merged origin/main` + `git merge-base --is-ancestor`
**逐个二次验证**后删除（open PR 为 0）。其中 `feat/ladder-review-workflow`
虽 `merge-base` 判为未合入，但 **41/41 文件 + `ladder-encode-card.test.ts` +
`LadderReviewSession.tsx` 的 sessionStorage 全在 main 上** ⇒ squash 造成的历史错位，可删。
删除清单存 `%TEMP%\opencode\deleted-branches.txt`。

**未删 3 个**（都不是「已合入」，超出当时授权）：
- `plan/exam-mode-engine` —— 已于本轮后续删除（三模式引擎 219 行已在 main，文档使命完成）
- `backup/hint-ladder-unpushed-2026-09-28` —— PR #168 移植源，**唯一一份原始形态存档**，建议长期保留
- `wip/wordbook-crud-0903` —— 提交信息自标 `unfinished work, parked`，是待续工作而非垃圾

### 7.9 FR-12 接线1（L1 复习卡消费 L3 语境）
实测 `review.service.ts` 对 L3 零引用。**注意**：§3.2 已说明 `feature-map.md` 原表述需收紧。

### 7.10 【P0 已修】复习视图缺 key → 巩固轮死锁 + 评分上限污染（PR #165）

**由用户实测截图发现**：「阶梯会话 · 巩固轮 6/9」的 `Mediterranean`
显示「跟写完成 · 错键 3」，输入框消失、**无任何按钮可点**，会话卡死。

**DOM 实测证据**（修复前）：

```
跟写区 13 格 = ['M','e','d','i','t','e','r','·','·','·','·','·','·']
             └────── 前 7 格高亮 = 上一张卡残留的 typedLength ──────┘
错键 3（残留）· 跟写完成态（残留）· 输入框消失（残留）
```

**根因**：`LadderReviewSession` 与 `ReviewPage` 渲染四个带本地 `useState` 的
复习视图时**都没给 `key`**，React 按位置复用组件实例，上一张卡的本地状态
被带进下一张。这是**家族缺陷**，四个组件全中：

| 视图 | 残留状态 | 后果 |
|---|---|---|
| `FollowCopyView` | `finished` + `useTypingFlow` 的 `typedLength`/`doneRef` | **死锁** |
| `TypingDictationView` | `finished`/`hintChars` + `useTypingFlow` | 同类死锁 |
| `ReviewCardView` | `hintLevel`/`viaH4`/`revealed`/`shown` | **评分上限错 → 污染 FSRS**；剧透 |
| `EncodeCardView` | `revealed` | 剧透 |

**死锁链路**：上一卡已跟写完成（`doneRef=true`、`finished=true`）→ 换卡后组件被复用
→ 新词比旧词短时 `done` 立即为真 → 输入框消失、`onDone` 因 `doneRef` 已置位永不触发。

**`hintLevel` 泄漏比死锁更隐蔽也更糟**：每用一级提示评分上限降一档，残留会让用户
**还没用任何提示就被压低评分**，FSRS 系统性低估记忆强度。这是**静默的数据污染**。

**修复**（`main@0eaadb1`）：
1. `cardKey = progressId + stage`。**stage 也要进 key** —— 最后一个 else 分支被
   多个 stage 共用（`card` / `card-no-hints` …），换 stage 时同为 `ReviewCardView`、
   位置不变，仅靠 `progressId` 不足以触发重挂载。
   `ReviewPage` 用 `key={currentCard?.progressId ?? "review-no-card"}`。
2. `useTypingFlow` 纵深防御：目标词变化即清零。**不替代 key** —— 它管不到 `finished`。

**验证**：新增 hook 测试 4 例 + 源码护栏 4 例（五个视图**每一处**渲染都带 key）。
变异测试：抽掉 `FollowCopyView` 的 key → 护栏转红；移除换词重置 → 3 例转红而
「同词不重置」保持绿（对照组有效）。12/12 PASS；既有 6 个受影响文件 16/16 PASS；
frontend tsc 零错误。
**浏览器端到端**：同一张 `Mediterranean` 跟写区修复后为 `['M','·',...×12]`（进度归零）
且**有输入框**；会话 6/9 → 7/9 → 8/9 → 9/9 走通至「阶梯会话结算 3 词已调度」。

**教训**：React 列表/条件渲染里，**任何带本地状态的组件都必须有 key**。
本项目四个复习视图全部漏了，而单测因 `act` 假故障（§3.6）从未真正执行过组件层断言 ——
**测试没跑过 = 缺陷可以长期潜伏**。

### 7.11 ⚠️【回归风险】重跑导入会改变 `tags` 形态

`core_definitions[].tags` 当前只有 `A` / `B` / `C`（§4）。**若将来重跑词条导入，
这批数据的 `tags` 会变成源 markdown 里的原始 67 种语义 tag**
（`n` / `v` / `adj` / `abstract` / `object` / `person` / `formal` / `historical` /
`manner` / `physical` …），因为：

- 源文件（`h1-outbound-l0-024/data/corpus/**/*.md`，**不在 git 内**）里就是这 67 种，
  11023 个义项；`l1_entries.json` 6767 条零重复 lemma。
- `collection-parser.ts:145` 对 `tags` **只做 `trim`，不做任何映射**。
- A/B/C 转换发生在 `D:\tmp\h1-kit` 的一次性导入工具里，**该目录已不存在**，
  `src/` 内无此逻辑 —— 也就是说**转换代码已经找不回来了**。

**为什么要记这条**：UI 侧已按「`tags` 冗余于 `priority`、不渲染徽章」定稿（#173）。
重跑导入会让 `tags` 从 3 个值变成 67 个值，届时**没有基准可比对**，
下一个人只能重新调查一遍（本轮已花掉十余次查询）。

**处置：不立项恢复**（UI 当前不消费它，价值为零）。但重跑导入前必须知道：
① `tags` 形态会变；② 转换代码已丢，需要先决定是恢复语义还是重新实现 A/B/C 映射。

### 7.12 附带发现（未修，仅登记）
- **源 markdown 有 95 处 `tags` 行混入 `### Prototype`**（24 个文件）——
  部分词条的 `### Core Definitions` 段缺终止标记，解析时把下一节标题吃进了 tag 列表。
  **未进库**（库内 `tags` 仅 3 种值、零个 `#` 开头），故当前无实际危害。
  修法很轻（解析器过滤 `#` 开头的 token），但没有使用方之前不值得动。
- **`bear` 的 `core_definitions[0].sense` 为空**，而 `en` 是正确的
  `large mammal of family Ursidae`（熊科）。源条目来自
  `L1_雅思词汇_动物保护.md`（`field_name = 动物保护`，`senses = 1`），
  中文义项本就可能缺失。属源数据质量，未修。

### 7.13 义项列表去 markdown 化（PR #172 / #173）
`definition_md` 是 `core_definitions` 的**有损 markdown 投影**
（`collection-parser.ts:183` `renderDefinitionMd` 把结构化字段压成
`1. 义项` + `- en:` / `- priority:` / `- tags:` 三个 bullet），
导致复习卡「显示释义」区每义项 4 行、`priority` 与 `tags` 各占一整行。

`core_definitions` 覆盖率 **6767/6767**（实测），故改为结构化渲染
（新增 `SenseList`），`definition_md` 保留为降级路径（stub 词条）。
`priority` 不再显示（`sortByPriority` 已保证顺序，`prio=1` 恒为 `A` ⇒ 与顺序完全等价）；
`tags` 亦不显示（A/B/C 只表达「是否核心义项」，是 `priority` 的函数）。

顺带修数据：`enormous` 与 `huge` 的 `Core Definitions` 在**两个不同源文件里逐字相同**
（`L0_基础词_e_第二.md` / `L0_基础词_h_第四.md`），属源数据问题而非导入 bug；
已按各自词源补差异化义项（`enormous` 走程度/超出常规轴、`huge` 走物理体量/数量轴），
源文件与库同步，**全库重复组数归 0**。

`content_hash` 刻意不动：导入路径**未使用**当前的 `computeFullHash` ——
试了 6 个变体在 4 个探针词上全部无法复现，且 `l1_content_hash` / `l2_content_hash`
全表为 `null`。两词 `user_word_progress` 行数为 0 ⇒ 无快照 ⇒
`deriveContentStaleness`（`content-staleness.ts:56`「任一侧缺失 → 不派生」）返回 false，
`needs_recheck` 不会触发；且 `content_hash` 带 UNIQUE 约束（`schema.ts:208`），
两词本就不同，不动不违反。全表重算留给 `content-staleness.ts:52` 已记录的
「P2 补齐 L1 hash 产出链」。

---

## 8. 本文件未覆盖

- 旧机数据类资产（语料 114 MB、dump、私密配置）的迁移状态——见 `local-closeout-facts-2026-09-19.md`，**本轮未触及**。
- 宿主 `node_modules` 的安装（未做；也不建议做，容器已足够）。
- 备份异地副本目标（COS vs R2）——`PROJECT-GUIDE.md` §10 的待裁决项，仍未决。
