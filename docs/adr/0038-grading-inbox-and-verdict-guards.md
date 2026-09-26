# ADR-0038: 判卷待评面与判定护栏（待评卷清单 + 三个护栏漏洞）

- **Status**: Accepted
- **Date**: 2026-09-26
- **Narrows**: ADR-0035 决策 3 的**评卷作用域**（由「题纸作用域题目集」收窄为「该题纸内已物化 active attempt 的题」）；决策 1 的表结构**不动**（不增版本列）
- **References**: ADR-0029（agent 读全量 + 能力发现）、ADR-0030 §4（评卷红线）、ADR-0034（attempt 是不可变作答事实、题单定格）、ADR-0035（评卷执行面；agent 形态 = HTTP bearer）、ADR-0037（录题 pending 闸门 —— 「已发生的事实不可改写」同族纪律）、ADR-0025（单一代码路径）
- **上游**: `docs/plan/practice-loop-p3-2026-09-26.md` §5 待裁决点 3

## Context

### 一、先纠正一处此前的错账：「触发方式」早已裁决，不是待裁决项

P3 卡的待裁决点 3 写的是「仍需裁决 grading 版本列与**触发方式**」。回码核验后，触发方式**已有明确裁决**，且实现与之一致：

- ADR-0030 §4：「评卷非实时，靠 agent 拉取触发（**无 webhook/轮询**）」。
- ADR-0035 §范围明示：「**不做**：自动触发评卷（本地 agent 无守护进程，MVP 口头指令驱动）」。
- 代码侧零残留：`webhook` / `daemon` / `cron` / `poll` 在 `src/` 无实现；`l3_grading_results` 提交路径**不写 outbox**（全库仅两种 outbox 事件，均属 L1/L2 复习链）；compose 服务集合无 grading worker。

⇒ 本 ADR **不重开触发方式的决策**，只解决它留下的实际问题。

### 二、真正卡住整条链的：agent 无法发现「有哪些题纸待评卷」

`GET /api/l3/sheets/:id/grading-context`（minRole=agent）需要 `sheetId`。而 agent 拿不到待评卷题纸的 id：

| agent 可读面 | 能否给出待评卷 sheetId |
|---|---|
| `GET /api/l3/sheets`（唯一带 `graded_count`） | ❌ `operations.ts:578` minRole=**owner** |
| `GET /api/l3/error-book` | ❌ 只列**已评且判错**（`verdict IN ('wrong','partial')`）的题纸；判对的、未评的完全不可见 |
| `GET /api/l3/capabilities` | ❌ `grading` 字段只有两行常量，无题纸信息 |

⇒ 现状是 owner 必须**口头把 sheetId 报给 agent**。设计卡 `l3-grading-batch3-design-card-2026-09-17.md:25` 那句「agent 亦可自查待评题纸」在代码中**从未实现**，且此后**没有任何文档把它认定为错误** —— 它作为一句未兑现的承诺沉在文档里。

### 三、三个正确性漏洞（无任何文档记录，本轮回码发现）

| # | 漏洞 | 证据 | 后果 |
|---|---|---|---|
| **B3** | `full` 档 sealed 题纸里**未作答**的题也能被评卷：评卷作用域是整张题单（`l3-grading.service.ts:216-226`），而 `full` 档只为**已答**题物化 attempt（`l3-sheets.service.ts:282-298`） | 现有测试**锁定**了该行为（`tests/services/l3-grading.test.ts:167` 的 `listBySheet` 默认返回 `[]` 却仍提交成功） | `verdict` 描述的是**用户表现**；用户没作答 ⇒ agent 只能编。且该题 attempt=0 ⇒ `PATCH /api/l3/questions/:id` 的 409 护栏放行 ⇒ 题面可改 ⇒ **判定变成对另一道题的判定**。错题库里会出现「我没做过的错题」 |
| **B4** | 硬删题**静默吃掉** `l3_grading_results` 行：blocker 只有作文任务 / active 卷面 / 学习笔记三类，**不查 attempts、不查 grading**；`question_id` 是 `onDelete:"cascade"` | `l3-paper.service.ts` `deleteQuestion` 全文；`src/db/schema.ts:1556` | 错题库**无声缩小**；档案 `graded_count` 随之下降，用户看不出任何东西被销毁。**同一函数也不查 attempts** ⇒ 删题静默销毁答案历史，与 P3-1 刚立的「答案历史不可改写」自相矛盾 |
| **B5** | `question_ids IS NULL` 的题纸在解析时**现拉**题集：0046 回填只覆盖「≥1 attempt」的题纸（`HAVING count(*) > 0`），故**零题作答的 `full` 档 sealed 题纸**落进 legacy 桶 | `0046_l3_submissions_question_ids.sql`；`l3-sheet-scope.ts:19-32` | 已定格题纸的题集仍可被 `PATCH /api/l3/papers/:id` 改变（该端点只校验「题 active 且属主」，不查 attempts / grading）⇒ 与「题单只缩不换」（`CONTEXT.md` Sheet question list）不一致 |

### 四、版本列与本轮无关

「grading 版本列」的裁决对象是**学习笔记能否引用某一次具体评卷**（N2 第 4 条引用链，`study-notes-n2-execution-2026-09-23.md:97-105` 的 D3-a **暂定未签字**）。待评卷清单只需要**当前**评卷状态，不需要版本 ⇒ 本轮不 reopen 该裁决，也不为清单加列。

## Decision

1. **触发方式不重开**：维持 ADR-0030 §4 + ADR-0035 的「agent 拉取、无 webhook/轮询、无守护进程」。本 ADR 只补「agent 能自己找到该评哪张」。
2. **新增待评卷清单 `GET /api/l3/sheets/pending-grading`（minRole=agent）**，**最小披露**：每项只给 `sheetId` / `sealedAt` / `scope` / `venueTitle` / `questionCount` / `gradableCount` / `gradedCount`。**不含**题干、选项、答案、解析、作答、注记。判据：agent 只需要知道「该评哪张」，取料走 `grading-context`（那里本来就带答案，是 D8 的显式例外面）。**不开** `GET /api/l3/sheets`（题纸档案是 owner 的个人台面，维持 owner-only）。
3. **owner 判卷信箱复用同一数据源**：档案页已有「待评卷 / 已评 n 题」（`L3PapersPage.tsx:1108`），本轮补的是**可操作抓手** —— 待评卷行提供「复制评卷指令」，一键复制含 `sheetId` 与两个端点名的一行指令。这是 ADR-0035「口头指令驱动」在 UI 上的可操作形态，**不是**自动触发。
4. **B3 修法 = 收窄评卷作用域，而非给 PATCH 加护栏**：`submitGrading` 只接受**该题纸内已物化 active attempt 的题**的 verdict；未作答的题提交 → **422** 并说清原因。理由三条：
   - `verdict` 的语义是用户表现，没作答就没有可判的对象 —— 收窄是让 agent 的任务**良定义**，不是加限制；
   - 收窄后「已评 ⇒ 有 attempt ⇒ 题面已被 409 冻结」自动成立，错题库里不再出现「没做过的错题」；
   - 反过来（保留可评未答 + 给 PATCH 加护栏）会造出「评过但没做过的题**永久冻结**」的新死角 —— 正是 ADR-0037 闸门要防的那类不可撤销陷阱。
   `grading-context` 仍返回整张题单（agent 需要看到跳过的题以说明「未作答」），但每项新增 `gradable: boolean`，让 agent 无需试错。
5. **B3 补强（防历史脏数据）**：`PATCH /api/l3/questions/:id` 的 409 增列「已有评卷结果」。决策 4 之后正常数据不会触发它；它防的是**本 ADR 之前**已写入的「有 verdict 无 attempt」行。
6. **B4 修法 = 删题护栏补两类 blocker**：题级作答（attempts）与评卷结果（grading_results）。二者都是**已发生的事实**，删题是销毁 —— 与 P3-1「答案历史不可改写」同一纪律。`graded_count` 会随之不再无声下降。
7. **B5 修法 = 定格时补冻结**：`sealSheet` 时若 `question_ids IS NULL` 则写入当时的作用域题集。决策 4 之后「零题作答的 sealed 题纸」永远拿不到 verdict，故 B5 的**评卷**风险已被决策 4 关闭；本决策关掉的是「已定格题纸的题集仍可被改卷改变」这个显示层不一致。
8. **可评数进契约**：`gradableCount` 进 `GET /api/l3/sheets/:id/grading` 与待评卷清单。理由：「已评 n/m」的 `m` 必须是**可评数**；否则 UI 会把「未作答」显示成「没评」，永久显示一个永远补不齐的缺口。
9. **capabilities 增 `grading.inbox = "agent_readable"`**：能力发现是 agent 唯一的自述入口（ADR-0029 决策 8），清单不加进 capabilities 就等于不存在。
10. **显式不做**：自动触发 / 守护进程 / 轮询 / webhook / outbox 事件；评卷历史版本与 `grading_version` 列（裁决对象是 N2 引用链，不在本轮）；把 `GET /api/l3/sheets` 整体开放给 agent；writing 题纸的待评阅清单（作文评阅走专用面，`writing-workspace.md` 已定）。

## Tradeoffs

- **收窄作用域 vs 兼容既有测试行为**：决策 4 改掉了 ADR-0035 允许、且被测试锁定的「未答题可评卷」，需要改测试夹具并更新 ADR-0035 的决策 3 引用。代价是承认「设计卡那句话是错的」；收益是 agent 的任务良定义 + 错题库可信。若选兼容方案（保留可评未答 + PATCH 护栏），则要承受「评过没做过的题永久冻结」这个死角 —— 用 ADR-0037 刚否决过的那类代价换零测试改动，不划算。
- **新建窄端点 vs 开放题纸档案**：`GET /api/l3/sheets` 含 scope/题数/已评数/标题但不含题面，看似可以直接开放。仍不开放，因为它是 owner 的**个人台面列表**（含 draft），且 ADR-0029 的读面放开清单未含它 —— 复用「按需最小披露」更符合该 ADR 的分级思路。代价是多一个端点。
- **服务端算 `gradableCount` vs 前端算**：前端不知道哪题被作答过（作答历史是 owner-only 面，且解析模式刻意不载 attempt）。服务端算则读面多一个字段，但数字只有一个来源。选后者。
- **「复制评卷指令」按钮 vs 深链**：按钮复制的是**给人看的一行指令**（含 sheetId 与端点），不是深链 —— 深链在 agent 侧无用（agent 不点页面）。代价是文案需要人工维护端点名；缓解：端点变更会同时改 `operations.ts`，文案里只写路径不含 schema。

## Consequences

- domain：`l3-grading.ts` 增纯函数（按 attempt 划分可评/不可评，单一实现）；`L3_GRADING_AUTHORIZATION` 增 `inbox`。
- repository：`l3-sheets.repository` 增待评卷清单查询（与 `listArchive` 同表同形状）；`l3-paper.repository` 增 `countQuestionGradings`（PATCH 与删题两处护栏复用）。
- service：`l3-grading.service` 增 `listPendingGrading` + 作用域收窄 + `gradableCount`；`l3-paper.service` 两处护栏增列；`l3-sheets.service` 定格补冻结。
- http：新增独立薄路由 `routes/l3/grading-inbox.ts`（`grading.ts` 与 `sheets-archive.ts` 均受棘轮冻结）；`operations.ts` 登记 1 个 agent 可读面 + capabilities 契约更新；响应契约 3 处增字段。
- 前端：档案页待录/待评卷行加「复制评卷指令」；解析模式「已评 n/m」的分母改为可评数。
- 授权注册表：`listPendingL3Grading` 进 agent 可读清单（`tests/http/authorization-registry.test.ts` 需显式登记 —— 「可读」与「可写」分开登记是 D6 的纪律）。
- 无迁移：全部为读面字段 + 护栏条件 + 定格时写已有列。
- **须更新 ADR-0035 的引用**：其决策 3「作用域 = 题纸作用域题目集」被本 ADR 收窄（声明式修订，不改原文）。
