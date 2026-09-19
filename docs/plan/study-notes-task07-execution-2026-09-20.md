# 学习笔记 N1 · Task 07 执行台账（client / 保存控制器 / 基础编辑器）（2026-09-20）

> 范围：Task 07 = 文档纠偏 → `studyNotesClient`（Task 06 延期项）→ 可靠保存控制器 → hook/基础编辑器 → 最小联调宿主 → 真实浏览器 + 隔离 PG 验收 → 工程门禁。
> 纪律：本台账**不预填通过**——每项仅在真实命令/证据产生后更新；命令、退出码、提交、测试与未覆盖项分别如实记录；先红后绿适用于行为修复与新增功能；文档不写镜像测试。
> 执行仓库（本轮）：`D:/Temp/vocab-ob-n1-editor`（独立 clone；分支 `study-notes-n1-editor`；单执行者串行负责 Git 写入，只读复核另行独立）。
> 停止点：**停于 Task 08 之前**（不开发列表/专题管理/分页导航/引用侧栏/导出；不合并、不部署）。

## 0. 基线与依赖（实测）

| 项 | 值 | 证据 |
|---|---|---|
| 预期起点 | `study-notes-n1-backend@d234868c7a754d1d720cb998257de968dad6116b` | 执行提示 §1 |
| 主执行仓库 HEAD | `d234868`（= 预期起点；工作区干净） | `git log -1`、`git status --porcelain`（空） |
| 主仓库完整性 | `git fsck --full --no-reflogs` **exit 0**（无缺失/损坏对象输出） | 命令回显（主审曾遇 c31724e 读取 Permission denied；本轮复核 fsck 通过，未手工修对象） |
| 远端核对 | `origin/study-notes-n1-backend=d234868`；`origin/integration/l3-reliability-writing=b7dcea4e26b799b05a9b6312d9694908026c4e01` | `git fetch` + `git rev-parse` / `git ls-remote` |
| 依赖 PR | #126 OPEN / **draft** / base=`integration/l3-reliability-writing` / head=`study-notes-n1-backend@d234868` | `gh pr view 126 --json …` |
| 独立 clone（本轮） | `D:/Temp/vocab-ob-n1-editor`（`git clone --branch study-notes-n1-backend`） | clone 输出 `CLONE_EXIT=0`（969 文件 checkout） |
| 开发分支 | `study-notes-n1-editor` @ `d234868`（从核对过的后端 HEAD 起） | `git checkout -b` + `git rev-parse HEAD` |
| 工具链 | Node v22.22.2 / npm 10.9.7（`.nvmrc` 一致） | `node --version` / `npm --version` |
| 分支保护 | 不合并、不强推、不推 main、不改他人 PR base | 纪律声明（动作在 §7 留痕） |

### 0.1 环境备注（fs 行为与运行位置）

- 本机 fs 行为按**目录位置**分化（既有定位，见 `study-notes-engineering-closeout-2026-09-20.md` §2.3/§2.5）：Temp 类目录为快区；多数其它位置为慢区（≈4.1s/轮）且**偶发永久挂起**。
- 本轮工程门禁运行位置：**`D:/Temp/vocab-ob-n1-editor`（常规开发目录）**。不使用 `C:\Windows\Temp` 等依赖 `os.tmpdir()` 检测缺口的位置（守卫遗漏观察项见 §8.3）。
- `vitest run --coverage` 若出现收尾挂死：**保存证据并如实记录，不强制 exit0、不降阈值**；重试与结果分别记账。

## 1. 开工纠偏（先于实施；含实证校准）

执行提示 5 条纠偏已同步进 `study-notes-frontend-tasks-2026-09-20.md`（文档内以「2026-09-20 纠偏/校准」标注）：

1. **S4**：删除「新内容 T2 可复用 R1」例外——只有**完全相同的未确认请求**重试才复用其 requestId；T1 确认后发送 T2 必须**新 requestId R2、新确认版本 V2**。
2. **S10/S11/N10**：不得断言「失败/dispose/不导航 = 数据库无写」——请求可能已提交但响应丢失；正确断言为**不误报确认、不接受旧代回包、不继续导航**；实际结果以**库核**为准。
3. **冲突态**：删除「确认已合并后重试」；本批仅提供**复制本地内容**与**显式载入服务器版本**；载入成功后重新编辑，以**新 requestId 和新基线**保存；不做自动合并、不做强制覆盖。
4. **根因口径**：既有「根因已定位、非仓库代码问题」校准为「**挂起点与环境差异已定位；系统层根因未闭环**」；覆盖率完整自然退出的日志保留，不宣称原环境已修复（closeout/repair 已同步标注）。
5. **Windows Temp 守卫遗漏**：登记为**独立观察项**（运维合同要求演练锁在所有临时目录之外，`scripts/run-alerting-drill.ts` 实现仅检测 `os.tmpdir()`）；本批不修改告警系统，不靠该缺口制造门禁绿色。

### 1.1 实施前逐条核对后端消费合同（12 操作）后的**两处实证校准**

任务书 §0.1/§1.2 与旧稿有差异，按「实际路由与 response-contract 为准」核对后修订任务书：

| # | 旧稿表述 | 实测合同 | 证据 |
|---|---|---|---|
| C1 | preview 入参 `{target}` 包装 | **`ReferenceTarget` 本体**（`{kind:"source",sourceId}` 等直接作为 body） | 路由 `study-references.ts` 直接 parse `l3StudyReferenceTargetSchema`；`operations.ts:588` body 同 schema；HTTP 测试 `body: JSON.stringify({ kind: "source", sourceId })` 且断言 service 收到无包装对象；`generated/openapi.ts` requestBody 直接 union；设计文档 §7「ReferenceTarget → {preview}」 |
| C2 | 布尔以字符串 `true/false` | **`"1"/"0"`**（`pinned`/`unfiled` 均为 `enum(["0","1"])`） | `l3StudyNoteListQuerySchema`；openapi `pinned?: "0" | "1"`；HTTP 测试 `…&pinned=1&…` |

以下为**未被旧稿写明但已核实的合同细节**（实现与测试直接采用）：
- 列表响应为 `StudyNoteSummary`（**不含** `bodyMd`/`references`）；详情/保存响应 `{item}` 为 `StudyNoteDto`。
- DELETE 成员操作为 **JSON body**（`{requestId, expectedVersion}`）；PUT 成员为 `{requestId, expectedVersion, beforeNoteId: uuid|null}`。
- `nextCursor` 为 `string | null`，**原样透传不截断**；`limit` 默认 20、最大 50。
- 409 的 `meta.currentVersion` 非必有（成员操作/幂等冲突等 409 可能不带）；缺失时**不猜数值**。
- 无 `export` 端点（Task 10），client **不提供**该假接口。

## 2. 实施记录

（以下各阶段在产生真实命令/证据后逐段更新；未完成项保持空白/标注。）

### 2.1 Phase A · `studyNotesClient.ts`

- 状态：待实施。
