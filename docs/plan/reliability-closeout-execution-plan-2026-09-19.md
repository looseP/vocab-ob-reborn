# Git 事故收尾与保存可靠性补强 Implementation Plan

> For agentic workers: 使用 executing-plans 执行，修复遵循 systematic-debugging 与 test-driven-development；交付遵循 verification-before-completion。一个执行者顺序完成；不得派多个执行者同时修改共享 Git 元数据或同一保存控制器。

**Goal:** 默认 Git 完整性检查恢复正常且有可验证备份；保存订阅状态准确；普通题纸以客户端确认版本保护 PATCH/定格，逐题脏队列不重发旧答案。

**Architecture:** 先修复共享 Git 的可重建索引，不触碰业务对象与工作区内容。随后延续现有 wt-reliability，保留 Task A 修复，补通知合同与题纸的前后端版本合同；使用已有 draft_version，不另造数据模型。

**Tech Stack:** Windows PowerShell、Git；Node 22.22.2 / npm 10.9.7；TypeScript、React、Hono、Zod、PostgreSQL、Vitest、Playwright。

## Global Constraints

- 本文件是下一轮计划，不是完成报告；本轮仅写文档，未修 Git 或业务代码。
- 本次观察：main=`ccc6fb4c90f45c6e13f0d581298bb617a79baac2`；wt-reliability=`3c906a3`，含 Task A `56fabdd`；Task B 有未提交修改。执行前重新读取，不 reset 到这些旧 SHA。
- 包根 `D:/Temp/Myawesomeapp/vocab-ob'/wt-reliability`；共享 Git 实测位于 `D:/Temp/Myawesomeapp/vocab-ob'/wt-main/.git`，必须用 rev-parse 再确认。外层目录不是 Git 仓库。
- 四工作区：wt-main、wt-reliability、wt-writing、wt-practice。后两者已有作文相关工作，当前任务不得清理、改分支、reset、覆盖或重建其索引。
- 先接管已有执行者的任务并确认其停止写入，再接续该 worktree；不能在另一个新 worktree 重做未提交 Task B。仅 Git worktree 隔离并不能隔离共同对象库。
- Git 修复期间：所有会话暂停共享仓库的 commit/add/stash/fetch/checkout/reset/maintenance/gc、worktree 管理；避免 npm ci/install/prepare 再改 hooksPath。暂停自动 Git 后台维护/IDE 自动 fetch。进程清单只能辅助检查，不能代替与实际写入者确认；不任意杀进程。
- HUSKY=0 仅作为本批次临时隔离措施。不能声称 Husky 是删除根因；不能永久禁用质量门禁，也不能用 fsck 的命令级例外作为最终通过。
- 不运行 prune/gc/repack、filter-repo、reset --hard、clean、worktree remove/prune。所有隔离均移至独立证据目录保留，禁止递归删除。
- 测试只用独立验收库/fixture owner，不改真实 dev 业务数据，不新增依赖、离线存储、学习笔记、分页或完整翻译工作台。
- 本轮只补用户列出的 Git/通知/版本/脏键四项；原 Task C 入口工作在本轮门禁通过后再续。无需借此重构全站。
- 本计划运行命令必须在标注目录执行。所有原生命令单独捕获 LASTEXITCODE，失败立即处理，不能用最后一个命令的成功掩盖前项失败。

## 证据与任务依赖

先读仓外：`D:/Temp/Myawesomeapp/vocab-ob'/build-analysis/status-2026-09-19/可靠性批次阶段复核.md`。原始 Git 日志为同目录 `git-fsck-review.log`、`git-fsck-no-midx-review.log`。原任务书为 `docs/plan/reliability-batch-dispatch-2026-09-19.md`，执行台账为 wt-reliability 内 `docs/plan/reliability-batch-execution-2026-09-19.md`。

依赖：G0 单写者/备份 → G1 索引隔离/复验 → G2 独立恢复演练 → S 通知合同 → V 版本合同 + Q 脏题队列 → E 真库/浏览器/工程验收。V/Q 可分提交，但必须作为同一可发布单元验证。

## G0：建立单写者与可核验快照

**修改范围：** 只新建仓外证据目录；暂不修改共享 .git。

- [ ] 与现有 Task B 执行者完成交接，记录停止写入时间和未完成事项。仍无法确认静默时，只做只读检查，不移动元数据。
- [ ] 设置本进程 `GIT_OPTIONAL_LOCKS=0`，减少 status 等读取触发可选索引刷新；记录环境、Git 版本及配置来源。它不是互斥锁。
- [ ] 在 wt-reliability 用以下命令定位；校验解析后的 common dir 必须精确等于目标仓库共享 .git；若不一致，停止依赖操作并解释，不按猜测移动。

```powershell
$env:GIT_OPTIONAL_LOCKS = '0'
git --version
git rev-parse --path-format=absolute --git-common-dir
git rev-parse --path-format=absolute --git-dir
git worktree list --porcelain
git show-ref
git config --show-origin --get core.hooksPath
git config --show-origin --get core.multiPackIndex
```

get 配置退出1可以表示未设置，应单独解释，不当作事故。备份目录使用时间戳避免覆盖既有证据：

```powershell
$relRoot = "D:\Temp\Myawesomeapp\vocab-ob'"
$relCommon = [IO.Path]::GetFullPath((Join-Path $relRoot 'wt-main\.git'))
$relEvidence = Join-Path $relRoot ('build-analysis\git-closeout-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $relEvidence -ErrorAction Stop | Out-Null
Copy-Item -LiteralPath $relCommon -Destination (Join-Path $relEvidence 'git-common-before') -Recurse -Force -ErrorAction Stop
```

- [ ] 为整个 common dir 建相对路径/长度/SHA256 清单并对副本逐文件校验，包括 index、refs、logs、worktrees 元数据、objects、pack、config、hooks；不要仅复制 pack。若有 alternates 或 .git 外的实际对象存储，也纳入备份，不假设全部自包含。
- [ ] 对四 worktree 分别记录 HEAD、branch、status porcelain、暂存/未暂存二进制 diff 和未跟踪路径；备份修改/删除涉及文件及所有未跟踪用户文件（包括 ignore 中实际存在的用户文件）。依赖/可再生缓存可以明确列出排除项，不能把 secrets/本地资料当缓存漏掉；备份含敏感数据只本地保存，不在日志打印内容、不上传。
- [ ] 用 `git diff --binary --output=<绝对文件>` 和 `git diff --cached --binary --output=<绝对文件>` 保留差异，直接复制当前工作文件；记录删除项。暂存状态依赖前述每个 index 的副本，不运行 reset 重建。文件枚举采用 NUL 分隔解析或结构化文件 API，正确处理空格/单引号，禁止拼接到 cmd /c。
- [ ] 同时保存 refs/HEAD/status/文件 hash 的“前后对照表”，供 G2 确认修复未改业务状态。备份文件 hash 不一致或源仍在变化则不进入 G1。

**退出标准：** 有单写者确认、全量元数据副本、工作内容与暂存状态备份、校验清单。记录位置但不承诺找回事故前已经丢失的 reflog/暂存快照。

## G1：隔离残留索引，默认 fsck 通过

**修改范围：** 只允许经验证的 .git/objects/pack 下的可重建索引；所有旧文件保留到证据目录。禁止修改 pack 数据文件、refs、HEAD 或任一工作区 index。

- [ ] 重新执行并分别记录默认与例外检查：

```powershell
git fsck --full --no-reflogs
git -c core.multiPackIndex=false fsck --full --no-reflogs
git -c core.multiPackIndex=false rev-list --objects --all --missing=print
git count-objects -v
```

期望复核既有“默认32、例外0、没有 ?缺失对象”；若已被其他执行者修复，不重复移动文件，直接审查其证据。若禁用索引后仍有 missing/corrupt，进入对象恢复调查，停止本方案的索引修复假设。

- [ ] 列出所有 idx 及同名 pack 是否存在；以下只是已知候选，实际存在且无配对才隔离：
  - `pack-218263ae1098e5b171ccd86e696bfd61e47adce6.idx`
  - `pack-561ca5cd1c202cdb88089efad275b1793c85644f.idx`
  - 旧 `multi-pack-index`
- [ ] 对有效 idx/pack 执行 `git verify-pack <idx绝对路径>` 并保存退出码。不要用 -v 把所有对象刷屏；不要把 orphan idx 当有效 idx 校验。
- [ ] 隔离操作：先验证绝对目标位于已确认的 pack 目录内，备份已校验；将三个确认为残留的索引逐一 `Move-Item -LiteralPath ... -Destination ... -ErrorAction Stop` 到 `$relEvidence/quarantine`。不要对 *.idx 批量移动，不移动现有 pack 的有效 idx/.rev。若发现新版增量 MIDX chain，先检查当前 Git 文档与文件引用关系，不能套用三个文件规则盲动整个目录。

单文件操作示例（其他两个根据现场“无对应pack”结果逐项执行）：

```powershell
$relPackDir = Join-Path $relCommon 'objects\pack'
$relQuarantine = Join-Path $relEvidence 'quarantine'
New-Item -ItemType Directory -Path $relQuarantine -ErrorAction Stop | Out-Null
$relOldMidx = [IO.Path]::GetFullPath((Join-Path $relPackDir 'multi-pack-index'))
if ([IO.Path]::GetDirectoryName($relOldMidx) -ne [IO.Path]::GetFullPath($relPackDir)) { throw 'Unexpected target path' }
Move-Item -LiteralPath $relOldMidx -Destination (Join-Path $relQuarantine 'multi-pack-index') -ErrorAction Stop
```

- [ ] 此时在默认配置下运行 fsck，单独保存退出码。仅 dangling 提示不等于损坏；不得删除 dangling 对象以“清输出”。
- [ ] 有效 pack 校验通过后，按当前 Git 支持运行 `git multi-pack-index write`，再 `git multi-pack-index verify`；逐项退出0后，再跑 `git fsck --full --no-reflogs` 和 `git fsck --full`。若一个 pack 导致 Git 不生成 MIDX，记录其正常行为，以默认 fsck 结果为准，不强行 gc/repack。
- [ ] 最终检查不能携带 `-c core.multiPackIndex=false`，也不能靠持久 config、GIT_CONFIG_COUNT 等环境覆盖关闭索引。确认并记录实际配置；不要删除用户既有非本次配置。
- [ ] 对照 G0：refs/HEAD/四工作区文件和暂存差异未变，count-objects 不再报告已隔离的 orphan idx。若异常，保留现场，不“自动回滚所有 .git”；由唯一执行者按快照判断是否恢复某个文件。

**退出标准：** 正常命令 fsck 成功、有效 pack 完整、可达对象无缺失、旧索引保留、业务文件与暂存内容不变。仅仅 worktree list 四行不是验收。

## G2：验证可恢复性并如实关闭事故

- [ ] 在 G1 正常后生成可达 refs 的 bundle：`git bundle create <relEvidence>/recovered.bundle --all`；`git bundle verify <同路径>`。成功后在新建的独立目录 `git clone --mirror <bundle> <relEvidence>/restore-check.git`，随后 `git --git-dir=<该绝对路径> fsck --full`；核对 refs 的名字/SHA一致。
- [ ] bundle 不包含未提交文件、reflog-only/dangling 对象、工作区暂存信息。继续保留完整元数据和文件副本；独立 clone 通过只说明 bundle 范围可恢复。不能写“全部历史零损失”。
- [ ] 更新事故台账：区分“已确认恢复的可达历史与工作文件”“无法独立证明的旧暂存/reflog”“删除机制尚未定论”。用原日志校准11:23/11:34等时间，不凭报告措辞重建因果。
- [ ] HUSKY=0 暂时保留；核对 .husky/pre-commit 和 package.json 实际执行项，人工跑等价检查。不要在活仓复现疑似删除触发器；如要调查钩子，只能另用可丢弃、无共享 objects/alternates 的复制仓库，并作为另一个明确任务。
- [ ] G0–G2 验收后结束 Git 静默窗口，恢复普通代码工作；仍只由一个执行者接续 wt-reliability。提交之后再次默认 fsck，而非仅数对象。

## S：保存控制器订阅快照与确认时间

**Files:** `src/frontend/state/writingSaveController.ts`、`examSheetSaveController.ts`；`src/frontend/hooks/useWritingDraft.ts`；`src/frontend/components/l3/L3ExamPaper.tsx`；测试 `tests/frontend/writing-save-controller.test.ts`、`exam-sheet-save-controller.test.ts`、`writing-workspace.test.tsx`、`exam-sheet-integration.test.tsx`。

**合同：** 流水线结束后订阅者最后收到的快照与 getSnapshot 一致；clean/error/conflict 的最终快照 inFlight=false；retrying 仍可在管道中。dispose 后不再发通知。已保存时间只来自实际确认事件。

- [ ] 写先红测试，用 deferred promise 让保存成功/失败/409；在 subscribe 中立即复制快照存数组，待 pipeline 结束断言最后一项，不以事后 getSnapshot 替代订阅证据。

```ts
const seen: Array<ReturnType<typeof controller.getSnapshot>> = [];
controller.subscribe(() => seen.push({ ...controller.getSnapshot() }));
// 在调用 setText / setAnswer 前安装订阅；用注入的 save deferred 完成或拒绝请求。
await completion;
expect(seen.at(-1)).toEqual(controller.getSnapshot());
expect(seen.at(-1)).toMatchObject({ state: 'clean', inFlight: false });
```

成功/error/conflict、Task A 恢复A续写B、unsubscribe/dispose 分别验证；成功回调里立即再次 edit/flush 的重入也要完成，不能遗失 waiter。

- [ ] 修正 finally 的结束通知。最小候选如下，但须通过重入/dispose测试，不把“多notify一次”直接等同充分修复：

```ts
finally {
  inFlight = false;
  if (!disposed) notify();
}
```

- [ ] 若 subscriber 可在 clean 通知里再次 setText/setAnswer/flush，要保证登记 waiter 的时序与排空逻辑不会永远等待；必要时先登记 waiter 再启动 pipeline，并在释放 inFlight 后排出新输入。只补现有合同必需内容，不另造调度器。
- [ ] L3ExamPaper 状态显示优先用 state；已保存时间取 controller 快照 `lastSavedAt`，不要在每次 clean 通知中 `new Date()`。重复flush、重复notify、仅订阅或恢复初始态不得刷新“已保存”时间。
- [ ] 控制器与组件各做断言：最后快照一致；干净无写入不生造时间；错误保留上次成功时间但不显示“本次已保存”；已保存后离页不再误拦截，未确认时继续拦截。
- [ ] 执行两份 controller 测试与两份组件测试，使用 Node22：`node node_modules/vitest/vitest.mjs run <四文件> --coverage.enabled=false --maxWorkers=1`。留先红与绿记录。
- [ ] Git健康门通过后按精确文件提交 `fix(save): publish settled snapshots and confirmed timestamps`；已有 Task B 改动若尚不可分离，不勉强部分stage造成坏提交，先完成V/Q再按自包含边界提交。

## V：冻结端到端 expectedVersion 合同

**Files:**
- Domain `src/domain/l3-sheets.ts`；服务输入类型 `src/schemas/service/index.ts:855` 的 PatchL3SheetInput 与相邻 SealL3SheetInput；HTTP schema重导出 `src/schemas/http/index.ts`。
- `src/repositories/interfaces.ts`、`l3-sheets.repository.ts`；`src/services/l3-sheets.service.ts`。
- `src/http/routes/l3/sheets.ts`、`src/http/l3-sheet-response-contract.ts`、`src/http/operations.ts`。
- `src/frontend/api/l3Client.ts`、题纸 controller/组件；生成 `docs/api/openapi.json`、`src/frontend/api/generated/openapi.ts`。
- tests/domain/l3-sheets、repositories/l3-sheets、services/l3-sheets、http/l3-sheet 和前端调用测试。

### V1 合同选择（本轮采用，不留无版本旁路）

```ts
type PatchSheetRequest = {
  expectedVersion: number; // integer >= 0，必填，不默认读服务器最新版
  answers: Record<string, SheetAnswer | null>;
};
type SealSheetRequest = {
  expectedVersion: number; // 来自本客户端flush回执
  mode: 'full' | 'incremental' | 'summary';
  summary?: string;
  acknowledgeUnanswered?: boolean;
};
// 外部写请求采用expectedVersion；既有返回字段draft_version保持不擅自重命名。
```

- [ ] 所有旧请求漏版本返回400，负数/小数也拒绝。当前所有客户端、fixtures、文档及调用点一起升级；这是实际 breaking change，按仓库已有流程留下相对真实base的审查证据，不以optional/default回避。
- [ ] 当前 `src/http/l3-sheet-response-contract.ts` 的 strict `l3SubmissionResponseSchema` 尚无 draft_version。把它作为必填非负整数纳入公开响应及DTO映射，更新开纸/详情/PATCH/seal的真实HTTP合同测试；禁止仅给前端加类型或关闭strict校验。
- [ ] patchAnswers repo 参数含 expectedVersion，事务内条件更新：

```sql
UPDATE l3_submissions
SET answers = answers || $3::jsonb,
    draft_version = draft_version + 1, updated_at = now()
WHERE user_id = $1::uuid AND id = $2::uuid
  AND scope IN ('file', 'paper') AND status = 'draft'
  AND draft_version = $4
RETURNING *
```

返回空行后由service区分404、writing专用面409、非draft409、版本409；不泄露他人版本。保留null清除的既有语义，当前任务不随意改其存储约定。

- [ ] seal 先核对 `sheet.draft_version === input.expectedVersion`，不一致立即409且不物化；最终UPDATE仍以 **input.expectedVersion** 条件抢占。未答软确认保留，不能把版本冲突当“仍要定格”重试。
- [ ] 两个时间窗口都保护：客户端确认后、服务端读取前发生新写；服务端读取后、最终seal UPDATE前发生新写。仅在service读完后做CAS不够。
- [ ] 409错误使用明确 `DRAFT_VERSION_CONFLICT`，前端保留本地输入，停止自动提交/导出；提供复制本地答案/明确载入服务器版本的恢复动作，不GET新版后静默套用旧输入。
- [ ] 初次GET/open建立 controller 初始version，先装配才允许编辑。后续旧GET返回不得重置正在工作的version；换sheet重新建立对应实例与订阅。StrictMode effect清理重建必须在真实组件测试下可用。

### V2 请求重试与不确定网络结果

- [ ] 一个在途请求冻结 `{expectedVersion, answers}`；自动重试沿用同一个版本和载荷，新输入留到下一批，不在重试中改载荷。
- [ ] 本批次采用保守冲突语义：服务器可能已成功、响应却丢失时，同版本重试可得到409；保持本地输入并提示“保存结果未确认/版本已变化”，不可自动升级版本继续覆盖。无需为了消除这个提示新增幂等表或requestId数据库模型。
- [ ] 可恢复错误用有限退避；401/400/422/409不自动重试。用户继续输入可保留本地编辑，但409后不能因setAnswer把冲突状态自动清掉再发送。明确载入服务器版本才重新建立编辑基线。

### V3 定格与导出消费确认回执

- [ ] `flushAnswers()` 返回 `{draftVersion,lastSavedAt}`，不可丢弃回执。定格时先锁定本次编辑窗口，await flush，再 `sealSheet(id,{...input,expectedVersion:receipt.draftVersion})`；无本地改动也必须使用开纸读取的version。
- [ ] 保存/定格进行中所有答案入口（choice/flags/marks）一致受动作锁控制。不能只禁用定格按钮，却允许新输入在屏障后产生。
- [ ] 草稿导出增加 `expectedVersion` 查询校验：修改 `sheets-export.ts`、export query schema、`l3-sheet-export.service.ts`、client与相关tests。draft导出要求版本匹配，缺失版本拒绝；sealed档案不要求此参数并保持旧回看/导出合同。校验和生成answers必须用同一次读取的sheet，不能核对A后再读B做导出。
- [ ] 导出前flush并携带回执version；核对失败不下载/不写剪贴板。版本无变化时仍遵循withAnswers选择及答案隐藏规则。导出期间锁定该次编辑窗口，结束恢复；保留失败时本地输入。

**测试最低集：** 漏版本400、跨owner404、writing守卫409、同版本两写只有一胜、旧版本seal拒绝且attempt为0、未答确认不绕过版本、草稿导出旧版本拒绝、sealed导出无回归。

## Q：逐题脏键与请求序号

**Files:** `src/frontend/state/examSheetSaveController.ts`、`tests/frontend/exam-sheet-save-controller.test.ts`，组件恢复/冲突测试。

**接口：** controller `save({answers,expectedVersion})` 返回 `{draftVersion}`；初始draftVersion来自服务器，不得缺省成0掩盖漏装配。公开flush仍返回确认版本。每题完整SheetAnswer语义不变。

- [ ] 将“所有曾编辑答案”与“仍待确认键”区分。UI持有本地完整答案，controller只维护待发送Map；冻结请求快照时复制值，避免flags/marks数组被后来修改影响已发载荷。

```ts
type DirtyEntry = { seq: number; answer: SheetAnswer | null };
const dirty = new Map<string, DirtyEntry>();
// 每次编辑：inputSeq++；dirty.set(questionId,{seq:inputSeq,answer:structuredClone(answer)})
// 发请求：const sent = new Map([...dirty].map(([id,e]) => [id, structuredClone(e)]));
// 成功确认后，仅清理该题仍是同一发送序号的键：
for (const [id, entry] of sent) {
  if (dirty.get(id)?.seq === entry.seq) dirty.delete(id);
}
// 请求期间再次编辑的同题有新seq，必须留下发下一批。
```

- [ ] 只有成功确认才能清脏键和推进 committedSeq/version；失败保持全部未确认键；409不得仅因编辑新题而恢复自动写。不同问题不能共用同一全局布尔dirty。
- [ ] 单批最多200个题目键。若积累超过上限，按seq排序分批，保证前一批确认后再发下一批；不能确认一个高序号而遗漏更低序号的未发送键，flush等待其目标序号之前全部确认。如果用更细的确认集合，实现必须有相应边界测试。
- [ ] 以下用例先红后绿，deferred而非任意sleep：
  1. Q1=A保存成功，随后只改Q2，第二请求只有Q2。
  2. Q1=A在途，Q1改B；A成功不能清掉B，下一请求Q1=B。
  3. Q1在途，Q2变更，响应后Q2必须补发，flush不能提前返回。
  4. Q1=null的清除请求与在途再改同题同样按序处理。
  5. PATCH失败/429重试保留相同请求载荷和版本，最新编辑不混入重试；409保留本地且停发。
  6. 本端Q1成功，另端改Q1成功，本端只改Q2：本端请求不含旧Q1；旧version得到409，服务器Q1仍为另端值。加载新基线后重新显式编辑Q2才允许成功。
  7. 201个脏键分批且每批<=200，无丢题、提前确认或并发在途。
- [ ] 重跑S的订阅/重入测试、Task A恢复回归，防止抽象修改让已修复问题回归。

## E：验收、提交与下一步边界

- [ ] 真库测试 `tests/l3-sheet-reliability.integration.test.ts` 使用真实受限app连接和两个连接的可控屏障，不用sleep猜SQL执行顺序：
  - 同初始version两端PATCH：一个成功一个409，只有一次version递增。
  - 本端flush确认v1，另端PATCH到v2，本端seal(v1)：409，draft仍在、答案v2、attempt=0。
  - seal已读v1、另一端写v2后释放seal：409；覆盖原报告交错。
  - 服务端先定格时，后续PATCH409且客户端保留本地未确认内容；不是要求任何时间顺序都让PATCH获胜。
  - 无冲突正常seal三档、导出版本校验、跨owner与writing旁路守卫。
- [ ] 真浏览器使用两个page/context完成同题冲突、不同题改动保留、未确认禁止定格/导出、正常保存后离开重开、F-1同sheet零多建；断言UI+真实DB，不只截图。复用已有端口管理方式，避免webServer与手启端口冲突。
- [ ] 目标测试按当前实际文件清单运行，不硬编码“34/131”成功数。记录收集/执行/跳过/失败、命令和SHA；变更中任何缺环境的测试不默默skip算通过。
- [ ] API生成、客户端一致性、breaking审查、路由复杂度使用真实base；检查sheet响应合同显式包含draft_version，不能靠前端临时interface假定服务端输出。迁移原则上无需新增，因为0038已存在该列；如发现真实schema漂移先记录原因。
- [ ] Node22下串行执行 `npm run typecheck`、`npm run arch:check`、`npm run api:governance`、`npm run frontend:build`、仓库要求的全量单测/分层门禁及变更真库/E2E。内存不足保留证据转可用CI，不降低阈值或让base=HEAD。
- [ ] 运行真实隔离库命令：`node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/l3-sheet-reliability.integration.test.ts`，环境缺失需显式失败。全量集成配置可能含其他表TRUNCATE测试，不得指向业务库。
- [ ] 仅stage自己明确负责的文件与任务台账；HUSKY=0前已执行真实等价检查，Git写后默认fsck。提交粒度为“通知合同”与“完整版本+脏键链路”，不要提交只有前端或只有后端且合同不兼容的半成品。
- [ ] 更新 `docs/plan/reliability-batch-execution-2026-09-19.md`：Git默认检查与备份恢复结果、每项红绿、冻结SHA、真库/浏览器、剩余限制。不得把无法证明的事故前历史恢复写成零损失。
- [ ] 有远端能力时按原批次权限创建/更新draft PR并附着任务；本次不合并、不部署。G0协调或备份失败只能阻止依赖阶段，不用绕过审批或静默破坏当前工作树。

## 最终返回格式

1. Git：默认fsck退出码、MIDX/有效pack、四工作区内容/暂存对照、证据目录、独立bundle恢复；事故根因仍未知的部分。
2. S：订阅最终快照与保存时间行为，测试证据。
3. V/Q：API请求/返回合同、冲突路径、脏键与在途续写，真库和浏览器证据。
4. 实际提交/PR、已通过与未执行项分列；明确Task C/D仍待哪些工作，不把本轮四项结束等同整个可靠性批次结束。
