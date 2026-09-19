# 题型学习笔记 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 仅在用户明确选择委派时使用 subagent-driven-development；本计划不默认启动并行 agent。

**Goal:** 在七种题型内部交付独立自由笔记、专题整理与可追溯的题目/原文引用，完成写作、保存、回看、反向引用和导出闭环。

**Architecture:** 独立学习笔记实体，5张owner隔离表；引用现有source/question，保持其真源。沿用HTTP→service→repository→PostgreSQL架构，正文与引用原子保存，基于version防覆盖；独立前端模块接入题型空间与卷面侧栏。

**Tech Stack:** TypeScript ESM、Hono、Zod 4、Drizzle、PostgreSQL 17、React 19、Vite、现有 marked/DOMPurify、Vitest、Playwright。

## Global Constraints

- 唯一N1设计基线：`docs/plan/study-notes-design-2026-09-18.md`；其中§3–§7限额、数据字段、错误码语义与接口是本计划任务的共同契约。
- Node `>=22.22.0 <23`，`.nvmrc=22.22.2`；npm `>=10.9.0 <11`，packageManager `npm@10.9.7`。默认系统Node24/npm11不作为验收基线。
- 单owner、多设备、在线优先；不新增离线写队列、FSRS字段、自动agent权限、编辑器依赖或新调度器。
- 观察HEAD `219be04`；执行前重新定位已合并基线。进行中的F-1、review_sheet_id、作文设计不属于本任务；不覆盖、不混提、不抢0037迁移编号。
- 已有服务、认证、设计token与错误封装复用；现有词汇notes/单题annotations/assessments不迁移为新笔记。
- 新合同camelCase；内部DB snake_case映射显式；服务不直接写SQL，repo写必须requireTx。
- 新端点全部owner-only；新表owner RLS与复合owner FK；无凭据进代码、日志或截图。
- 所有UI任务遵守 `docs/plan/l3-upgrade-task-breakdown-2026-09-11.md` §0 的设计锚点与截图纪律。
- 下文路径均相对 `D:/Temp/Myawesomeapp/vocab-ob'/wt-main/`。若执行在隔离worktree，以其Git根替换，不跨树运行npm。

---

## 1. 交付包与依赖

```mermaid
flowchart LR
  T00[00 基线隔离] --> T01[01 契约与marker]
  T01 --> T02[02 数据库与角色]
  T02 --> T03[03 仓储与并发]
  T03 --> T04[04 引用解析与删除保护]
  T04 --> T05[05 笔记与专题服务]
  T05 --> T06[06 HTTP及治理]
  T06 --> T07[07 编辑保存控制]
  T07 --> T08[08 笔记专题界面]
  T08 --> T09[09 精确引用与原位侧栏]
  T09 --> T10[10 导出与闭环]
  T10 --> T11[11 真实验收与交付]
```

建议三个review包：A=T01–T06后端与真库合同；B=T07–T08可用的自由笔记与专题；C=T09–T11深度引用完整体验。后端基础包可独立验收，但N1完成必须等C；不能把“端点已存在”标成“笔记空间已交付”。提交按任务拆，PR是否分三份由执行时分支状态决定，避免堆叠PR基线混乱。

## 2. 文件边界

| 新文件组 | 职责 |
|---|---|
| `src/domain/l3-study-notes.ts` | 类型、zod、marker解析、集合一致性、锚点纯校验 |
| `src/repositories/l3-study-notes.repository.ts` | note锁/CAS/list/venues |
| `src/repositories/l3-study-topics.repository.ts` | topic锁/CAS/成员及排序 |
| `src/repositories/l3-study-references.repository.ts` | 引用存取、来源解析批量读、backlinks/blockers、source/question共享锁 |
| `src/services/l3-study-notes.service.ts` | note与topic编排、request幂等、原子保存 |
| `src/services/l3-study-reference.service.ts` | 目标验证、快照、变化判定、只读预览 |
| `src/services/l3-study-note-export.service.ts` | 单次一致读、Markdown+JSON导出 |
| `src/schemas/http/l3-study-notes.ts`、`src/http/l3-study-note-response-contract.ts` | 输入/输出合同 |
| `src/http/routes/l3/study-notes.ts`、`study-topics.ts`、`study-references.ts` | 薄路由 |
| `src/frontend/api/studyNotesClient.ts` | 新功能API；不继续扩展大l3Client |
| `src/frontend/state/studyNoteSaveController.ts` | 无React依赖的单写队列与flush |
| `src/frontend/hooks/useStudyNoteEditor.ts` | 编辑状态、IME/防抖、离开保护与controller生命周期 |
| `src/frontend/pages/L3StudyNotesPage.tsx` | 独立笔记空间容器及深链 |
| `src/frontend/components/studyNotes/StudyNoteEditor.tsx`、`StudyNoteList.tsx`、`StudyTopicPanel.tsx` | 编辑/列表/专题 |
| `src/frontend/components/studyNotes/StudyReferenceCard.tsx`、`StudyReferencePicker.tsx`、`StudyReferencePreview.tsx`、`StudyNoteDrawer.tsx`、`StudyNoteBacklinks.tsx` | 引用与卷面连接 |
| `src/frontend/viewModels/studyNoteNavigation.ts`、`studyNoteMarkdown.ts` | 深链与安全分段渲染描述 |
| `src/frontend/utils/selectionTextOffsets.ts` | source/stem/option同契约坐标，局部抽取既有逻辑 |
| `tests/helpers/study-notes.ts` | 纯fixture，固定UUID与输入数据；不启动数据库 |
| `tests/helpers/study-notes-db.ts` | 集成/E2E专用seed/cleanup，限定fixture owner，禁止truncate业务表 |

共享集成：schema、domain/index、repository interfaces/factory、services/index、http server/operations、角色脚本、复杂度白名单、OpenAPI生成物、L3Page/Papers/ExamPaper/ReadingView、source/question删除面。每个任务只提交自己的精确文件清单。

## Task 00：锁定可执行基线与验证环境

**Files:** Read `docs/plan/study-notes-design-2026-09-18.md`、`writing-space-design-2026-09-18.md`、`docs/plan/l3-upgrade-task-breakdown-2026-09-11.md`、`package.json`、`.nvmrc`；Create `docs/plan/study-notes-validation-2026-09-18.md`（执行证据台账，不预填PASS）。

- [ ] 在包根读取当前事实：

```powershell
git status --short
git log -5 --format='%h %s'
git rev-parse HEAD
Get-ChildItem drizzle-release -Filter '*.sql' -Name | Select-Object -Last 5
node --version
npm --version
```

- [ ] 记录当前已集成提交SHA、F-1是否已合并、作文方案接口是否有新变更。共享工作区有其他任务时，按 using-git-worktrees 在已合并基线建立独立checkout；不复制未提交迁移、不清理他人文件。N1不依赖F-1语义，只需要合入时避免导航/注册表冲突。
- [ ] 使用匹配Node22/npm10的已有运行时。设 `COVERAGE_BASE_REF`、`API_CONTRACT_BASE_REF`、`ROUTE_COMPLEXITY_BASE_REF` 为本次实际集成base的完整SHA；不能设为HEAD来绕过差异检查。
- [ ] 串行运行起始typecheck与arch，记录失败根因；内存受限时先低并发目标测试，完整门禁交CI或资源充足环境，不报告未执行项通过。
- [ ] 预留独立acceptance数据库与E2E fixture owner；真实用户dev数据只读观察，不拿来批量seed/cleanup。

**Exit:** 有准确基线、明确共享改动边界和可运行的测试环境；不以等待作文全功能完成为N1开工前提。

末次计划复查观察到F-1未提交实现已使用 `?sheet=` / `?paper=` / `replaySheetId`；仅当其合并且验收后才视为稳定依赖。笔记URL不得与这些参数抢导航。

## Task 01：冻结domain、正文标记与请求契约

**Files:** Create `src/domain/l3-study-notes.ts`、`src/schemas/http/l3-study-notes.ts`、`tests/domain/l3-study-notes.test.ts`、`tests/helpers/study-notes.ts`、`docs/adr/study-notes-workspace.md`；Modify `src/domain/index.ts`（只加导出）。

**Interfaces:** 导出设计§3的 `ReferenceTarget/ReferenceInput/ReferenceWrite`、§6 `SaveNoteInput`，以及 `StudyNoteDto/StudyTopicDto/ReferencePreview/Page<T>`。DTO字段来自设计§5，notes响应隐藏userId/hash/requestId，references输出snapshot/status/target。导出函数：

```ts
export function parseReferenceIds(bodyMd: string): string[];
export function assertReferenceSet(bodyMd: string, references: readonly ReferenceWrite[]): void;
export function validateQuote(text: string, start: number, end: number, quote: string): boolean;
```

zod命名 `referenceTargetSchema`、`saveStudyNoteSchema`、`createStudyNoteSchema`、`studyNoteListSchema`、`createStudyTopicSchema`、`saveStudyTopicSchema`、`moveStudyTopicMemberSchema`、`removeStudyTopicMemberSchema`、`referenceTargetListSchema`、`backlinkQuerySchema`。使用现有 `L3_QUESTION_TYPES`；同名字段不另造第二套枚举。

- [ ] 先写domain行为测试；fixtures导出 `REF='00000000-0000-4000-8000-000000000001'`。

```ts
it('only recognizes standalone top-level reference paragraphs', () => {
  const marker = `[[ref:${REF}]]`;
  expect(parseReferenceIds(`${marker}\n\n\`\`\`text\n${marker}\n\`\`\``)).toEqual([REF]);
  expect(parseReferenceIds(`> ${marker}\n\n\`${marker}\``)).toEqual([]);
});
it('uses UTF-16 offsets without trimming the quote', () => {
  expect(validateQuote('A😀 B', 1, 3, '😀')).toBe(true);
  expect(validateQuote('A😀 B', 1, 2, '😀')).toBe(false);
});
it('rejects a marker without its stored reference', () => {
  expect(() => assertReferenceSet(`[[ref:${REF}]]`, [])).toThrow();
});
```

- [ ] Run `npx --no-install vitest run tests/domain/l3-study-notes.test.ts --coverage.enabled=false --maxWorkers=1`；先见明确缺函数/行为失败。
- [ ] 用 `marked.lexer` 只取顶层paragraph的完整text，识别UUID标记；校验集合相等、重复marker/id、100条限制。完整对象strict zod；普通正文可空，quote不可空；UTF-16断在surrogate pair的锚点拒绝。
- [ ] 增加schema边界表驱动测试：末个venue移除422、7题型去重、未知target拒绝、q长度、topicId/unfiled互斥、body过长、重复id。domain本身零网络/DB/环境变量读取。
- [ ] 重跑目标测试、typecheck、arch；ADR说明owner-only、N1/N2边界、引用保护删除、旧笔记模型不迁移。
- [ ] Commit `feat(notes): define study note and reference contracts`（仅该任务文件）。

## Task 02：schema、迁移与数据库角色

**Files:** Modify `src/db/schema.ts`、`scripts/bootstrap-database-roles.ts`、`scripts/verify-database-roles.ts`、`scripts/verify-schema-drift.ts`、`tests/scripts/verify-existing-volume-role-upgrade.test.ts`；Generate next migration与对应snapshot/journal；Create `tests/scripts/l3-study-notes-migration.test.ts`、`tests/l3-study-notes.integration.test.ts`、`tests/helpers/study-notes-db.ts`。

**Consumes:** Task01 enums/设计§5。**Produces:** 5表+role grants；执行时生成的实际迁移路径记入证据台账，禁止预写0038或修改0037。

- [ ] 先建立真实restricted app连接fixture，要求 `TEST_DATABASE_URL` 与 `TEST_APP_DATABASE_URL`，缺失即失败；A/B owner使用随机UUID。写跨owner reference插入拒绝、note无source可创建、FK阻止源删除测试。
- [ ] 在隔离库跑新文件，确认缺表失败；不要修改测试让它skip。
- [ ] 按设计§5加Drizzle表、复合FK、CHECK、索引和RLS。引用关键约束的SQL语义必须如下：

```sql
CHECK ((source_id IS NOT NULL)::integer + (question_id IS NOT NULL)::integer = 1)
FOREIGN KEY (source_id, user_id) REFERENCES l3_sources(id, user_id) ON DELETE RESTRICT
FOREIGN KEY (question_id, user_id) REFERENCES l3_questions(id, user_id) ON DELETE RESTRICT
```

- [ ] `npm run db:generate`；读生成SQL，确认只创建本feature对象、没有删除并行表、没有覆盖他人迁移；RLS enable与own_all同既有模式。角色converge/verifier加5表vocab_app四权；备份角色仍按既有只读治理，不新增BYPASSRLS主体。
- [ ] 更新迁移计数断言为实际count；schema drift增加新表owner policy关键断言。迁移检查测试断言复合FK/RESTRICT而非只检查表名。
- [ ] 独立库migrate后运行新集成文件；执行角色verifier与schema drift。Expected：A读不到B，跨owner插入被拒，引用source及其question的删除均有约束。
- [ ] Commit `feat(notes): add owner-scoped study note storage`。

## Task 03：repo的CAS、幂等存储、专题成员与分页

**Files:** Create三份仓储（见§2）；Modify `src/repositories/interfaces.ts`、`factory.ts`；Create `tests/repositories/l3-study-notes.test.ts`、`l3-study-topics.test.ts`、`l3-study-references.test.ts`；Extend新integration文件。

**Interfaces:** 在interfaces定义 `IStudyNoteRepository`、`IStudyTopicRepository`、`IStudyReferenceRepository`，factory键分别 `studyNotes/studyTopics/studyReferences`。各方法userId必填：

```text
studyNotes: create; get; lock; updateIfVersion; replaceVenues; list; listTopicBlockers
studyTopics: create; get; lock; updateIfVersion; list; listMembers; replaceMemberPositions
studyReferences: listForNote; replaceForNote; searchTargets; loadTargets; lockTargets;
                 listBacklinks; getSourceDeleteBlockers; getQuestionDeleteBlockers
```

输入/返回类型明确放interfaces：NoteRow/TopicRow映射设计§5、ListNotesInput/ListTargetsInput继承Task01解析类型。`updateIfVersion(userId,id,expectedVersion,patch)` 返回 Row|null；`lock` 用FOR UPDATE；`loadTargets` 返回 Map<kind:id,引用允许的字段>，不暴露标准答案。

- [ ] 写SQL参数测试：userId不可省、版本WHERE参与、limit+1 cursor过滤正确、q的%/_转义、题型filter不能用客户端透传SQL。
- [ ] 验证目标测试先失败，随后实现repo；参考CAS：

```sql
UPDATE l3_study_notes
SET title=$4, body_md=$5, status=$6, pinned=$7,
    version=version+1, last_write_request_id=$8, last_write_hash=$9, updated_at=now()
WHERE user_id=$1::uuid AND id=$2::uuid AND version=$3
RETURNING *
```

- [ ] `lockTargets` 对引用的source/question按类别+UUID稳定顺序 FOR SHARE，保证capture读取期间目标不会被更新或删除；批量加载避免每张卡单独查询。来源删除依赖FK兜底，不靠前端屏蔽。
- [ ] 专题成员重排由service锁topic后传入完整有序id列表，repo重新分配0..n-1；500上限只在member操作执行，不影响列表分页。最后写请求字段在同一事务更新topic。
- [ ] 集成覆盖：同version两连接写仅一胜；target修改在capture持锁期间等待；121条列表跨页无遗漏；专题分页/重排。fixture只删本次owner数据。
- [ ] Commit `feat(notes): implement transactional repositories`。

## Task 04：引用解析、预览与删除保护

**Files:** Create `src/services/l3-study-reference.service.ts`、`tests/services/l3-study-reference.test.ts`；Modify `src/services/l3-context.service.ts`、`l3-paper.service.ts`、必要delete blocker类型/response、`src/frontend/components/l3/L3Bookshelf.tsx`；Extend新integration与既有删除测试。

**Interfaces:** `StudyReferenceService.capture(userId,input,txRepos):Promise<ReferenceRow>`、`resolve(userId,rows,txRepos):Promise<ReferencePreview[]>`、`preview(userId,target):Promise<{preview}>`。capture可嵌入Task05同事务；preview只读独立actor事务。ReferencePreview明确 `id,target,snapshot,status,liveTitle`，whole target预览无标准答案。

- [ ] 先测：“题干引用只接受服务端原文”“他人source404”“选项D不存在422”“源变更标changed且不按旧offset高亮”“keep不改变capturedAt”。
- [ ] 实现目标分发：source/source_quote读content_text；question/stem_quote读stem；option_quote按key精确取text。hash在service用node:crypto，domain只校验slice。capture的displaySnapshot由服务端白名单组装。

```ts
const actual = fieldText.slice(input.start, input.end);
if (!validateQuote(fieldText, input.start, input.end, input.quote)) {
  throw new ValidationError('原文已变化，请重新选择引用', 'quote');
}
const fieldHash = createHash('sha256').update(fieldText, 'utf8').digest('hex');
```

- [ ] source删除blocker加“直接source引用 + 子question引用”的去重note列表；question删除加自身引用blocker。归档note同样计入。可预读blockers但必须保持FK异常409映射，不能返回500。
- [ ] 既有bookshelf删除提示增加学习笔记阻挡信息，旧字段兼容不变；不得由源删除请求自动改笔记。
- [ ] 真实PG测试：一连接保存引用、另一连接删除source，最终不能出现成功删除且有悬空引用；另测question源级联被RESTRICT阻止。改字段后旧quote仍存在，预览标changed。
- [ ] Commit `feat(notes): resolve citations and protect referenced materials`。

## Task 05：笔记与专题service原子编排

**Files:** Create `src/services/l3-study-notes.service.ts`、`tests/services/l3-study-notes.test.ts`；Modify `src/services/index.ts`、`src/errors/codes.ts`（仅确有新稳定code时）；Extend集成测试。

**Interfaces:** `services.studyNotes` 方法 `create/list/get/save/createTopic/listTopics/saveTopic/moveTopicMember/removeTopicMember`；参数为 `{userId,...Task01Input}`，返回设计§7 DTO。`services.studyReferences`提供preview/search/backlinks。

- [ ] 用repo factory注入写服务测试：标题正文和引用一起失败一起回滚；旧version409；新request重用ID不同payload409；相同request重试返回旧成功，不二次增version。
- [ ] 按设计§6锁note再验证幂等/version；无权限404先于版本细节。按字典键序/数组原顺序稳定序列化解析后的请求，作为hash；不可用普通对象不稳定遍历冒充canonical。
- [ ] venues更新检查topic blockers；引用 `keep`只允许本note已有id，`capture`读目标并校验；body marker集合相等后整体替换；snapshot总量使用UTF8字节数≤2MiB。
- [ ] 专题操作锁topic，再锁相关note（所有代码维持topic→note锁顺序；note保存只普通读topic成员，不反向取topic锁）。加入/重排验证venue归属、before成员合法、≤500。移除不存在成员在相同request重试返回当前topic，否则新请求按空操作成功且version递增，固定语义。
- [ ] 新建note/topic按create_request_id去重；同输入重放返回当前对象，不重置编辑内容。归档/恢复/置顶通过完整save版本请求，前端所有调用共享同一保存器。
- [ ] 集成补“加入专题与移除venue并发”：成员加入先锁topic→note再查venues；note保存锁note后读成员，避免两边均成功破坏不变量。
- [ ] Commit `feat(notes): add atomic note and topic workflows`。

## Task 06：HTTP、授权、OpenAPI与客户端

**Files:** 新增§2三个薄路由与响应合同、`src/frontend/api/studyNotesClient.ts`；Modify `src/http/server.ts`、`operations.ts`、`scripts/verify-route-complexity.ts`、授权注册表tests；Generate `docs/api/openapi.json`、`src/frontend/api/generated/openapi.ts`；Create `tests/http/l3-study-notes.test.ts`、`l3-study-notes-response-contract.test.ts`、`tests/frontend/study-notes-client.test.ts`。

- [ ] 按设计§7全部路由表写注册条目与失败合同测试；先跑看未注册404/无schema失败。新路由放独立文件而非继续扩展sheets.ts。
- [ ] 实现参数解析/服务调用/响应校验，固定路径优先；端点操作ID `l3StudyNotes*`/`l3StudyTopics*`，minRole=owner。给reference-preview注释标只读但POST，沿用session CSRF保护。
- [ ] client返回严格DTO；非法200响应抛错，不归一成“空笔记/无引用”。分页函数保留nextCursor，不截前100。
- [ ] 覆盖身份矩阵：anonymous401、agent403、owner成功、foreign ID404、坏UUID400、语义不匹配422、并发409。输入不得接受userId/snapshot/fieldHash由客户端伪造。
- [ ] `npm run api:openapi`、`npm run api:client:generate`、`npm run api:client:check`；新增端点不自动修改breaking approval。若删除blocker返回合同产生实际breaking，先生成相对实际base的diff证据，按现行机制处理。
- [ ] 对所有新route方法确认operations/authorization唯一映射；运行http目标测试、`npm run api:governance`。
- [ ] Commit `feat(api): expose owner-only study note contracts`。

## Task 07：可靠编辑与保存控制器

**Files:** Create `src/frontend/state/studyNoteSaveController.ts`、`src/frontend/hooks/useStudyNoteEditor.ts`、`src/frontend/components/studyNotes/StudyNoteEditor.tsx`、`tests/frontend/study-note-save.test.ts`、`study-note-editor.test.tsx`。

**Interfaces:**

```ts
type SaveState = 'idle'|'dirty'|'saving'|'error'|'conflict';
// T = 完整编辑载荷（title/bodyMd/venues/pinned/status/references），不含版本和requestId。
function createStudyNoteSaveController<T>(options: {
  version: number;
  persist: (value: T, expectedVersion: number, requestId: string) => Promise<{version:number}>;
  onState: (state: SaveState) => void;
}): { edit(value:T):void; flush():Promise<void>; retry():Promise<void>; dispose():void };
```

- [ ] 写deferred Promise测试，锁定真实竞态而非只断言调用次数：

```ts
it('does not finish flush while the current save is in flight', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const persist = vi.fn(async () => { await barrier; return { version: 2 }; });
  const controller = createStudyNoteSaveController({version:1,persist,onState:()=>{}});
  controller.edit('A');
  const first = controller.flush();
  let done = false;
  const second = controller.flush().then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await Promise.all([first,second]);
});
```

- [ ] 实现single-flight+latest queued value；同失败请求retry沿用requestId/version/payload，新编辑等待重试成功再送。409中止自动发送；flush失败必须reject，dispose不偷偷把未存内容算已保存。
- [ ] 测保存A时编辑B，A回包不能覆盖B输入；B以新version顺序发送。网络失败/重试、未知200、取消离开、IME composition、双编辑器版本冲突、archive与正文并发均覆盖。
- [ ] hook负责800ms与IME；controller不直接读React/DOM/localStorage。编辑器状态条、复制本地正文、显式重试、加载服务器版本清晰；载入冲突版本前保留复制机会。
- [ ] 复用普通Markdown的净化渲染；引用渲染在Task09接入。加入界面基线N4保存诚实，先截图失败态与移动编辑态。
- [ ] Commit `feat(notes): implement reliable single-writer editing`。

## Task 08：笔记空间、专题、分页与导航

**Files:** Create `L3StudyNotesPage.tsx`、`StudyNoteList.tsx`、`StudyTopicPanel.tsx`、`src/frontend/viewModels/studyNoteNavigation.ts`、`tests/frontend/study-notes-page.test.tsx`、`study-note-navigation.test.ts`；Modify `L3Page.tsx`、`L3PapersPage.tsx`、`l3ShellViewModel.ts`、`docs/design/l3-space/baseline.md`。

**Interfaces:** `StudyNoteNavigation={venue,noteId?,topicId?,refId?}`；`parseStudyNoteNavigation(URLSearchParams)` returns validated object/error，`buildStudyNoteUrl(input)` returns本设计URL。与写作section=writing、旧venue/file深链互斥处理。

- [ ] 测无素材仍显示七题型的笔记入口；空白创建；同note跨venue修改一致；两个专题成员关系独立；移出专题不删note。
- [ ] 实现列表20条分页、搜索防抖+取消/请求序号避免旧结果覆盖；q/venue/topic变化重置cursor；unfiled只计算当前venue未加入active topic的笔记，归档topic不让笔记永久消失于未整理视图。
- [ ] topic移动提供上移/下移及键盘操作，调用beforeNoteId合同；从其他分页选位置需明确加载目标，不能按当前页局部排序覆盖整个专题。
- [ ] 深链恢复与浏览器back：note编辑器key=noteId，切topic不丢未保存note；不合法参数不触发create。单一导航分发处理study-notes优先级，兼容现有写作/F-1变更。
- [ ] UI锚点N1自由创建/N3可追溯；中文空态、失败重试、归档恢复；桌面/手机与明暗主题截图。不给用户暴露UUID/targetType术语。
- [ ] Commit `feat(notes): add venue notebooks and topic organization`。

## Task 09：深度引用、双向查找与原位侧栏

**Files:** Create引用组件组、`studyNoteMarkdown.ts`、`selectionTextOffsets.ts`、`tests/frontend/study-note-references.test.tsx`、`study-note-drawer.test.tsx`、`study-note-selection.test.ts`；Modify `L3ExamPaper.tsx`、`L3ReadingView.tsx`（局部回调接入）、必要source删除blocker展示。

**Interfaces:** `StudyNoteDrawer({venue,selection:ReferenceTarget|null,onClose})`；`StudyReferencePreview({target,onClose})`；`StudyNoteBacklinks({targetKind,targetId,onOpenNote})`；`selectionTextOffsets(container,selection)` returns `{start,end,quote}|null`，统一UTF16。

- [ ] 先测选区跨标签但同字段能准确还原；emoji/重复句/空白；跨两个字段拒绝；选中文本不触发选项作答。测试引用marker在代码块中不渲染卡片。
- [ ] 卡片从React渲染快照，正文用lexer分段的Markdown；引用原处用独立只读预览，current才按锚点高亮，changed显示旧摘录+新内容但不猜位置。
- [ ] picker分页搜索source/question，支持无source题；先预览再插入新UUID marker与capture载荷。keep引用保持历史时间；“更新引用”重新选择capture；“转普通摘录”明确保存普通正文并删ref。
- [ ] 卷面/阅读侧栏通过小回调或局部context接入，不重构全部题纸状态；打开note前捕获selection，聚焦编辑器后原文仍可定位。侧栏保存不触发题纸flush/seal/openSheet。
- [ ] backlinks按note去重、显示引用处数，定位refId；保存移除后刷新相关计数。卷面只显示标题入口，不自动透出笔记正文。返回note/卷面保持滚动及未保存状态。
- [ ] 组件测试断言打开预览/笔记不会POST sheets；做题选项原交互回归；截图覆盖原位引用、changed状态、双题对照与手机返回。
- [ ] Commit `feat(notes): add contextual citations and backlinks`。

## Task 10：导出与生命周期闭环

**Files:** Create `src/services/l3-study-note-export.service.ts`、`tests/services/l3-study-note-export.test.ts`；Modify notes路由/operations/client与编辑器导出按钮；Extend HTTP合同/前端测试。

**Interfaces:** `services.studyNoteExport.export(userId,noteId):Promise<{markdown:string,sha256:string,version:number}>`。导出schemaVersion=1，distinct于题纸v2/作文v1，artifactType=`study-note`。

- [ ] 测含反引号、恶意HTML、中文引用、归档note、changed引用的导出；JSON结构可解析，referenceId与正文一致；无标准答案字段混入。
- [ ] service在同一actor事务锁note FOR SHARE，读取notes/venues/refs，保证正文与引用版本一致；使用已存snapshot输出出处，标引用时间，不把当前改判/新正文替换历史摘录。
- [ ] 输出Markdown正文（marker替换为可读引用块与来源）+末尾JSON块；fence长度大于内容中最长反引号串。固定安全文件名 `study-note-<uuid>.md`。hash基于不含“内容校验”行的全文UTF8，response header同值。
- [ ] UI导出先await controller.flush，再GET；失败不能下载旧文。测试persist reject时export未调用；保存成功才取正确version。
- [ ] 更新OpenAPI并跑client check及导出目标测试；Commit `feat(notes): export portable notes with citation evidence`。

## Task 11：真实数据库、浏览器、资源规模与最终收口

**Files:** Create `e2e/study-notes.spec.ts`、`scripts/seed-study-notes-e2e.ts`；Modify `.github/workflows/ci.yml`（若当前E2E流程未自动执行新文件，明确接入）、验证台账与 `docs/plan/README.md` 新计划索引；截图仓外 `../deliverables/software-company/study-notes-2026-09-18/screenshots/`。

- [ ] seed脚本只允许指定独立测试库和fixture owner，显式检查目标数据库名；创建121笔记、121目标、55专题。脚本不读写真实用户内容；清理只按fixture id集合/owner执行。
- [ ] 浏览器路径：从空题型笔记入口创建 → 写内容 → 引用题A原文与题B选项 → 跨题型专题 → 刷新重开 → 点击引用精确定位 → 从题目反向返回 → 移除引用 → 导出并核对JSON。
- [ ] 故障路径：拦截一次保存返回503 → 本地输入保留 → 重试 → 双tab旧version409 → 保存中导出 → 离开确认；断网不是引入离线队列的理由。
- [ ] 真库双证：GET/preview未增加submissions；保存前后note版本、refs数、topic成员；源码变化后旧snapshot仍在；source删除因子question引用409；跨owner无读写。
- [ ] 全量工程门禁按项目要求执行，目标测试通过不能替代：

```powershell
npm run typecheck
npm run arch:check
npx --no-install vitest run --coverage --maxWorkers=1
npm run coverage:layered
npm run test:collection
npm run db:schema:drift
npm run api:governance
npm run frontend:build
npm run runtime:verify
npm run alerting:verify
npm run release:acceptance:contract
npm run secret-rotation:evidence:contract
npm run release:workflow:verify
```

- [ ] 在配置好的隔离库串行执行新集成文件及既有L3 RLS回归；使用 `npx --no-install vitest run --config vitest.integration.config.ts tests/l3-study-notes.integration.test.ts --maxWorkers=1`。本文件缺DB配置应失败，不skip。现有 `rls:acceptance:test:l3` 只列旧文件，不能据其通过声称新表已测。
- [ ] `npx --no-install playwright test e2e/study-notes.spec.ts`，使用既有authed fixture与隔离API。视觉桌面1440×900、手机390×844、明暗/四态截图；逐步日志记录版本/SHA/fixture，遮凭据。
- [ ] 覆盖率遵守已配置各层与diff ratchet，新增受治理文件lines≥85%、branches≥75%；记录真实base及commit。内存不足须将未执行门禁列为blocked并改到资源足够环境完成，不降阈值。
- [ ] 自审检查没有新增空壳入口、未知200归一为空、截断分页、只在当前页面可看的引用；文档标注N1完成与N2未开始。Commit `test(notes): verify end-to-end study note workflows`。

## 3. 交付检查清单与需求追踪

| 需求 | 主任务 | 必须出现的证据 |
|---|---|---|
| 自由笔记可独立存在 | 01/02/05/08 | 无word/source/question也可保存并重开 |
| 跨题型、专题有序整理 | 03/05/08 | 同note两题型一致，移出不删，分页重排 |
| 深度引用和出处 | 01/04/09 | source/stem/option精确摘录与双向定位 |
| 原文变化/删除 | 02/04/09 | changed不误高亮、级联删除blocker |
| 保存不丢/不串 | 03/05/07/10 | 真库CAS、重试幂等、在途flush等待 |
| 做题无摩擦 | 08/09/11 | 选区/滚动/作答保留；无openSheet副作用 |
| 权限与规模 | 02/06/11 | 两owner真实RLS、agent403、121条翻页 |
| 可携带导出 | 10/11 | 离线可读MD、可解析JSON、hash可复算 |
| 历史学习引用 | N2 | 不用N1的source/question快照冒充历史attempt支持 |

## 4. N2启动交接（单独立项）

N1结束后先核对已落地F-1与作文合同，再形成N2补充设计与任务表。接入顺序：注记/评析 → 笔记链接 → 精确sheet+attempt → 对应grading → writingTask+writingSheet+feedback。每种目标都需要归属、内容清理、引用时快照、变更提示和只读导航测试。

不在N1仓储提前存unknown target_ref兜底；不把作文feedback强行转为generic verdict；不复制attempt正文为第二份稿件真源。已提交稿与动态评析的引用采用当时摘录，并显示最新状态区别。

## 5. 本计划自审与执行事实

本文件是任务计划；测试代码块是待落地的行为规格，不代表已执行。计划编写阶段仅核对文件/调用/迁移现状，未修改业务代码、未创建迁移、未运行全量门禁、未提交或部署。

计划完成检查：Task00–11共12项；需求映射覆盖自由笔记、专题、引用、保存、权限、分页、导出与UI；三份交付文档已进入docs/plan索引。自审补充了F-1当前参数名与whole-target hash定义，避免执行时把旧讨论稿中的概念字段当作当前URL或漏判引用变化。

自审应检查：接口名称在设计/任务一致；每种引用有生命周期与权限；所有分页可达；N1不依赖未合并作文scope；shared文件集成顺序明确；没有预占迁移编号；归档与删除、引用与复制的语义明确。
