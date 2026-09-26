# 做题回路 P0+P1 · 设计与核验（2026-09-26）

- **分支**：`feat/practice-loop-p0p1`（worktree `wt-loop`，基线 `main@75dd439`，含已合并的 PR #138）
- **范围**：P0（题单定格 / 入口 URL / 术语注册）+ P1（错题库统一投影 / 错题库枢纽）
- **依据**：本轮勘察结论（见下）+ 项目红线（ADR-0004 §6 零 FSRS、ADR-0019 §1 错题库不建表、ADR-0023 服务端权威、ADR-0025 单一代码路径）
- **不在范围**：三模式可见性引擎、上一文件/下一文件、录入面（explanation/evidence/PATCH）、判卷信箱 —— 均为 P2/P3，见文末

---

## 一、勘察发现的四个结构性问题（本轮的设计依据）

| # | 问题 | 证据 |
|---|---|---|
| 1 | **题单不冻结**：`file` 作用域每次现拉题集，开卷后加题会在交卷/评卷时静默变卷 | `services/l3-sheet-scope.ts:15`（改前）走 `listActiveQuestionsForFile`；`l3_submissions` 无题列 |
| 2 | **入口无 URL 契约**：试卷台/练习/错题库/会话只在 `L3Page` 本地 useState 切 section | `pages/L3Page.tsx:51`；`写「返回试卷台」却 navigate("/l3")` 落到空间首页 |
| 3 | **术语未注册**：`CONTEXT.md` 对 试卷/题纸/题型/评卷/评析/定格 命中数为 **0**；UI 又是第三套（「定格」49 次 vs「交卷」1 次） | grep `CONTEXT.md` |
| 4 | **错题库是死胡同且只有一条腿**：只消费 `l3_practice_attempts`；`l3_grading_results.verdict` 全库无查询；唯一动作是跳只读检查器 | `services/l3-practice.service.ts:207`；grep `verdict` 无 wrong 查询；`再练\|重练` 0 命中 |

---

## 二、P0 逐项

### P0-1 题单定格（`87c391c`）

- **决策**：新增 `l3_submissions.question_ids uuid[]`，**开纸时**把作用域题集定格；`resolveSheetScopedQuestions` 以它为唯一题集来源，`null` 才回退现拉。
- **为什么落在开纸而不是交卷**：交卷时冻结已经晚了（未答软确认数会算错）；开纸是"这次做哪几道"的唯一自然时点，且与"一次坐次 = 一行题纸"的既有模型一致。
- **只缩不换**：快照里的题若已删除/非 active，解析时剔除，**不替换成别的题** —— 用户看到的范围只会变窄，不会凭空多出没做的题。
- **存量回填**：由该纸**已物化的 attempts** 派生（`l3_question_attempts` 是唯一作答真源；不得由作用域现拉反推，否则会把开纸后加的题算进历史卷）。含 soft-deleted 行 —— 抹掉成绩 ≠ 这题没做错。WHERE 只认 `question_ids IS NULL`，二次执行零行变化。
- **前端必须同口径**：`scopePaperToFrozenList` 按快照裁剪渲染范围。否则用户会答到卷外的题，那些作答在交卷时被**静默丢弃**（比原来的 bug 更隐蔽）。裁掉时显示「本卷题单已定格 · 题组另有 N 题不在本卷」。
- **写作稿**同样定格单题；撤回注记重开纸**沿用来源纸快照**（不重算 —— 重算会把来源纸开纸之后加入的题算进来）。

### P0-2 / P0-3 入口 URL 契约（`32c4ee7`）

- 规范 URL：`/l3?section=<papers|practice|error-book|session>`。
- 优先级：`writing` > `study-notes` > 本节 > `venue/paper/sheet` 位置参数。非法值 fail-closed 为 `null`，**不静默纠偏**。
- `writing` / `study-notes` **不在此模块定义**（各带 taskId/venue/noteId，契约更窄）—— 一个 URL 契约一个真源（ADR-0025）。
- shell 导航写规范 URL（`replace`，不堆历史）；离开学习笔记子空间时若目标面有契约则直接写规范 URL（否则「笔记 → 练习」后刷新会退回首页）。

### P0-4 术语注册（`30c09f9`）

CONTEXT.md 新增「做题与判卷」一节，12 个词（做题文件/试卷/题纸/题单/定格/题级作答/判定/评卷/评析/原文分析条目/旗标/空位标注/错题条目），每条含 `_Avoid_`；Flagged ambiguities 补 6 条已解决项（三词同指、attempt 三义、两套 verdict、笔记四义、判分三通道、判分三通道）。

---

## 三、P1 逐项

### P1-1 统一投影（`7f4a986`）

- **不建表、不新增真源**：句级真源 = `l3_practice_attempts`，题级真源 = `l3_grading_results`（attempt 永不带判定，ADR-0034 §2）。合并只发生在**读侧**。
- **口径**：句级 `outcome='wrong'`；题级 `verdict IN ('wrong','partial')` —— 「部分对」在错题库里就是没拿下；`correct` 不进。
- **轴过滤各走各的权威**：句级 `l3_source_spaces` EXISTS（与既有句级口径逐字一致）；题级 `l3_questions.space`（录题时由题型自动落标，ADR-0030 §3）。对**题**而言后者才是权威。
- **不提供 cursor**：keyset 游标在两腿间不成立。给一个"看起来能用"的假分页比不给更糟。分页改为合并后 offset。
- **独立服务而非并进 L3PracticeService**：后者的申报边界是"只写 practice_attempts、只读四张表"；统一投影要读 grading/question/submission。混进去等于让边界注释变成谎话。
- 旧端点 `GET /api/l3-practice/error-book` 进入**退役窗口**（`DEPRECATED(句级错题)`，保留至 0.2.0 契约窗口；删除属 breaking，须走 `api:breaking` 审批，不得静默退役也不得无限期保留）。

### P1-2 错题库枢纽（`d62427c`）

- 分区：题级在前（更接近"刚做完的那套卷"），句级在后；标题带本页计数。
- 出口一律**站内生成 URL**（禁止任意 returnUrl / history.back，与 writingNavigation 同纪律）：
  - 句级 → `/l3?section=practice&context=<id>`，练习页**进入即开练**（不要求再点「开始练习」）；
  - 题级 → 题型空间深链（`venue`/`file`/`question`/`resumeSheet`）或 F-1 题纸回看；
  - **无来源且无题纸 → 不给死按钮**，如实说明原因。
- 句级保留「查看语境」：再练是回路，查看是取证，两个出口不互相取代。
- 移除死代码 `ErrorBookDisplayRow` / `buildErrorBookRows`（其"前端按语境去重 + 读 payload 快照"正是口径分裂的来源）。`readPracticeSnapshot` **保留** —— 退役窗口内的单腿端点仍返回该 payload 形状，解析契约仍被测试锁定。

---

## 四、显式偏差与未做项

1. **迁移 0046 本机 PG 实跑未执行** —— 本机 Docker daemon 不可用（同 09-26 阶梯批的已知环境限制）。代替证据：CHECK 与回填的 WHERE 逐分支对齐（二次执行零行变化）、`db:schema:drift` 绿、仓储测试断言 SQL 口径。**实跑责任移交 CI 的 Migration Rehearsal**（PR #138 同名 job 已实证会在真库上演练）。
2. **新增 HTTP 端点 1 个**（`GET /api/l3/error-book`，owner/agent 可读）。`api:governance` 判定未触发 breaking（新端点 + 新可选查询参数）。
3. **未做**：三模式可见性引擎（纯净/做题/解析）、上一文件/下一文件、`explanation`/`evidence` 录入 UI、题目/试卷 `PATCH`、判卷待办队列。理由：P0+P1 的目标是**止住正确性缺陷 + 打通回路 + 停住术语债**；其余四项各自需要独立任务书（且录入面/判卷信箱分别卡在「agent 录题通道」与「grading 版本列」两个未裁决点上）。
4. **题级错题的 `space` 口径与句级不同源**（`l3_questions.space` vs `l3_source_spaces`）。已在本卡内显式记录，但**未**统一 —— 统一需要重开 ADR（两处都是"权威"，且题自带能力域比 source junction 更贴题）。

---

## 五、门禁复跑（本机）

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm run arch:check` | PASS（442 modules / 1948 deps / 0 violations） |
| `npm run test:unit` | PASS（281 文件 collected=on-disk，exit 0；分层覆盖率 ratchet PASS：repository 92.75% lines、http 88.52% branches） |
| `npm run api:governance` | PASS（openapi 再生 + client check + contract 10/10 + breaking 0 issues + 路由复杂度棘轮） |
| `npm run db:schema:drift` | PASS |
| `npm run frontend:build` | PASS |

新增测试：仓储 10 + 服务 8 + 枢纽 VM 15 + 错题库页 15 + 练习页回流 4 + 导航契约 8 + 题单裁剪 9 + 服务层题单 3。

## 六、建议 reviewer 手工冒烟

1. 开一份**题型空间文件**做题 → 定格 → **给该题组再加一道题** → 重新打开该文件：应只看到加题前那几道，且状态条显示「本卷题单已定格 · 题组另有 1 题不在本卷」。
2. 错题库：句级条目点「再练一次」→ 练习页**直接开练那一条**；题级条目点「回看原题」→ 落到题型空间并定位该题。
3. `/l3?section=error-book` 直接访问 / 刷新 / 分享链接 → 都落在错题库。
4. 切换侧栏到「练习」→ 看地址栏是否出现 `?section=practice` → F5 后仍在练习页。
5. 题纸加载失败态点「← 返回试卷台」→ 应回到**试卷台**（不是空间首页）。
