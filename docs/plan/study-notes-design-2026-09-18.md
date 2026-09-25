# 题型学习笔记设计 v1

日期：2026-09-18。用户已选定“新增轻量学习笔记，引用现有对象”，主要用途为自由笔记与专题整理。本文收敛为可执行的 v1 设计，不表示代码已经实现。任务分解见 `study-notes-execution-plan-2026-09-18.md`，执行交接见 `study-notes-start-prompt-2026-09-18.md`。

## 0. 基线与项目关系

- 编写时观察 HEAD：`main@219be04`，PR #120 已合并。**执行校准（2026-09-19）**：实际开工基线为 `integration/l3-reliability-writing@b7dcea4e`（PR #125，draft 未合并）；整合批次已含 reliability-batch、writing-practice-v1 与 Task C。
- 编写时工作区正在推进 F-1 历史题纸、review_sheet_id 与并发修补；`0037_strong_boomerang.sql` 及 journal 已被其他任务占用。**执行校准**：`0037_strong_boomerang.sql` 与 `0038_empty_blink.sql` 均已随历史批次应用（39 迁移）；本批迁移号从实际生成结果起（0039），不预占。
- 编写时末次复查记录：F-1 前端出现 `/l3?sheet=<id>`、`?paper=<id>`、`L3ExamPaper.replaySheetId` 与“刷新评卷”。**执行校准**：该深链协议已随整合合并，为已核验的稳定协议（不再标注“进行中”）。N1导航必须兼容这些参数，N2复用最终合并的回看协议，不自行改名为另一套sheet参数。
- 同日存在 `writing-space-design-2026-09-18.md`。它负责作文任务/稿次/反馈，本设计负责跨材料学习笔记；不建立第二份作文正文或作答历史。**执行校准**：作文稿次协议（task/sheet/origin/resume）已随整合合并；N2 的历史引用合同按已合并接口对齐。
- 当前 `note_entries` 依附词/词书；annotations 依附题目；assessments 为单题评析；`context_type=note` 依附 source、随 source 删除级联，均不适合作为独立跨题长篇笔记。
- ADR-0019 明确独立生命周期可拆知识点实体。执行时新增非编号 ADR `docs/adr/study-notes-workspace.md`，修订其知识笔记范围，不复活已退役的单词 notes/note_revisions 模型。
- 仓内规范要求新计划统一放 `docs/plan/`，因此不另建重复的 superpowers 计划副本。

## 1. 分期边界

### N1：本执行计划的完整交付范围

七题型各自的学习笔记入口；自由 Markdown 编辑；显式跨题型归属；平面专题、专题内排序；搜索/分页/置顶/归档；引用整题、来源、原文/题干/选项片段；预览、只读定位、反向引用；卷面/阅读面侧栏摘录；并发保存保护；含出处与摘录的 Markdown 导出。

所有 N1 页面可在无题目时写笔记。引用不是必填，专题不是必填。无自动掌握度、无 FSRS、无自动 agent 写笔记。

### N2：独立后续交付，不混入 N1

注记与评析摘录、笔记间引用、历史 attempt/sheet/grading、作文稿次/feedback 引用及对照。启动条件：F-1 已有稳定的按 sheetId 只读回看；作文稿次接口已合并并验收；明确历史引用的内容清理与改判语义。N1 引用输入 strict 枚举不预留可任意写 JSON 的后门。

### N3：产品扩展

Agent 提议整理/合并、专题导读、从引用题集发起复练。届时另定提案与权限；不将既有 agent 评卷权限自动扩大为改写私人笔记。

## 2. 产品行为

### 入口

在 `L3PapersPage` 每个题型入口内部呈现“题目素材 / 学习笔记”。没有文件的题型也能进入笔记。直接链接：

```text
/l3?section=study-notes&venue=reading_choice
/l3?section=study-notes&venue=reading_choice&topicId=<uuid>
/l3?section=study-notes&venue=reading_choice&noteId=<uuid>&refId=<uuid>
```

内部 `L3ShellSection` 新增 `studyNotes`，URL 使用 `study-notes`。显式 section 优先于旧 venue/file 深链处理；不让同一个 query 触发两个 effect 抢导航。noteId 必须归 owner；venue 必须在其归属中，错误组合显示404/无效入口，不创建笔记。refId 不存在显示“该引用已移除”，保留打开笔记。

笔记列表每页20、最大50：默认更新时间倒序，置顶仅作筛选/徽标，不改变默认 cursor 排序。专题内按 position 升序。搜索标题和正文，q 最长100，用户 `%` `_` 按文字转义；不默认检索引用摘录。归档列表独立过滤。客户端跨页按 id 去重。

### 组织

一篇笔记拥有1–7个题型归属，使用同一 noteId。创建从当前题型默认带入。专题归属于一个题型，笔记可加入多个专题；移出专题不删笔记。专题成员必须具备该专题题型归属。

移除题型时若仍属于该题型专题，服务端409并列出专题；用户先移出专题，再移除题型。最后一个题型不得移除。引用某个题型的题目不自动增加归属。

题型与专题继承既有7值，能力域通过映射展示；v1不增加第三套分类轴。考试方向仅作引用选材筛选，笔记不限定方向；关键词可写正文。独立标签和多层文件夹后置。

### 编辑

标题0–120 UTF-16 code units，空时显示“无标题笔记”；Markdown 正文0–100,000。textarea + 预览，支持 IME，沿用 marked + DOMPurify。客户端空白笔记合法；列表显示占位，不伪造内容。

自动保存防抖800ms；单笔记最多一个在途写，后续编辑排队。显式“保存/重试”与导出必须 await flush。失败保留当前输入，显示失败，不能声称自动重试；409暂停写入，提供复制本地正文、查看服务器版本、确认载入。v1不提供盲目覆盖按钮，不持久化离线队列。

站内离开在 dirty/saving/error/conflict 时确认；浏览器关闭/刷新用 beforeunload 尽力提示，明确不保证关闭后恢复未保存字。站内侧栏切换笔记先处理未保存内容。

### 侧栏与返回

选中原文/题干/选项后提供“引用到学习笔记”；保存 selection 坐标再移动焦点。右栏可选最近笔记、搜索、创建；移动端全屏层使用相同编辑状态。打开/关闭侧栏不能卸载卷面、清空选择或重建题纸。与现有圈词/注记并列，保留原有行为。

在卷面“相关学习笔记”中只展示标题和篇数，正文及引用内容均默认折叠；显式打开提示“将查看学习资料”。不能仅遮标准答案字段就宣称没有剧透，用户自己的文字也可能包含答案。

## 3. 引用契约

### 输入类型（camelCase）

```ts
type ReferenceTarget =
  | { kind: "source"; sourceId: string }
  | { kind: "source_quote"; sourceId: string; start: number; end: number; quote: string }
  | { kind: "question"; questionId: string }
  | { kind: "stem_quote"; questionId: string; start: number; end: number; quote: string }
  | { kind: "option_quote"; questionId: string; optionKey: string; start: number; end: number; quote: string };
type ReferenceInput = { id: string; target: ReferenceTarget };
type ReferenceWrite =
  | { id: string; action: "keep" }
  | { id: string; action: "capture"; target: ReferenceTarget };
```

所有对象 strict；UUID合法；start/end 为非负整数且 end>start；quote 1–4000；optionKey 1–8；每篇最多100引用。question 目标支持全部现有题型，包括无 source 的作文/句译。

### 正文标记

```markdown
我的判断是，选项扩大了原文的范围。

[[ref:00000000-0000-4000-8000-000000000001]]

另一个例子说明，应结合上下文判断。
```

标记只在 **marked lexer 顶层 paragraph token 的 text 完全等于标记** 时识别；代码围栏、inline code、引用块、标题、列表内的同形文本按普通 Markdown 显示。每个 markerId 在正文中仅出现一次；同一来源多次引用使用不同引用ID。标记集合必须与 ReferenceWrite.id 集合完全相等且无重复，保存时由服务端校验。缺失或多余引用返回422，不静默丢弃。

正文与引用同一次事务保存。删除 marker 时编辑器同时删除对应写入项；服务器删除失去 marker 的旧引用。剪贴板粘贴引用卡需新发 id；手写未知标记明确报错。预览用 React 引用卡，普通 Markdown 使用既有净化渲染；不把用户 HTML 当引用卡执行。

### 来源与摘录

- capture 由服务端读取真实目标、校验 owner/active/字段/截取文字。前端 quote 必须严格等于数据库字段的 `slice(start,end)`；不能信任用户提交的出处、快照或 hash。
- 位置基于数据库原字符串的 UTF-16 code unit，选区不 trim、不做 Unicode normalization、不按显示序号定位；引用 hash 为该原字段 UTF-8 bytes 的 SHA256。跨多个字段的选择拒绝并说明原因。
- 整题快照只含当时题干/选项/题型/可读来源标题，不含标准答案、explanation、evidence。来源整体快照仅标题和前280 code units摘要；完整正文通过预览查询读取。
- hash字段口径：source/source_quote使用完整content_text（NULL整体来源按空字符串）；stem_quote使用stem；option_quote使用对应option.text；question使用固定键序 `{stem,options}` 的JSON（options保持题面顺序）。改标题只更新liveTitle，不使原文片段变为changed；whole question的选项改写会标changed。
- 每条保存引用含 capturedAt、fieldHash、displaySnapshot 和定位。全部 snapshot 序列化总量上限2 MiB，超出422；避免100个整题造成无限放大。
- `keep` 引用必须已经属于当前笔记，只保留原摘录，不自动重新截取。`capture` 可新建或显式更新当前引用；已被其他笔记使用的引用 id 返回409。
- 引用状态：current / changed / unavailable。字段hash不同标changed；旧摘录仍显示，但不把旧offset套到新正文。v1不自动重锚，用户重新选择更新引用。
- 题目可用性（2026-09-19 补修 F3 校准）：仅 `status='active'` 的题可被搜索、预览与新增 capture；pending/rejected 目标按不可用目标 404（不区分存在性）。目标后来非 active：已保存引用照常保留（resolve=unavailable，旧摘录/capturedAt 不变），允许 keep 与移除，禁止显式重新 capture。`unavailable` 同时覆盖「目标被数据库直删」与「目标非 active」两种来源，前端按同一占位展示（原始摘录仍可读），不使整篇笔记不可读或不可保存。
- 只读预览与定位由独立面板承担，不调用 openSheet。来源可跳既有阅读深链；整题/选项通过新只读题目预览定位，避免去做题文件时顺带创建草稿。

## 4. 删除与授权的 v1 明确取舍

为避免“删除源材料但未知快照继续散落”的复杂分支，**N1 采用引用阻止源永久删除**：先移除引用或显式转换为普通摘录，才能删源。归档笔记中的引用仍阻止删除。源删除409返回可读笔记标题/引用数及处理入口。

转换为普通摘录是用户明确操作：把卡片替换为正常 Markdown 引文及来源文字，同次保存移除 reference。界面注明“将保留一份独立文字摘录”。这与“彻底删除引用及摘录”是不同选择。N1不自动批量转换或清除。

来源删除必须计入其下题目引用，因为当前 question→source 为 ON DELETE CASCADE。数据库使用复合 owner FK + RESTRICT 防竞态；服务端为可理解 blocker 提供预检查，FK异常仍映射409。直接数据库越过应用的异常缺失显示 unavailable，不把笔记整页渲染失败。

N1笔记/专题只有归档恢复，无硬删入口；正文/引用可编辑移除。所有新HTTP端点 owner-only；未认证401，agent403，他人资源404。引用解析、反向索引、导出都走 actor事务/RLS。不得借现有评析 agent 写权限扩大此面。

## 5. 数据模型：5张表

统一 `user_id`、RLS own_all、UNIQUE(id,user_id) 用于复合FK。更新在 repo 内 requireTx；service 通过 withTransaction(actorId) 与 createRepositories(tx)。

1. **l3_study_notes**：id、user_id、title、body_md、status(active|archived)、pinned bool、version integer>=1、create_request_id UUID、create_input_hash、last_write_request_id UUID?、last_write_hash?、created_at/updated_at。UNIQUE(user_id,create_request_id)；索引(user_id,status,updated_at DESC,id DESC)，标题/正文采用已有pg_trgm GIN模式。没有 source/word/sheet 必填FK。
2. **l3_study_note_venues**：note_id,user_id,question_type；PK(note_id,question_type)；复合FK(note_id,user_id)→notes，CASCADE；索引(user_id,question_type,note_id)。至少一个归属由唯一应用写入口在事务内保持，题型CHECK复制现行7值。
3. **l3_study_topics**：id,user_id,question_type,title(1–120),status(active|archived),version>=1,create_request_id,create_input_hash,last_write_request_id?,last_write_hash?,created_at/updated_at；请求幂等同notes；索引(user_id,question_type,status,updated_at,id)。同名允许，不靠标题作身份。
4. **l3_study_topic_notes**：topic_id,note_id,user_id,position integer>=0；PK(topic_id,note_id)；两个复合owner FK CASCADE；position非唯一，排序(position,note_id)。成员编辑锁topic、更新topic version；保持当前成员position连续0..n-1；不更新笔记正文version。成员最多500，超限422，避免重排无界增长；列表仍分页。
5. **l3_study_note_references**：id,note_id,user_id,kind,source_id?,question_id?,option_key?,start_offset?,end_offset?,quote_snapshot?,field_hash,display_snapshot jsonb,captured_at。恰一 source/question 非空且匹配kind；quote类要求offset/quote，option_quote要求option_key；复合FK(note_id,user_id) CASCADE，source/question owner FK RESTRICT。索引(user_id,source_id,note_id)、(user_id,question_id,note_id)、(note_id)。

不需要独立backlinks表：从references派生并按note去重，返回referenceCount与refIds。

## 6. 保存一致性

创建 `{requestId,venue}`：返回新空白笔记version1；同owner requestId同输入重试返回当前笔记，不重置已编辑内容；同requestId不同输入409。create_input_hash只覆盖最初创建载荷。

保存为完整笔记状态：

```ts
type SaveNoteInput = {
  expectedVersion: number;
  requestId: string;
  title: string;
  bodyMd: string;
  venues: L3QuestionType[];
  pinned: boolean;
  status: "active" | "archived";
  references: ReferenceWrite[];
};
```

顺序：锁note → 若last requestId及规范化请求hash相同返回当前结果；同ID异载荷409 → 比较expectedVersion → 校验专题/marker/目标与限额 → CAS更新正文及version+1 → 归属与引用替换 → 提交。失败整体回滚。hash对完整经过schema解析的固定键序对象计算，包括引用动作和期望版本；客户端重试沿用同一序列化payload/requestId。

仅保证最后一次请求的幂等；旧requestId已被新写入覆盖则按version冲突处理，不虚称全历史去重。冲突409细节仅返回currentVersion，不自动返回他人内容。服务端GET不产生任何写入。

## 7. HTTP合同

基路径 `/api/l3/study-notes`；所有owner-only，JSON输入输出camelCase。响应 `{item}` 或分页 `{items,total,nextCursor}`；分页limit默认20最大50。领域DTO禁止携带userId给客户端写入。

| 方法 | 路径 | 入参/输出 |
|---|---|---|
| POST | / | `{requestId,venue}` → `{item,created}`，201/200 |
| GET | / | venue必填；q?,status,pinned?,topicId?,unfiled?,limit,cursor；topicId与unfiled互斥 |
| GET | /:noteId | `{item}`，含正文、venues、version与reference previews |
| PUT | /:noteId | SaveNoteInput → `{item}` |
| GET | /:noteId/export | text/markdown，header带版本/hash；正文+引用出处+JSON结构块 |
| GET | /reference-targets | q?,kind=source|question,venue?,limit,cursor；摘要不含答案 |
| POST | /reference-preview | ReferenceTarget → `{preview}`；只读，不持久化 |
| GET | /backlinks | targetKind=source|question,targetId,limit,cursor；默认不含归档，返回篇数和引用处数 |

固定路径必须在 `/:noteId` 前注册（或独立薄路由），UUID不合法400，不能误入详情路由。

专题基路径 `/api/l3/study-topics`：

| 方法 | 路径 | 入参/输出 |
|---|---|---|
| POST | / | `{requestId,venue,title}` → `{item,created}` |
| GET | / | venue必填、status,limit,cursor → Page<Topic> |
| PUT | /:topicId | `{requestId,expectedVersion,title,status}` → `{item}` |
| PUT | /:topicId/members/:noteId | `{requestId,expectedVersion,beforeNoteId:null或uuid}`；加入或移动，返回 `{item:topic}` |
| DELETE | /:topicId/members/:noteId | `{requestId,expectedVersion}` JSON；移出，返回 `{item:topic}` |

beforeNoteId必须为同专题另一个成员，否则422；跨题型未归属409。专题成员操作与元数据更新共享topic版本及last_request幂等字段。归档topic不能修改成员；先恢复。归档note仍保持成员和引用，默认列表隐藏。

cursor不透明base64url JSON带sortKind/lastSort/id及filter指纹，长度/字段校验400；不能将A专题cursor用于B专题。时间列表用updatedAt/id；成员列表用position/id。目标搜索每次只查一个kind，source采用createdAt/id，question采用createdAt/id；total与列表过滤一致。复用既有分页工具仅在其语义完全满足时使用。

## 8. 代码职责与共享修改

新增模块：domain `l3-study-notes.ts`（DTO/zod/marker）、`l3-study-note-save.ts`（纯保存控制）；repositories notes/topics/references；services notes/references/export；HTTP input/response合同及三个薄路由；frontend独立API、页面、编辑器、引用卡、侧栏与预览器。

整合点：factory/interfaces、services/index、http/server/operations、schema/角色脚本、L3Page/L3PapersPage/L3ShellSection、卷面/阅读选区及删除blocker。新功能不得把全部逻辑塞进近两千行L3ExamPaper。与作文空间共同涉及L3Page、schema、operations，合入时顺序处理。

## 9. 验收标准

- N1完整闭环：无题创建笔记 → 写自由内容 → 引两道不同题及原文/选项 → 归专题并跨题型 → 离开重开 → 精确定位 → 反向查到 → 导出离线可读。
- 失败：断网保存不标成功；第二窗口旧版本409；重试同请求不升两次版本；保存中导出等待；侧栏关闭不卸载卷面。
- 引用：代码围栏标记不识别；重复ID/缺失标记422；非ASCII/emoji锚点一致；改原文字段后提示changed、不错高亮；source删除考虑子题引用并409。
- 权限：真实受限PG角色、两个owner互不可见，agent全部新写读403；mock测试不替代RLS。
- 规模：至少121笔记、121目标素材、55专题分页可达；专题排序跨页不丢条目；不存在硬编码取前100即结束。
- UI：引用baseline E1/E3/E4，补N1自由创建/N2原位引用/N3出处可追溯/N4保存诚实；桌面1440×900与手机390×844、明暗主题、空/载入/失败/有内容截图及实际操作日志。

这是新增笔记能力的验收，不要求顺手完成全站搜索、作文开发或自动评卷。
