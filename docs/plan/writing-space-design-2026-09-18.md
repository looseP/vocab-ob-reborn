# 作文子空间特化设计 v1

日期：2026-09-18。性质：外派实施的设计基线；本次仅交付设计与计划，不代表代码已经实现或验收。用户已要求深入设计并给出可执行外派材料。执行计划见 `writing-space-execution-plan-2026-09-18.md`，启动指令见 `writing-space-start-prompt-2026-09-18.md`。

## 0. 目标、依据与范围

**目标**：用户不需要理解来源、题目、试卷、题纸，就能完成“开始写作 → 自动保存 → 离开后继续 → 提交本稿 → 获取反馈 → 修改第二稿 → 历史回看”。

接入基线（2026-09-18复核）：`main@f03ffe3`（PR #121，包含PR #120）。F-1档案、刷新、`?sheet=`回看与0037 `review_sheet_id`已合入；无需重做。0037不可改写，后续迁移按执行时最新journal分配。另有study-notes计划及临时脚本，不属于作文任务。三份作文计划当前未提交，执行前须点名提交或显式复制到隔离worktree并核对hash，不得假设新worktree会继承它们。

已经核实的实现约束：

- 题型已有 `short_essay / long_essay`，都映射到“作文”；source-less 题可以用 file_key。
- `src/domain/l3-sheets.ts` 的 strict `sheetAnswerSchema` 只有 choice/flags/optionFlags/marks，**没有 text 字段**。`hasAnswerContent` 能识别 text 不意味着 HTTP 写面支持 text。
- submissions scope 和 attempts venue 目前为 file/paper。定格后 answers 清空，正文事实应只在 attempts，不能另建一套稿件正文历史。
- `openSheet` 创建/复用 draft，不是历史读取接口；GET 不应调用 openSheet。
- 旧评卷以 correct/partial/wrong 为中心；作文质量反馈不应强制转译为这些值。
- L3 不写 FSRS；单 owner、多设备、在线优先；无离线写队列。

### v1 包含

整篇/段落/自由写作三种任务形式；题库入口和直接开始；草稿恢复、可靠保存与冲突处理；提交后只读；本地 HTTP agent 反馈；手动刷新；第二稿；任意两稿只读对照；任务列表与稿次深链；单稿 Markdown+JSON 导出；归档/恢复任务。

### 明确后置

计时模拟、考研/雅思数字评分、自动 agent 守护进程、自动全文代写、音视频、素材推荐/收藏写入、全站搜索、学习能力总分。素材积累仍可经现有工具手动进行。本版不实现翻译子空间，不把一般题纸 F-1 扩大为全站重构。

## 1. 架构选择

| 备选 | 代价 | 决定 |
|---|---|---|
| 在现有 L3ExamPaper 直接塞 textarea 与改稿 UI | 保留 source-less/版本语义问题，大组件继续膨胀 | 不采用 |
| 新建 writing drafts/revisions 两套全文表 | 开发局部简单，但与 attempts 重复持久化答案、导出和删除分叉 | 不采用 |
| **新增写作任务，扩展题纸 writing scope，复用 attempts，新增作文反馈** | 要修改作用域契约与共享 SQL，但真源清楚 | **采用** |

新增两张业务表：`l3_writing_tasks`、`l3_writing_feedback`。扩展 `l3_submissions` 少量写作元数据，复用 `l3_question_attempts.answer = {text}`。写作前端独立组件，复用认证、API client、设计 token 和数据库事务，不复制大型试卷组件。

**架构修订**：新增 ADR（文件名 `docs/adr/writing-workspace.md`，避免与并行编号争用），明确 Amends ADR-0030/0034 的 scope/venue、ADR-0029 的精确 agent 读写面。作文 feedback 成为作文任务的唯一质量反馈源；不同时写 generic grading verdict。旧 essay 在普通试卷中的现有行为不变，进入专用写作任务后才采用新反馈流程。

**引用式架构的取舍**：任务题面使用question作为唯一真源，并对关联写作任务的题面冻结编辑/硬删。这避免复制题面快照，但意味着改题意要新建题/任务。任务标题与正文草稿可正常修改。此约束须在删除blocker和未来question编辑契约中明确，不允许仅写注释。

## 2. 产品路径与信息架构

### 入口和 URL

- L3 一级入口“作文”；深链 `/l3?section=writing`，与现有 source/venue 深链共存。
- 任务页 `/l3?section=writing&writingTaskId=<uuid>`：读取任务，显示现存草稿；没有草稿时显示最近提交稿及“开始修改”。GET 不建纸。
- 指定稿统一为 `/l3?section=writing&writingTaskId=<uuid>&sheet=<uuid>`：读取确切稿次；sheet必须归属该task。不再引入writingSheetId查询参数。`section=writing`优先选择作文宿主，不能被旧sheet导航effect抢回试卷台。旧的纯`?sheet=<uuid>`先GET判scope：file/paper沿用F-1；writing只读解析taskId并replace为作文规范URL，禁止调用openSheet。
- 对照页再加 `compareTo=<sealedSheetId>`；两个 sheet 都必须 sealed、同一 task、owner 可读。
- 无效组合、无权访问、已清理内容分别展示对应空态；不悄悄回退为创建草稿。

### 首屏

上方“继续写作”（最近一个未归档任务的已有 draft）与“开始写作”；下方“我的写作”分页列表。每行只显示标题、形式、方向、草稿/稿次状态、最后修改时间。搜索标题/题面，按最近更新排序，20 条一页，支持加载更多。反馈状态按当前所选稿派生，不做跨稿混合总徽标。

直接开始弹层：形式默认自由写作；题目说明可空，空时服务端生成“自由写作”；标题可空，自动取题面首 24 个 Unicode code point；方向默认通用，可改考研/雅思。无来源/卷面/题型必填。点击开始后光标进入正文。

从既有题进入：仅 short_essay/long_essay 显示“在作文空间练习”；带 questionId 创建任务。题型及题面继承，方向从已有上下文预填。已有同一题的活跃任务时返回该任务，不重复创建；段落专项或新目标需要用户“新建独立任务”。

### 编辑与反馈

桌面宽屏正文与题目/反馈双栏；小屏单栏用“题目 / 写作 / 反馈”页签，切页签不卸载编辑状态。正文为普通 textarea，支持 IME；无富文本依赖。全程显示“未保存 / 保存中 / 已保存 / 保存失败 / 版本冲突”。

只提供“提交本稿”，不向作文用户展示 incremental/summary 三档。提交后本稿只读；正文非空才可提交。暂时空白可保存，超字数建议不阻止保存或提交；只有 20,000 UTF-16 code units 硬上限阻止写入。

反馈首屏：总体反馈、值得保留的表达、最多三项重点修改；分维度内容折叠。每个有定位的建议可跳到本稿对应原句。没有定位则显示“全文建议”，不伪造高亮。

“开始第二稿”默认复制所选 sealed 稿正文；展示“基于第 n 稿”，绝不覆盖原稿。已有草稿时默认“继续现有草稿”；若指定不同父稿，明确冲突，不自动替换。可选择“从空白开始”。

对照仅以左右/上下原文为基础，强调段落变化与反馈；v1 不引入复杂字符 diff，也不宣称分数提升。两稿反馈分别读取，旧反馈不叠加到新稿。

### 空态与异常文案

| 状态 | 主文案 | 可执行动作 |
|---|---|---|
| 无任务 | 从一段你想表达的话开始 | 开始写作 |
| 新草稿 | 正文尚未保存 | 输入后自动保存 |
| 写入失败 | 尚未保存，请保持页面打开 | 重试保存 / 复制当前正文 |
| 冲突 | 另一处更新了这份草稿 | 查看服务器稿；先复制本地正文，再确认载入服务器稿 |
| 已提交无反馈 | 本稿已保存，尚无反馈 | 复制本地评阅指令 / 刷新反馈 |
| 反馈读取失败 | 暂时无法读取反馈 | 重试；不伪装“尚无反馈” |
| 内容被清理 | 本稿正文已清理 | 返回历史；不展示残留评语 |
| 没有第二稿 | 修改会保留原稿 | 开始修改 |

复制正文为显式用户操作；页面不自动把草稿写入 localStorage/IndexedDB。离开时若有未保存内容或在途请求，阻止站内离开并给确认；刷新/关闭通过 beforeunload 提示，不能承诺浏览器一定保留未保存数据。

## 3. 数据真源与约束

### D1 · 写作任务 `l3_writing_tasks`

字段：`id uuid PK`、`user_id uuid`、`question_id uuid NOT NULL`、`title text`、`kind text(whole|paragraph|free)`、`direction text(通用|考研|雅思)`、`status text(active|archived)`、`created_at/updated_at timestamptz`、`create_request_id uuid`、`create_input_hash text NOT NULL`。

- UNIQUE(id,user_id)；UNIQUE(user_id,create_request_id)。create_request_id 为客户端一次创建意图的 UUID，失败重试沿用，成功后才换。create_input_hash 保存规范化创建输入的hash，不随改标题变化；相同requestId不同输入返回409。规范化输入按固定字段序列编码：kind,direction,questionId或normalizeLF后的prompt,初始title,forceNew，缺省值先按产品默认填充，再JSON编码并SHA256。
- 复合 FK(question_id,user_id)→questions(id,user_id)，删除 RESTRICT；task 只允许归档，无硬删入口。
- 直接新建任务：同事务创建一行合法 long_essay，`space=作文`、`file_key='writing:'+taskId`、`options=[]`、`answer={}`，题面存 question.stem，任务不复制题面。whole/paragraph/free 是任务形式，不新增题型enum，也不代表评分体系；从现有short_essay进入时保留其题型。用户不必手动选择底层题型。
- 选择现有题：复用 question；同 owner；题型是 short_essay/long_essay；status=active。创建任务时加 owner+question 事务锁，复用已有 active 且 kind/direction 相同任务。独立任务用明确 `forceNew=true`，仍受 create_request_id 幂等保护。
- 题面在任务创建后不可经普通接口原地修改/删除；现无题面 PATCH，未来新增也必须守此约束。改变写作题意须新建任务。标题允许编辑，题面不开放编辑。本版不做题面版本历史。
- 新造的内部题通过 task 引用 + file_key 前缀识别，在普通 practice-files 聚合中排除；既有导入题仍保留原列表。该过滤条件必须同时满足关联任务与 writing 前缀，不能单看用户可输入的字符串。

### D2 · 扩展 submissions

新增 `writing_task_id uuid NULL`、`parent_sheet_id uuid NULL`、`revision_no integer NULL`、`draft_version integer NOT NULL DEFAULT 0`。scope 新增 writing；scope_key=`writing:<taskId>`。writing 行要求 task 非空、source/question_type/paper 全空；非 writing 行这三个写作元数据为 NULL。

- task/user、parent sheet/user 用复合 FK；task/user FK RESTRICT；parent FK RESTRICT。父稿同 task 且 sealed 由事务内检查。
- 原有 draft 唯一索引(user_id,scope_key) WHERE status=draft 继续承担单任务一草稿。
- UNIQUE(user_id,writing_task_id,revision_no)；draft/discarded revision_no=NULL，sealed writing 必须 >0。首次提交在 task 行锁下分配 max+1，故仅成功提交编号，discard 不占号。
- task 归档前若有 draft 返回409；用户可先继续、或明确丢弃草稿。discard 仅针对 draft，清空 answers，无 attempt，不复用提交稿。
- 草稿正文唯一真源为 answers[questionId]={text:string}；sealed 正文唯一真源为该 sheet 的 active attempt.answer.text。不额外建全文版本表。
- attempts venue 新增 writing。一个 writing sheet 只物化一个 attempt。迁移新增 writing 专用部分唯一索引(sheet_id) WHERE venue='writing'，并加同 owner sheet/question 复合 FK 所需约束；保留已有普通题纸数据。
- 现有 soft-delete attempt 仍有效：删除 writing attempt 时同事务清理对应 feedback；读取、评阅、导出一律不返回已删除正文或包含其摘录的反馈。历史留下“正文已清理”占位。不偷偷从备份或其他列复活正文。

### D3 · 作文反馈 `l3_writing_feedback`

`id uuid PK`、`user_id uuid`、`sheet_id uuid`、`text_sha256 text`、`schema_version integer=1`、`feedback jsonb`、`version integer>0`、`request_id uuid`、`last_editor text`、`created_at/updated_at`。

UNIQUE(user_id,sheet_id)；复合 FK(sheet_id,user_id)→submissions(id,user_id)。无正文副本，feedback 可有局部 quote。数据库列长和 JSON 总体积受校验；一稿一条当前反馈，更新要求 expectedVersion，**不做反馈历史**。正文稿次不可变与反馈 latest-wins 是两件事。

text_sha256 = SHA256(UTF-8(NORMALIZE_LF(原样正文)))。创建和保存统一把 CRLF/CR 转 LF，**不 trim、不 Unicode normalize**；返回的正文和偏移必须基于相同字符串。offset 是 JS UTF-16 code unit，quote 必须严格等于 text.slice(start,end)。emoji、中文、换行均有测试。

两个新表都启用 RLS，按 user_id/auth.uid() 的项目惯例收口；角色清单、converge、verifier 同步。不能仅靠外键判断 owner。

## 4. 保存、提交和并发契约

写作所有写操作统一锁 task，再锁 sheet；现有通用 PATCH/seal/discard 入口遇 writing sheet 返回409 `WRITING_ENDPOINT_REQUIRED`，不允许绕过专用校验。通用 GET sheet owner 可读；作用域解析器需支持 writing，但不得触发创建。

`PATCH draft {expectedVersion,text}`：归属/active task/draft 状态/长度检查，锁后比较 version；不一致返回409 `DRAFT_VERSION_CONFLICT`，不覆盖。成功写全量 text、version+1，返回已确认版本和正文 hash。网络超时后 GET 当前草稿：若服务端内容等于刚发送内容且 version=旧+1，可确认成功；否则保留本地并显示冲突，不自动 last-wins。

客户端只允许一个 PATCH 在途；输入继续更新本地序号。响应只确认其发送序号，不能把旧响应正文覆盖用户后续输入。800ms 防抖，composition 中不发；compositionend 后排队。自动重试只适用于网络、429、5xx，退避1/2/4秒共3次；401要求重新登录、409冲突、400/422校验错误均不自动重试。失败后手动重试始终可用。

`flush()` 返回 Promise，直到当时输入序号被服务端确认才 resolve；失败 reject。提交期间编辑器只读，避免 flush 后又输入；导出草稿也先 flush，失败禁止导出伪“最新稿”。导航保护以 dirty/inFlight 为准，不能只看 timer 是否为空。

`POST submit {expectedVersion}`：task锁→sheet锁→比较版本和非空正文→解析唯一 question→创建 attempt→清空 answers→sealed/revision_no/version+1，**同一事务**。不调用会另开事务的 public service。相同 sheet 已 sealed 的重复 submit 返回同一稿（200）；没有新的 attempt 或稿号。非 sealed 且版本不符409，discarded409。

`POST drafts {parentSheetId,seed}`：parent=null 时 seed=blank；parent有值必须 sealed、同 task、active attempt，seed=copy|blank。task锁下已有相同 parent 的 draft 返回原 draft，不覆盖其正文；已有不同 parent 的 draft409 `ACTIVE_DRAFT_EXISTS`；无 draft 则新建，copy 时从 parent attempt 复制到新 draft.answers，这是新稿初始内容，不是旧稿的第二份真源。

任务创建同时创建首个空 draft，并返回稳定 ID；之后所有 GET 严格只读。“打开已提交稿”与“创建修改稿”是两个不同动作。

## 5. 反馈结构、权限和呈现

```ts
type Dimension = 'task_response' | 'organization' | 'language' | 'expression';
type Anchor = { start: number; end: number; quote: string };
type WritingFeedback = {
  schemaVersion: 1;
  summary: string; // 1..1000 UTF-16 units
  strengths: string[]; // 0..3，每条1..500
  dimensions: Record<Dimension, {
    applicable: boolean;
    comment: string; // 1..1000；不适用也解释原因
  }>;
  priorities: Array<{ // 0..3，没有问题允许0项
    id: string; // 1..40，稿内唯一
    dimension: Dimension;
    observation: string; // 1..1000
    action: string; // 1..1000，可执行修改建议
    anchor: Anchor | null;
  }>;
};
```

无 numeric score、无 correct/partial/wrong、无自动替换正文。v1 不用 markdown 渲染 agent 文本，普通文本显示，防 HTML 注入。反馈请求体上限64KiB；正文上限20,000、题面上限5,000、标题上限120，API 和前端一致。

**权限**：owner 创建任务、保存、提交、改稿、归档、导出。agent 仅通过专用 context 读取已提交且正文未清理的指定稿，以及 PUT 写该稿反馈。draft、task列表、其他稿、正文写入、归档、通用写作管理全部禁止。owner 可以读取 context；反馈 PUT 允许 owner 或 agent，last_editor 从 Principal 决定，不相信请求体。

提交按钮说明“提交后本地评阅助手可读取本稿”；不自动派发网络任务。复制指令只含 taskId、sheetId、相对 API、题目要求与评阅范围，不含 Bearer、owner token 或其他稿全文。

context 返回准确题面、direction/kind、sheetId/revisionNo、正文/hash、当前 feedback version 和 schema。不包含全库、其他稿、历史笔记；草稿409，非本人404。

PUT feedback `{expectedVersion,textSha256,requestId,feedback}`：版本0表示首次；锁sheet并确认sealed及active attempt，再校验hash/anchor与版本。相同 requestId、相同完整内容重传当前记录返回200不升version；同 requestId 不同内容409；旧 requestId 已被新反馈替换则按 expectedVersion 冲突409，不宣称全历史幂等。新反馈version+1。正文/hash不匹配422；他人稿404；draft409。

generic grading-context/submit/result 入口对 writing sheet 返回409，提示使用 writing feedback，防两套反馈真源。旧试卷的 essay 仍走旧行为，专用写作任务采用 writing scope。

## 6. HTTP 合同（基路径 /api/l3/writing）

请求/响应统一 camelCase，domain DTO 显式映射数据库 snake_case；不把 DB row 直接暴露。错误沿用项目 error envelope；新错误码登记集中常量。分页 `{items,total,nextCursor}`，limit默认20最大50，created/updated时间+id keyset；任务分页使用 updatedAt DESC,id DESC，修改并发时客户端按id去重。

| 方法/路径 | 输入要点 | 输出要点 | 身份 |
|---|---|---|---|
| POST /tasks | requestId,title?,kind,direction,prompt? 或 questionId，forceNew? | `{task,draft,created}`；201新建/200复用；复用无草稿时draft=null | owner |
| GET /tasks | q?,status=active/archived,limit,cursor | task summaries + lastSheetId/draftSheetId | owner |
| GET /tasks/:taskId | 无写入 | `{task,draftSummary,revisionCount,latestSubmittedSheetId}` | owner |
| PATCH /tasks/:taskId | `{title?}` 非空patch | task | owner |
| POST /tasks/:taskId/archive | 空 | archived task，有draft409 | owner |
| POST /tasks/:taskId/restore | 空 | active task | owner |
| GET /tasks/:taskId/revisions | limit,cursor | sealed/discarded历史，含revisionNo/parentSheetId/contentStatus | owner |
| GET /tasks/:taskId/sheets/:sheetId | 精确归属 | `{sheet,text,textSha256,wordCount,contentStatus,feedback}` | owner |
| POST /tasks/:taskId/drafts | `{parentSheetId:null或uuid,seed:blank或copy}` | `{sheet,created}` | owner |
| PATCH /tasks/:taskId/sheets/:sheetId | `{expectedVersion,text}` | `{sheet,textSha256}` | owner |
| POST /tasks/:taskId/sheets/:sheetId/submit | `{expectedVersion}` | `{sheet,attemptId}` | owner |
| POST /tasks/:taskId/sheets/:sheetId/discard | `{expectedVersion}` | sheet(discarded) | owner |
| GET /tasks/:taskId/sheets/:sheetId/feedback | 无写入 | `{state:pending或ready,feedback:null或记录}`；读取失败为非2xx | owner |
| GET /tasks/:taskId/sheets/:sheetId/feedback-context | sealed限定 | 上节context；含feedbackVersion | owner/agent |
| PUT /tasks/:taskId/sheets/:sheetId/feedback | 上节提交契约 | `{feedback,version,updatedAt,lastEditor}` | owner/agent |
| GET /tasks/:taskId/sheets/:sheetId/export | 单稿 | text/markdown；MD＋JSON、schemaVersion=1、hash | owner |

task DTO：id,questionId,title,kind,direction,status,prompt,createdAt,updatedAt；sheet DTO：id,taskId,status,draftVersion,revisionNo,parentSheetId,createdAt,updatedAt,sealedAt。摘要不含全文。复用已提交且无草稿的任务，create返回draft=null，前端进入历史；用户显式开始修改才创建新稿。wordCount 为信息性估算：匹配英文/数字串及内部撇号、连字符（`[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*`），中文不计英文词；另显示字符数，标注“英文词数估算”，不用于服务端接受与否。

## 7. 导出与删除

独立作文导出 schemaVersion=1（不冒充现有题纸 v2）。同一次只读事务生成：task题面、精确稿次、正文、parent引用、对应反馈、时间与hash；不得把其他稿自动打包。Markdown 文本块/JSON fence 正确处理正文反引号，HTML不执行；JSON结构可解析。filename只用安全固定前缀+sheetId。

草稿导出须先完成前端flush，服务端导出读取当前版本并将 draftVersion 写进产物。sealed从attempt读取；正文已清理返回409，含 quote 的反馈也不导出。任务归档不删除稿件；不开放任务硬删。已有题目DELETE遇写作任务引用需返回可理解的409 blocker，不能泄露其他owner的信息。

## 8. UI验收基线补充

复用 `docs/design/l3-space/baseline.md` 的 E1/E3/E4：首屏是用户自己的写作、修改痕迹可见、提交和回看贯通。新增 W1=动笔前最多一次弹层确认，W2=保存状态诚实，W3=反馈明确对应稿次，W4=离开再开不生成新稿，W5=修改不覆盖旧稿。

验收截图：空态、含draft列表、编辑中、保存失败、版本冲突、sealed等待反馈、反馈有定位、第二稿编辑、双稿对照、正文清理占位；至少桌面1440×900与手机390×844，明暗主题覆盖关键编辑/反馈页。截图配操作日志与DB核对，禁止把截图单独当行为证明。

## 9. 风险、指标与后续

主要风险是共享scope扩展、通用接口绕过、保存竞态、跨稿反馈串用、迁移并发。以契约测试和真实DB事务测试优先防守。

人工验收指标：新任务≤2次主要点击进入编辑；续写/回看≤2次主要点击；同一稿刷新页面后ID不变；网络故障不得产生“已保存”假象；两次submit最多一条attempt；无反馈时明确待评而非空白。性能在测试机器记录列表、保存p95及样本数，不设无证据的线上SLA。

后续独立计划：M2计时模拟与rubric评分；M3素材收藏/表达卡；M4反馈标签驱动练习。每项须有单独契约，不在本版“顺手做”。

### 发布与回退边界

迁移先在空库与最新已发布schema的非空fixture库演练；新列对旧file/paper行可兼容，扩展enum的消费者必须升级到识别writing的版本后才开放写作入口。不能在writing记录已经存在时直接回滚到不认识writing的旧二进制，也不能通过删除新表/稿件进行“回退”。出现缺陷时先撤下入口并在授权边界关闭新写作写请求，保留可读数据和修复/导出能力；安全回退目标应是仍理解新schema的兼容版本。发布、真实数据迁移和回退需由负责部署的任务另行获得授权，本计划默认止于draft PR。

### 需求覆盖检查

| 设计要求 | 实施任务 |
|---|---|
| 低摩擦入口、列表、题库起步 | W2/W7 |
| 数据真源、scope/venue/RLS | W1/W3/W6 |
| 保存重试、IME、版本冲突、提交屏障 | W3/W4/W7 |
| 反馈schema、hash/anchor、权限 | W1/W5/W6/W8 |
| 第二稿、历史深链、对照 | W3/W7/W8 |
| 导出、归档、正文清理 | W2/W9 |
| 真实闭环、故障与共享流程回归 | W10/W11 |
| 迁移协调、设计修订、部署边界 | W0/W1/W11 |

## 10. F-1接入兼容（f03ffe3校准）

现有题纸档案listArchive只面向file/paper，当前回看组件对其他scope报异常。v1作文历史仍由writing任务/稿次列表管理；旧GET /api/l3/sheets档案SQL显式限定file/paper，防writing记录落入无法打开的列表。单纸GET支持writing安全元数据及归属核验，纯sheet深链通过只读scope分流进入作文。不要为了复用档案而把作文feedback伪装成generic graded_count。

复用F-1的交互语义和已验证行为，不复制其大型组件；review_sheet_id是注记评语来源，不能用作作文feedback正文版本。作文feedback仍绑定sheetId+textSha256。普通file/paper刷新、改判、跨轮隔离、F5不新增纸必须在W10回归。
