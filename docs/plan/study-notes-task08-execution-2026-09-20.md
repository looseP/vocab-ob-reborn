# N1 · Task 08 执行台账 · 笔记空间、专题、分页与导航（2026-09-20）

> 执行仓库：`D:/Temp/vocab-ob-n1-task08`（独立 clone，独立 Git 对象库；单写者）
> 分支：`study-notes-n1-task08`；实际 base = `study-notes-n1-editor@259415f`（含 Task 07 全部补修）
> 依赖：PR #127（study-notes-n1-editor → study-notes-n1-backend → #126 → #125），本批 PR base=study-notes-n1-editor
> 纪律：先红后绿；HUSKY=0 + Git 写后核验；不合并/不 retarget/不部署/不推 main；停止在 Task 09 之前。

## 0. 基线与范围

- 基线核对：编辑器仓库 HEAD=`259415f`（= 远端 study-notes-n1-editor；PR #127 OPEN/draft、base 未变）；`git fsck --full --no-reflogs` exit 0；工作区干净。
- 工作区：本地 clone（`--no-hardlinks`，独立对象库）→ `D:/Temp/vocab-ob-n1-task08`；分支 `study-notes-n1-task08`（自 259415f）；npm ci exit 0（451 包）。
- 范围：七题型入口、显式创建纪律、列表/搜索/分页/游标、专题创建/重命名/成员调整/刷新、noteId 深链（身份/所有权校验）、URL 状态恢复、返回/F5/前进后退、离页 flush 屏障、双标签 409。
- 不在范围：Task 09（引用侧栏/原位引用/新 capture）、Task 10（导出）、N2；不迁移数据；不改保存协议。

## 1. 设计决策（先于实施）

1. **导航模型**（`studyNoteNavigation.ts`）：规范 URL `/l3?section=study-notes[&venue=][&topicId=][&noteId=][&refId=]`；`parseStudyNoteNavigation` 严格校验（venue 枚举 / UUID），`buildStudyNoteUrl` 唯一构造入口；`noteId` 缺 venue = 无效入口（结构化错误，不纠偏）。
2. **深链打开纪律**：页面先以 GET 完成身份/所有权校验（含 `venue ∈ note.venues`），通过后才挂载编辑器；404/无权 = 空态（不泄露、不创建替代）；refId 不存在 → 提示「该引用已移除」但保留打开。
3. **创建纪律**：唯一 POST 入口 = 显式「新建笔记」；requestId 在创建及重试间稳定；成功后 `replace` 到 note URL；双击守卫；GET/F5/历史/翻页/深链一律零创建。
4. **分页/筛选**：`studyNoteListModel`（纯 TS）——筛选变化清 cursor 重起；跨页按 id 去重；total 透传；搜索 300ms 防抖 + 请求序号守卫（旧响应丢弃）；cursor 原样透传。
5. **专题串行协调**（`studyTopicCoordinator.ts`）：同一时刻至多一个写操作在途（串行队列）；expectedVersion 在执行时从「本地最近服务端版本」读取；响应即更新本地版本；409 → 停写 + 显式刷新前禁止该专题后续写。
6. **离页屏障**：站内导航（返回列表/打开另一篇/切 venue/shell 离开）统一经 `requestNavigation`（flush→成功才执行）；浏览器前进后退经 `studyNoteHistoryGuard`（popstate + 哨兵条目：单步取消、flush 成功才续行；失败留原位）。F5/关闭 = beforeunload 诚实提示（不承诺异步保全）。
7. **两栏工作区**：桌面 list + editor 双栏（深链 note 在列表高亮）；移动单栏切换；`topicId` 在 URL（F5 恢复），`q/status/unfiled/pinned` 为本地态（规范 URL 仅含 venue/topicId/noteId/refId）。
8. **笔记归档/恢复**：列表行动作 → GET 最新快照 → PUT 完整快照（status 切换、新 requestId、expectedVersion=GET 版本）→ 刷新列表；不做多入口裸 PUT、不猜版本。

## 2. 实施记录（先红后绿）

### 2.1 新增（本批）

| 文件 | 角色 |
| --- | --- |
| `src/frontend/viewModels/studyNoteNavigation.ts` | URL 解析/构造（严格校验 + 无效入口标记） |
| `src/frontend/state/studyNoteHistoryGuard.ts` | 前进/后退 popstate 屏障（纯逻辑核心，假历史栈可注入） |
| `src/frontend/hooks/useStudyNoteHistoryGuard.ts` | 接入 window.history + 路由感知 cancelTo |
| `src/frontend/state/studyNoteListModel.ts` | 列表模型（筛选清 cursor / 跨页去重 / 防抖 + 序号守卫） |
| `src/frontend/state/studyTopicCoordinator.ts` | 专题串行写 + 服务端版本 + 409 停写 |
| `src/frontend/components/studyNotes/StudyNoteList.tsx` | 列表（行动作：打开/归档/成员上下移/加入专题/加载更多） |
| `src/frontend/components/studyNotes/StudyTopicPanel.tsx` | 专题面板（创建/重命名/选择/未整理/刷新） |
| `src/frontend/pages/L3StudyNotesPage.tsx` | 工作区落地：深链校验 + 双栏 + 屏障注册 |
| `e2e-study-notes/study-notes-workspace.spec.ts` | 九场景真实浏览器验收 |

修改：`StudyNoteEditor`（新增 `leaveAction` 离开动作）、`l3ShellViewModel` + `L3Page`（新增「学习笔记」入口与 shell 级屏障复用）、`L3PapersPage`（入口页签）。

### 2.2 测试（先红后绿；`tests/frontend` 全量 45 文件 / 583 用例 exit 0）

| 测试文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `study-note-navigation.test.ts` | 12 | URL 解析/构造往返、非法 venue/uuid、无效入口 |
| `study-note-history-guard.test.ts` | 11 | 哨兵吸收、跨步、越过取消、续行消费、异常防护、**迟到激活不截断前进栈** |
| `study-note-list-model.test.ts` | 12 | 筛选清 cursor、topicId/unfiled 互斥、序号守卫、跨页去重 |
| `study-note-topics.test.ts` | 10 | 串行写、版本取自响应、409 停写、创建幂等 |
| `study-notes-page.test.tsx` | 17 | 浏览零 POST、显式创建恰一次、深链/未授权、离页屏障、双标签 409 |

先红后绿：五个测试文件均先于实现编写（实现前无对应组件/模型，全部红），随后最小实现转绿。修复类新增用例（2.3-2 迟到激活）另做**变异证明**：临时还原守卫条件后该用例必红（§4）。

### 2.3 E2E 定位出的三个真实缺陷（本批修复；非测试妥协）

1. **④ 未整理视图下「加入专题」恒不生效**：`runMemberOp` 从 `nav.topicId` 取目标专题，而未整理视图按设计已把 `topicId` 移出 URL（与 `unfiled` 互斥）→ 目标恒为 `null` → 早退，库内无成员写入。修复：`runMemberOp(topicId, task)` 显式接收目标，加入动作以行内所选专题为准。
2. **⑤「后退到列表再前进」回不到笔记**：后退落回列表的那一次渲染里 `pane.status` 仍是 `ready`（清空 pane 的 effect 未跑），屏障以 `pane.status` 判定激活 → 在**列表 URL 上迟到激活**，压入哨兵（浏览器语义：pushState 截断前进栈）→ 前进条目被销毁。修复两层：(a) 页面 `enabled` 追加 `nav.noteId !== null`（以 URL 为准，消除迟到窗口）；(b) 核心加不变量「仅当当前 href = 编辑 URL 时才吸收」，并以新增单测做**变异证明**（临时还原该条件 → 该用例必红，见 §4）。
3. **⑦ 双标签用例自身缺陷**：第二标签取自同一 browser context（已共享 session cookie），再调 `loginAsOwner` 会等不到 `#owner-token` 而超时。修复：不做重复登录，直接复用 context 会话。

### 2.4 定位手段（可复用）

后退链路无头可观测性差，采用**历史栈插桩**（`pushState/replaceState/go` 包装 + popstate 记录 `href/len/idx/marker`）一次性拿到机制：`popstate(编辑条目) → go(-1) → popstate(列表) → push(列表URL+marker, len 5→4)`，直接坐实「迟到激活 + 前进栈截断」。插桩文件用后即删，未进入提交。

## 3. 真实浏览器 + 隔离 PG 验收

- 库：`vocab_study_notes_task08_accept`@127.0.0.1:5433（专属空验收库，spec 内**显式校验库身份**，非该库直接抛错）；40 迁移；`vocab_local_pg` 容器。
- 服务：真实源码直跑（`SERVE_FRONTEND=true`，PORT=3097，`OWNER_API_TOKEN` + `LOCAL_OWNER_ID`），真实 session/CSRF + 真实 PG；前端以 `VITE_N1_STUDY_NOTE_HOST=1` 显式构建。
- 命令：
  `DATABASE_URL=<app> E2E_SETUP_DATABASE_URL=<migration> node node_modules/@playwright/test/cli.js test --config=playwright.study-notes.config.ts`
- 结果（`D:/tmp/t08-e2e3.log`，exit 0）：**19 passed (1.6m)** —— 本批 9 场景 + Task 07 宿主 10 场景（回归未被破坏）。

| 场景 | 断言要点 |
| --- | --- |
| ① 浏览零创建 | 入口→题型→搜索命中/未命中/清空：`POST` 计数 = 0，库计数不变，列表 GET ≥ 3 |
| ② 显式新建恰一次 | 在途按钮 disabled；恰 1 次 POST；库 +1 |
| ③ 分页游标 | 首页无 cursor；加载更多带 cursor；25 行 id 去重；切筛选后 cursor 清空 |
| ④ 专题 | 创建/未整理加入（加入后离开未整理列表）/成员上移 → **库内 position 顺序交换**；F5 后顺序稳定 |
| ⑤ 深链/F5/返回/前进 | 深链与 F5 均 GET 恢复同一 noteId；返回→列表→前进→同一篇；全程零创建 |
| ⑥ 离页 flush | 成功离开并落库；PUT 断链 → 留原位 + 输入保留 → 重试后离开并落库 |
| ⑦ 双标签 409 | 标签一推进服务端版本；标签二真实 409 → 冲突面板、本地输入保留、库未被子静默覆盖；显式载入服务器版本 → 新基线保存（库核） |
| ⑧ 未授权深链 | 「不存在或无权访问」空态；零创建；库计数不变 |
| ⑨ 在途禁止错误导航 | 保存未落定停留在原位并提示；落定后才离开并落库 |

证据留存：`D:/tmp/t08-e2e3.log`（终态 19 通过全文，exit 0）；修复前的失败态记录见 `D:/tmp/t08-e2e1.log`（2/9）与 `D:/tmp/t08-e2e2.log`（6/9，含 ④⑤⑦ 完整错误与调用栈）；历史栈插桩原始输出见 `D:/tmp/t08-probe.log`。终态 `test-results/` 为空（无失败产物）。

## 4. 工程门禁

复核位置 `D:/Temp/vocab-ob-n1-task08`；聚合入口 `npm run verify:engineering`（typecheck → arch:check → test:unit → db:schema:drift → api:governance → frontend:build → runtime:verify → alerting:verify → release:acceptance:contract → secret-rotation:evidence:contract → release:workflow:verify）。

### 4.1 首轮全量（`D:/tmp/t08-gate.log`，exit 1）

- typecheck ✓；arch:check ✓（416 模块 / 1820 依赖，零违规）；test:unit 阶段 **3755 用例：17 失败 / 3732 通过**。
- 17 例中 **2 例为本批真实回归（已修）**，均因「新增一级入口 + 新增页面」未同步既有断言锁：
  1. `tests/l3-frontend-shell.test.ts > keeps implemented L3 frontend files away from local network calls`：L3 页面的类型化 client 白名单未含学习笔记客户端 → 白名单显式扩充 `studyNotesClient`（规则意图不变：L3 页面必须走类型化 client，禁裸 fetch）。
  2. `tests/l3-frontend-shell.test.ts > locks the Phase 4I shell navigation matrix`：shell 导航矩阵锁未含 `{ id: "studyNotes", label: "学习笔记" }` → 在 `writing` 之后登记（矩阵锁的正用法）。
- 其余 **15 例全部集中在 `tests/scripts/run-alerting-drill.test.ts`**（环境级联，见 4.2）。

### 4.2 环境故障根因（本轮首次闭环定位；与本批代码无关）

沙箱注入 `node-safe-delete-shim.cjs` 拦截 `fs.rm/unlink`，按 **turn** 累计删除量计数：`{"count":2187,"threshold":50,"scope":"turn"}` 超阈即抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`。本 turn 删除量主要来自本轮 `frontend:build`（vite 清空 `dist/`）。三类后果：

| 现象 | 证据 | 性质 |
| --- | --- | --- |
| 演练锁残留 → 同文件 15 例 `EEXIST` 级联 | `afterEach` 的 `unlink(.alerting-drill-test-<pid>.lock)` 被拒且 code ≠ ENOENT → 重新抛出 → 锁留存 → 后续用例全部「已有告警演练锁」 | 环境。**该文件单独运行 31/31 全绿**（`D:/tmp/t08-two.log`） |
| `vitest run --coverage` 启动即中止 | `V8CoverageProvider.clean` 清理 `coverage/.tmp` 被拒（`D:/tmp/t08-s1.log`） | 环境。故本轮无覆盖率产物 |
| `db:schema:drift` exit 1 | 脚本先输出 `[schema-drift] OK — search vector and owner RLS policies match authoritative contracts; SECURITY DEFINER functions match authoritative contracts`，随后仅因清理 `.drift-check.config.ts` 被拒而失败（`D:/tmp/t08-s4.log`） | 契约断言实为通过 |

**纪律遵守**：未删除残留锁、未下调阈值、未以代码/环境变量绕过护栏。残留 `tests/scripts/.alerting-drill-test-36976.lock`、`.alerting-drill-test-1728.lock` 原样留在盘上且**未纳入提交**（构建产物 `dist/`、`.tmp/` 同理由 .gitignore 排除）。
**复跑条件**：需在「本 turn 未发生批量删除」的干净会话重跑（本轮删除预算已被自身构建耗尽）；上述两处清理一旦不被拦截即可自然通过。

### 4.3 分阶段退出码

| 阶段 | 退出码 | 说明 |
| --- | --- | --- |
| typecheck | 0 | `tsc --noEmit`（全部改动后复跑仍 0） |
| arch:check | 0 | 416 模块 / 1820 依赖，零违规 |
| vitest 全量（无覆盖率） | 1 | `250 passed / 1 failed / 1 skipped`（文件）；`3734 passed / 15 failed / 6 skipped`（用例）——**失败全部为演练锁级联，真实回归 0** |
| test:collection | 0 | 测试收集校验 |
| coverage:layered | 1 | 无覆盖率产物（4.2 拦截所致，非阈值不达） |
| db:schema:drift | 1 | 契约断言 OK，仅临时文件清理被拦 |
| api:governance | — | 子步：api:openapi ✓ / api:client:check ✓ / api:contract ✓(10) / api:breaking ✓(补 `API_CONTRACT_BASE_REF=259415f` → 「未发现 breaking change」) / api:breaking:contract ✓(10) / complexity:routes ✓（route ratchet passed） |
| frontend:build | 0 | `VITE_N1_STUDY_NOTE_HOST=1` 显式构建 |
| runtime:verify | 0 | |
| alerting:verify | 0 | 告警契约校验（与 4.2 的演练**锁**用例不同层） |
| release:acceptance:contract | 0 | |
| secret-rotation:evidence:contract | 0 | |
| release:workflow:verify | 0 | |

### 4.4 终态复跑（2026-09-20 16:52–17:15，当前代码定稿后）

- `tests/frontend/study-note-history-guard.test.ts` 单独复跑 **11/11 绿**（16:52）；`tests/l3-frontend-shell.test.ts` 单独复跑 **46/46 绿**（16:54）——首轮 17 失败中的 2 例真实回归（4.1）确认已修复。
- 慢区（`D:/Temp/vocab-ob-n1-task08`）串行复跑：typecheck=0、arch:check=0、**db:schema:drift=0**（本轮 turn 无历史删除量 → 清理不被拦，契约断言自然通过，`.drift-check.config.ts` 临时产物已消失）、**api:governance=0**（`API_CONTRACT_BASE_REF=origin/study-notes-n1-editor`（=259415f），api:breaking 未发现 breaking change）、test:collection=0、runtime:verify=0、alerting:verify=0、release:acceptance:contract=0、secret-rotation:evidence:contract=0、release:workflow:verify=0。
- **快区隔离复跑**（`C:/Windows/Temp/t08-verify` 为本批独立 clone，`npm ci` 后）：`vitest run --coverage` **247 文件：246 passed / 1 skipped / 0 failed**——含 `run-alerting-drill.test.ts` 全绿，证实 4.2 演练锁级联为环境量（turn 删除预算）所致、与代码无关；覆盖率表完整产出（`coverage/coverage-final.json`、`coverage-summary.json`）。
- vitest 收尾 `cleanAfterRun` 清理 `coverage\.tmp`（281 文件）仍被 safe-delete 拦截 → `&&` 链断在 coverage:layered 之前。**补充定位：该拦截与快/慢区无关**，按「单次调用删除文件数 > 50」触发，全量覆盖率跑必然触发（此前 n1-verify-c 能退出 0 系当时产物量较小）。
- `coverage:layered` 补跑 → fail-closed：diff gate 只测量 **已提交**变更（HEAD 仍 = base 259415f，本批未提交时 base…HEAD diff 为空）。故顺序调整为：**先提交 → 再以 `COVERAGE_BASE_REF=origin/study-notes-n1-editor` 复跑**（结果见 §5）。
- E2E 证据时间线核验：`t08-e2e3.log`（16:31）晚于全部实现改动（`L3StudyNotesPage.tsx` 16:22、`studyNoteHistoryGuard.ts` 16:28）→ §3 的 19/19 对应终态代码，证据有效。

**未触发（真实 CI，口径校准）**：`ci.yml` 的 Engineering Gate / Browser E2E 仅在 `push/main` 与 `pull_request → base=main` 触发——本 PR base=`study-notes-n1-editor`，**这两项不会因开 PR 自动运行**；Writing E2E 为独立工作流、支持所有 PR（#128 上可见 pending/运行）。学习笔记 E2E 使用独立配置（`playwright.study-notes.config.ts`），**不在默认浏览器 CI 收集内**，Writing E2E 通过不替代它。最终远端 CI 结果以 GitHub 实时查询为准。

## 5. 提交、推送与 PR

- 状态：进行中（见文末提交与 PR 记录）。
- 提交后 coverage:layered 复跑（快区 `t08-verify` ff 至 4deb972，`COVERAGE_BASE_REF=origin/study-notes-n1-editor`）：**exit 0**，baseline ratchet 通过，functional evidence matrix 完整（`D:/tmp/t08-layered3.log`）。
- **口径校准（独立复核纠正）**：该日志明确记录 `Diff coverage ... N/A — changed src files exist outside governed layers`（12 个 changed src、0 个 governed）——本批前端增量**不在 diff 覆盖率测量范围内**；98.18/95.09/93.83/91.67 是 domain/service/repository/http 四个**后端层的总体覆盖率**，不得表述为「本批前端 diff 四层全 PASS」。门禁 exit 0 成立，但含义以上述为准。

### 5.1 提交记录（工作区 `D:/Temp/vocab-ob-n1-task08`，HUSKY=0，逐文件点名暂存）

| SHA | 段 | 内容 |
| --- | --- | --- |
| `bd66f40` | feat | 学习笔记消费工作台：列表/游标/专题/深链/URL 态/导航屏障 + shell 接线（12 文件 +2178） |
| `c1978fb` | test | 61 单测/组件 + 9 场景浏览器 E2E + shell 白名单与矩阵锁同步（7 文件 +1992） |
| `4deb972` | docs | 执行台账（§1–§7；本表为此后追加） |

提交后核验：`git status` 干净；`git fsck --no-dangling` 无损坏；分支 `study-notes-n1-task08`（HEAD=4deb972）。

### 5.2 推送与 PR

- 推送：`study-notes-n1-task08` → `origin`（新分支，upstream 已设；后补 `1f589be` 前的 4 提交一次推送）。
- PR：**#128**（draft）`study-notes-n1-task08` → `study-notes-n1-editor`，https://github.com/looseP/vocab-ob-reborn/pull/128 ，依赖 #127 → #126 → #125。
- CI：三项必需检查由 PR 触发，本地不等候（以本地等价验证为准，见 §4）。

## 6. 未覆盖项与观察项

**本批未覆盖（边界声明）**
- Task 09（引用侧栏 / 原位引用 / 新 capture）、Task 10（导出）、N2 阶段：**未开始**，本批未触碰其契约与路由。
- 移动端单栏切换：实现存在（双栏为 `md:` 断点以上），E2E 仅覆盖桌面视口。
- 虚拟滚动：未做（20 条/页 + 显式「加载更多」，非无限滚动）。
- 专题重命名/归档在 E2E 中只覆盖「创建 + 选择 + 成员调整」，重命名仅有单测覆盖。

**观察项（有意取舍，非缺陷）**
1. 前进/后退哨兵会多占用一条历史条目：从笔记后退需两步到列表（第一步被哨兵吸收，视觉原位）。前进回到笔记时以 URL 为真源重新 GET，不重复创建。
2. 深链加载中（`pane=loading`）未挂载屏障：此阶段无本地未保存内容，后退不拦截；就绪后立即接管。
3. `q/status/unfiled/pinned` 为本地筛选态，F5 不恢复（规范 URL 只含 `venue/topicId/noteId/refId`），与设计 §1.1 一致。
4. 归档/恢复为「GET 最新版本 → PUT 完整快照」两步（非原子），并发下由服务端 CAS 与 409 面板兜底。
5. 沙箱删除护栏（§4.2）为本机环境特有；真实 CI 不含此护栏，故 CI 侧不预期复现。
6. 本机 fs 快/慢区分化仍在（前批已记录）：本批 E2E 与门禁均在 `D:/Temp/...` 下运行，未出现 coverage 收尾挂死（本轮挂死被护栏提前拦截，机制不同）。另据 §4.4：safe-delete 对 `coverage\.tmp` 的拦截与快/慢区无关，按单次删除文件数触发。

## 7. 停止点声明

- 完成后停在 Task 09 之前；不合并、不 retarget、不部署、不推 main。
