# 学习笔记 N1 前端任务书（Task 07–08 · 校准版）

> **本文件是 Task 07–08 的可独立执行版本**：校准自 `study-notes-execution-plan-2026-09-18.md`（Task 07/08 原文保留、不改写）与 2026-09-20 收尾轮任务书要求（§四 1–9 全部落实）。与原文冲突时以本文件为准。
> **前置状态**：后端 Task 00–06 已交付（`docs/plan/study-notes-backend-execution-2026-09-19.md`）；F1–F5 补修与工程收尾见 `docs/plan/study-notes-backend-repair-2026-09-19.md`、`docs/plan/study-notes-engineering-closeout-2026-09-20.md`。
> **本轮（2026-09-20）只交付本文件；不开工任何前端代码。**（历史注：该行为收尾轮记录；Task 07 执行轮已在其后开工。）
> **Task 07 执行轮校准（2026-09-20，开工前同步，本文件内文已按此修订）**：
> ① 删除 S4「新内容 T2 复用 R1」例外——只有**完全相同的未确认请求**重试才复用其 requestId；T1 确认后发送 T2 必须**新 requestId、新确认版本**。
> ② S10/S11/N10 的「无写」断言改为「不误报确认 / 不接受旧代回包 / 不继续导航」——请求可能已提交但响应丢失，**实际结果以库核为准**。
> ③ 删除冲突态「确认已合并后重试」：仅保留**复制本地内容**与**显式载入服务器版本**；载入成功后重新编辑，以**新 requestId 和新基线**保存，不做自动合并、不做强制覆盖。
> ④ 与后端实际合同逐条核对后的两处校准：preview 请求体为 `ReferenceTarget` **本体**（无 `{target}` 包装）；布尔 query 为 **`"1"/"0"`**（非 `true/false`）。证据见 `study-notes-task07-execution-2026-09-20.md` §1。
> ⑤ 工程环境校准：Windows Temp 守卫遗漏（`scripts/run-alerting-drill.ts` 仅检测 `os.tmpdir()`，运维合同要求演练锁在所有临时目录之外）**登记为独立观察项**；本批不修改告警系统、不靠该缺口制造门禁绿色；「挂死系统层根因未闭环」口径同步（见 closeout 文档校准注）。
> 执行过程与证据落于 `docs/plan/study-notes-task07-execution-2026-09-20.md`（不预填通过）。

---

## 0. 后端消费合同（冻结基线，实现前逐条核对）

### 0.1 端点（12 操作；全部 owner-only；camelCase；薄路由已注册）

| 方法 | 路径 | 入参 → 输出 |
|---|---|---|
| POST | `/api/l3/study-notes` | `{requestId, venue}` → `{item, created}`（201/；同 requestId 同输入 200 复用） |
| GET | `/api/l3/study-notes` | `venue`(必填), `q?`, `status?`, `pinned?`, `topicId?`, `unfiled?`, `limit?`, `cursor?` → `Page<StudyNoteSummary>` |
| GET | `/api/l3/study-notes/:noteId` | → `{item: StudyNoteDto}`（单快照：body/version/venues/references 同属一次提交） |
| PUT | `/api/l3/study-notes/:noteId` | `SaveNoteInput` → `{item}` |
| GET | `/api/l3/study-notes/reference-targets` | `q?, kind(source\|question), venue?, limit?, cursor?` → `Page<StudySourceTargetItem\|StudyQuestionTargetItem>` |
| POST | `/api/l3/study-notes/reference-preview` | `ReferenceTarget` **本体**（无 `{target}` 包装）→ `{preview}`（只读，非持久化；POST 仅沿用 CSRF 保护） |
| GET | `/api/l3/study-notes/backlinks` | `targetKind, targetId, limit?, cursor?` → 反向引用（按 note 去重） |
| POST | `/api/l3/study-topics` | `{requestId, venue, title}` → `{item, created}` |
| GET | `/api/l3/study-topics` | `venue`(必填), `status?`, `limit?, cursor?` → `Page<StudyTopicDto>` |
| PUT | `/api/l3/study-topics/:topicId` | `{requestId, expectedVersion, title, status}` → `{item}` |
| PUT | `/api/l3/study-topics/:topicId/members/:noteId` | `{requestId, expectedVersion, beforeNoteId: uuid\|null}` → `{item: topic}` |
| DELETE | `/api/l3/study-topics/:topicId/members/:noteId` | JSON body `{requestId, expectedVersion}` → `{item: topic}` |

**未实现端点**：`GET /api/l3/study-notes/:noteId/export`（Task 10）。客户端**不得**为其预留「成功假象」接口（不写 stub、不返回占位数据）。

### 0.2 保存 / 幂等 / 错误（冻结语义）

- `SaveNoteInput = { expectedVersion, requestId, title, bodyMd, venues, pinned, status, references }`（**完整状态**）；幂等为**最后一次请求**（last request）语义：同 requestId 同载荷 → 返回当前结果（不二次推进）；同 ID 异载荷 → 409；旧版本 → 409（响应含 `meta.currentVersion`）。
- 409 只返回 currentVersion，**不自动返回服务器内容**（载入需显式 GET）。
- 422 字段级（`bodyMd` / `quote` / `options` / `beforeNoteId` 等）；marker 集合必须与 references 集合完全相等，缺失/多余/未知标记 422。
- 引用写：`{id, action:"keep"}`（保留原摘录/capturedAt，不重 capture）；`{id, action:"capture", target}`（新建或显式更新）。目标非 active → 404；`unavailable` 引用可继续 keep、可移除，禁止显式 re-capture。
- UUID 大小写不敏感（前端可原样透传；响应 id 一律小写）。
- 删除 blocker（source/question 被引用时 409，`meta.blockers.studyNotes` + `resolution`）——前端仅展示，本批不改既有删除 UI 结构。

### 0.3 游标合同（Task 08/09 共用）

- 目标搜索游标 = `createdAt` 族 + **过滤指纹**：换 `kind` / `q`（规范化后） / 有效 `venue` **必须清空 cursor**，复用旧 cursor → 400；`limit` 可自由调整。
- 笔记/专题/backlinks 列表：换任何筛选（venue/topicId/unfiled/status/pinned/q）必须清 cursor；`topicId` 与 `unfiled` 互斥。
- 游标不可跨资源复用。

### 0.4 DTO 与校验来源

- 类型：`src/domain/l3-study-notes.ts`（`StudyNoteDto` / `StudyTopicDto` / `ReferencePreview` / `StudyPage<T>` / `StudyBacklinkItem` 等）。
- **运行时校验的 zod 契约**：`src/http/l3-study-note-response-contract.ts`（12 个 schema，命名 `l3Study*ResponseSchema`）——**前端直接 import（先例：`src/frontend/api/writingClient.ts` §W6 即 import `@/http/l3-writing-response-contract`）**。
- `src/frontend/api/generated/openapi.ts` 已含 12 操作（生成客户端），可作类型参考，但**手写 client 以 response-contract schema 为准**。

---

## 1. Task 07 前置 · 手写 `studyNotesClient.ts`（Task 06 延期项归入本任务）

### 1.1 文件

- 新增：`src/frontend/api/studyNotesClient.ts`
- 新增：`tests/frontend/study-notes-client.test.ts`
- 不改：`src/frontend/api/l3Client.ts`（不继续扩展大 client）；不改既有 client 行为。

### 1.2 纪律（与 `writingClient.ts` 同构，逐条硬性）

1. 复用 `createBrowserResponseRequest`（`src/frontend/api/browserRequest.ts`）：认证/CSRF/超时/401 全局事件**不另起一套**。
2. 每个响应经**服务端契约 zod 运行时校验**；失败抛 `BrowserApiError(code="INVALID_RESPONSE")`——**非法 200 绝不能归一为「空笔记 / 无引用 / 空列表」**；缺失字段不得补默认。
3. 所有入参类型来自 `@/domain/l3-study-notes`；所有响应 schema 来自 `@/http/l3-study-note-response-contract`。
4. **不提供** export/未实现端点的客户端函数；也不提供「未接线」的假成功路径。
5. query 序列化：`undefined` 不发送；布尔以字符串 `"1"/"0"`（**2026-09-20 校准**：实际合同 `pinned`/`unfiled` 为 `enum("0","1")`，见 `l3StudyNoteListQuerySchema`/openapi；`true`/`false` 会被 400）；cursor 原样透传（不解析、不重建）。

### 1.3 操作映射表（12 个，命名建议 `studyNotesClient.*`）

| 客户端方法 | HTTP | 校验 schema |
|---|---|---|
| `create({requestId, venue})` | POST /study-notes | `l3StudyNoteCreateResponseSchema` |
| `list(query)` | GET /study-notes | `l3StudyNoteListResponseSchema` |
| `get(noteId)` | GET /study-notes/:noteId | `l3StudyNoteItemResponseSchema` |
| `save(noteId, input: SaveNoteInput)` | PUT /study-notes/:noteId | `l3StudyNoteItemResponseSchema` |
| `searchTargets(query)` | GET /study-notes/reference-targets | `l3ReferenceTargetListResponseSchema` |
| `preview(target)` | POST /study-notes/reference-preview | `l3ReferenceTargetPreviewResponseSchema` |
| `backlinks(query)` | GET /study-notes/backlinks | `l3StudyBacklinkListResponseSchema` |
| `createTopic({requestId, venue, title})` | POST /study-topics | `l3StudyTopicCreateResponseSchema` |
| `listTopics(query)` | GET /study-topics | `l3StudyTopicListResponseSchema` |
| `saveTopic(topicId, input)` | PUT /study-topics/:topicId | `l3StudyTopicItemResponseSchema` |
| `moveTopicMember(topicId, noteId, input)` | PUT /study-topics/:topicId/members/:noteId | `l3StudyTopicItemResponseSchema` |
| `removeTopicMember(topicId, noteId, input)` | DELETE /study-topics/:topicId/members/:noteId | `l3StudyTopicItemResponseSchema` |

### 1.4 测试（最小集）

- 非法 200（缺 `item` / 篡改 `total` 类型 / references 元素缺 `status`）→ 抛 `INVALID_RESPONSE`，**不是**空结果。
- 409/422 的 `BrowserApiError` 传递 `code/details/meta`（含 `currentVersion`）不吞。
- 错误响应（500 带非 JSON）→ 不崩溃、错误可读。
- 请求构建：布尔/undefined/cursor 序列化正确；DELETE body 通过 `body` 发送。
- 无 export 方法（import 断言不存在——防「假成功接口」回归）。

---

## 2. Task 07 · 可靠编辑与保存控制器

### 2.1 状态与快照模型（**完整状态快照**，非逐字段补丁）

- 编辑载荷 `T = {title, bodyMd, venues, pinned, status, references}`（即 `SaveNoteInput` 去掉 `expectedVersion/requestId`）。
- 控制器不变量：
  1. **单在途**：同一时刻至多一个 PUT 在途；
  2. **最新待发送快照**：每次 `edit(T)` 覆盖「待发送快照」并 `editSeq++`；
  3. **自增编辑序号** `editSeq`／**已确认序号** `savedSeq` 独立推进；
  4. **正文/归属/置顶/归档共享同一控制器**——标题、正文、venues、pinned、status、references **只经这一条保存通道**，禁止任何字段走独立 PUT；
  5. 专题（topic）元数据与成员操作为**另一条串行通道**（见 §3.4），两条通道互不合并。

### 2.2 发送 / 重试 / 排队（A/B 交错语义）

- 发送时刻**冻结**：`payload/requestId/expectedVersion` 三项在发送时确定（`requestId` 每次新发送新生成；**重试沿用**）。
- `edit(T2)` 发生在 T1 在途期间：只更新「待发送快照」与 `editSeq`；**不得修改在途载荷**。
- T1 回包：**只确认 T1**（`savedSeq = T1 的序号`）——不得覆盖 T2 输入、不得把 T2 标记为已保存；`version` 更新为 T1 回包版本；随后 T2 以**新版本**发送（`requestId` 新生成）。
- 网络结果不明（超时/断网/5xx/429）：**原样重试**（同 payload/requestId/expectedVersion），退避 1/2/4s 共 3 次；重试期间新编辑**排队**（不混入重试载荷）。
- **重试遇 409 → 立即停止自动写**，进入 `conflict`；**不得猜测服务器版本后继续覆盖**。
- 非 409/429 的 4xx：进入 `error`（保留本地输入）；422 展示字段级信息（`bodyMd`/`quote`/`options`）。

### 2.3 flush 完成边界与回执

- `flush()`：等待「**调用时刻的 `editSeq`**」被服务端确认（允许期间有更大序号排队）才 resolve。
- 回执：`{version, editSeq, lastSavedAt}`；`lastSavedAt` **来自真实确认**（PUT 成功响应的 `updatedAt`），不得用本地时钟伪造。
- 失败必须 `reject`（`error`/`conflict` 下调用或等待中转入失败态即 reject）——**不得静默 resolve**。
- 在途新编辑与导航的协调：宿主导航前 `await flush()`；`flush` pending 期间到达的新编辑**由该 flush 等待其确认吗？不**—— flush 只对「调用时刻序号」负责；导航前若有新编辑 → **再次 flush**（或等待「最新序号」的专用方法），由 §2.7 的导航辅助封装统一处理。
- 订阅合同：状态变化即通知；**终态帧**（clean/error/conflict 稳定态）必须反映 `inFlight=false`；`dispose` 后不再通知。

### 2.4 冲突（409）与恢复（用户明确选择，不自动）

- `conflict` 状态：**停止自动写**；保留本地输入。
- 提供两个明确动作（UI 文案对应；**2026-09-20 纠偏：删除「确认已合并后重试」**——不做自动合并、不做强制覆盖、不提供「确认后继续用旧本地内容覆盖重试」）：
  1. **复制本地内容**（剪贴板；不产生请求）；
  2. **查看/载入服务器版本**：显式操作 → `GET /:noteId` → `adoptServerSnapshot(dto)`（放弃本地未确认输入、以服务器快照重建编辑基线）。
- 载入成功后用户**重新编辑**；保存以**新 requestId** 与**新基线（载入得到的版本）**进行，不得沿用冲突前的 requestId 或旧 expectedVersion。
- **载入前必须先提供复制本地副本的机会**（顺序保障：按钮可得性/操作序列上有明确保全点）。
- **恢复请求期间锁编辑**（或核对 `editSeq`）：`GET` 在途期间产生的新输入**不得被恢复结果吞掉**——若发生新编辑，恢复结果作废（放弃替换或提示重新获取），**绝不静默覆盖**。

### 2.5 首次加载 / 刷新与本地态替换（**修正「整包替换」口径**）

- **纠正既有说法**：`GET /:noteId` 单快照**不等同**「可直接整包替换本地态（无条件的）」。
- 打开笔记（含 F5/深链/历史返回）：
  1. **只 GET，不创建**（创建仅由显式操作发起，见 §3.1）；
  2. 首次加载也须校验 **note 身份**（响应 `id` 与目标 `noteId` 一致）与**请求代际**（最新请求）；
  3. **仅当无更新的本地编辑时**才允许以响应替换本地态；有 dirty 编辑时：不替换（提示或合并流程，按实施时设计取保守：保留本地 + 显式刷新入口）。
- 「GET 一致性」只保证该响应内部自洽；**响应不代表永远最新**——保存仍由 `expectedVersion` CAS 把关（过期 → 409 → §2.4）。
- 打开失败（404/网络）：错误态 + 重试；**不落回创建、不显示空笔记**。

### 2.6 引用保全（Task 07 起即生效；深度引用 UI 后置不豁免）

- 打开已有笔记：`references` **原样进入编辑态**（不裁剪、不重 capture、不看 kind）；正文 marker 原样。
- 保存已有笔记（仅改标题/正文等）：`references` 全部以 `{id, action:"keep"}` 随同保存——**keep 不重新 capture**（保留原摘录与 capturedAt）。
- **marker 保护（基础编辑阶段的硬边界）**：
  - 保存前本地预检：`parseReferenceIds(bodyMd)` 与 references 集合比较（复用 `@/domain/l3-study-notes` 的纯函数）；
  - 不一致（如用户手删了 marker 行）→ **阻止提交**并提示「引用标记与引用清单不一致」+ 恢复指引；**不得**静默保存（会 422/损伤引用）；**不得**自动改 bodyMd。
  - 「同步移除」（删 marker + 删 ref 同次保存）作为**显式操作**留给 Task 09（引用侧栏「移除引用」）；Task 07 只需保证保存器接受完整 references 数组（已满足）。
- `unavailable` 引用：保留快照展示（占位），保存时照常 keep；**不得**因 unavailable 而阻断整篇保存。
- **红线**：任何「打开/保存已有笔记」路径都不得把 `references` 清空、不得丢失 marker——这是本任务不可妥协项。

### 2.7 hook 与组件

- `src/frontend/hooks/useStudyNoteEditor.ts`：
  - 800ms 防抖 + IME（composition 期间不发，compositionend 后按防抖补发）；
  - 控制器生命周期：**不在 render 期重建**；以 `noteId` 为 key 在 effect 中重建（ref 持有实例）；StrictMode 双挂载安全（旧实例 dispose、新实例接管；旧回包按代际丢弃）；
  - 离页保护：站内导航（切 topic/venue/note、返回列表、点任何导航）在 dirty/saving/error/conflict 时先 `flush`/确认；失败 → **保持原位**（不导航）并给出恢复入口；
  - 浏览器关闭/刷新：`beforeunload` 尽力提示；**明确不承诺关闭后异步保存必完成**（UI 文案与文档禁止承诺）。
- `src/frontend/components/studyNotes/StudyNoteEditor.tsx`：
  - 标题（≤120）/正文（≤100k，textarea + 预览，marked + DOMPurify 复用现有净化渲染）；
  - 状态条诚实：`已保存/未保存/保存中/保存失败/冲突`（对应 lastSavedAt、错误、冲突提示）；
  - 冲突面板：复制本地内容 / 载入服务器版本（显式）；（**不含「确认已合并后重试」**，见 §2.4 纠偏）；
  - 正文中的 `[[ref:...]]` 标记：渲染为引用占位（Task 09 完整卡片前的**安全占位**：不可编辑区域/只读文本，绝不作为 HTML 注入）。

### 2.8 文件清单（Task 07）

- 新增：`src/frontend/state/studyNoteSaveController.ts`、`src/frontend/hooks/useStudyNoteEditor.ts`、`src/frontend/components/studyNotes/StudyNoteEditor.tsx`
- 新增测试：`tests/frontend/study-note-save.test.ts`（控制器竞态）、`tests/frontend/study-note-editor.test.tsx`（组件级）
- 关联：`src/frontend/api/studyNotesClient.ts`（§1）

### 2.9 接口草案（实现者可细化命名，语义不可减）

```ts
export type StudyNoteSaveState = "idle" | "dirty" | "saving" | "error" | "conflict";

export interface StudyNoteEditSnapshot {
  title: string; bodyMd: string; venues: L3QuestionType[];
  pinned: boolean; status: StudyNoteStatus; references: ReferenceWrite[];
}
export interface StudyNoteSaveSnapshot {
  state: StudyNoteSaveState; inFlight: boolean;
  editSeq: number; savedSeq: number;
  version: number;                 // 最近服务端确认版本
  lastSavedAt: string | null;      // 来自真实确认
  conflictCurrentVersion: number | null; // 仅 conflict 态
}
export interface StudyNoteFlushReceipt { version: number; editSeq: number; lastSavedAt: string | null; }

export interface StudyNoteSaveController {
  edit(snapshot: StudyNoteEditSnapshot): void;   // 每次输入变更，覆盖待发送快照
  setComposing(value: boolean): void;
  flush(): Promise<StudyNoteFlushReceipt>;        // 失败 reject
  retry(): Promise<void>;
  adoptServerSnapshot(dto: StudyNoteDto): void;   // 冲突恢复唯一入口（显式载入）
  getSnapshot(): StudyNoteSaveSnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
  isDisposed(): boolean;
}
```

### 2.10 测试与验收（实施阶段执行；本轮只写要求）

- **组件竞态测试（必须，deferred 屏障，不做“只数调用次数”的假竞态）**：
  1. 在途 A 未回、编辑 B → A 回包后 UI 不得回退为 A 文本、B 不得被标记已保存；
  2. flush 等待到「调用时刻序号」才 resolve；
  3. 重试沿用同 payload/requestId/版本（断言请求体相等）；
  4. 重试 409 → 停止自动写 + conflict 帧；
  5. dispose 后旧回包不触发通知/不写状态；StrictMode 双挂载重建后行为一致；
  6. 载入服务器版本期间的新输入不被吞（恢复作废）；
  7. marker 集合不一致 → 阻止提交 + 提示（不发送 PUT）；
  8. 已有笔记打开→改标题→保存：references 全 `keep`、摘录与 capturedAt 不变（mock 断言载荷；真库断言由实施阶段集成/E2E 覆盖）。
- **真实浏览器 + 隔离 PG（实施阶段，Task 11 前小闭环）**：自由创建 → 编辑 → 保存 → 重开一致；双标签 409 → 复制本地 → 载入服务器版本；断网重试；离页确认。使用既有 authed fixture 与隔离库（沿用 N1 验收库纪律，不接个人库）。

---

## 3. Task 08 · 笔记空间、专题、分页与导航

### 3.1 入口与创建纪律（**只有显式创建才创建**）

- 入口：`L3PapersPage` 每个题型内「题目素材 / 学习笔记」页签；七题型（`L3_QUESTION_TYPES`）均可进入，无文件题型同样可写。
- **创建纪律（硬性）**：
  - 唯一创建路径 = 用户**显式**「新建笔记」操作 → `POST`（`requestId` 生成、失败重试同 requestId）；
  - **GET / F5 / 浏览器历史 / 深链恢复 / 列表翻页 / 任何自动流程不得创建**（不得出现「进入页面即多一篇空笔记」）；
  - 创建成功 → URL `replace` 到该 note（避免历史堆叠重复创建路径）。
- 创建入口文案与空态：中文、非技术化（不暴露 UUID/targetType 术语）。

### 3.2 深链协议（与既有导航互斥处理）

```text
/l3?section=study-notes&venue=<questionType>
/l3?section=study-notes&venue=<questionType>&topicId=<uuid>
/l3?section=study-notes&venue=<questionType>&noteId=<uuid>&refId=<uuid>
```

- `section=study-notes` **优先**于旧 venue/file 深链；同一 query 只触发一个导航 effect（不得两个 effect 抢导航）。
- 与写作 `section=writing`、F-1 `?sheet=`/`?paper=` 参数**兼容共存**（study-notes 场景下不消费 sheet/paper；不互相覆盖）。
- 合法性：`noteId` 必须归属当前 owner 且 `venue ∈ note.venues`——不合法组合显示**无效入口空态**（提示返回），**不创建、不静默纠偏**；`refId` 不存在显示「该引用已移除」但**保留打开笔记**。
- `parseStudyNoteNavigation(URLSearchParams)` 返回已验证对象或结构化错误；`buildStudyNoteUrl(input)` 唯一构造入口（测试双向一致）。

### 3.3 列表 / 搜索 / 分页 / unfiled / 归档

- 20 条/页（≤50）；`nextCursor` 驱动加载更多；**跨页按 id 去重**；`total` 展示（过滤条件总数口径）。
- 搜索：防抖 300ms；**请求序号守卫**（旧响应丢弃，防覆盖新结果）；`q ≤ 100`。
- 任何筛选变化（`venue/topicId/unfiled/status/pinned/q`）→ **清空 cursor 重新起翻**；`topicId` 与 `unfiled` 互斥（UI 禁止同选）。
- `unfiled`：当前 venue 下未加入 **active** 专题的笔记（归档专题不得让笔记从「未整理」视图永久消失——以后端 `unfiled` 参数语义为准，前端不自行实现）。
- 归档：独立过滤视图；归档/恢复经保存通道（`status` 字段随 `PUT`）。

### 3.4 专题：元数据与成员的**串行协调**（同一 topic 版本通道）

- 同一专题的**元数据更新**（改名/归档/恢复）与**成员操作**（加入/移动/移出）共享同一 topic 版本：**同一时刻至多一个 topic 写操作在途**；每个响应更新本地 `topic.version`；409 → 与笔记相同的冲突纪律（停止自动重试、显式刷新）。
- 成员操作统一走 `PUT /members/:noteId`（含「加入」与「移动」）与 `DELETE`；`requestId` 每次新操作生成。
- **排序合同**：`beforeNoteId` 必须为同专题另一成员（否则 422）；**跨页选择位置时**：先加载/选择「目标前一个成员」（必要时加载更多直至可见），**不得用当前页局部列表推断全量顺序、不得本地重排覆盖服务端顺序**。
- 成员上限 500（超限 422 展示）；移出成员**不删除笔记**；归档专题不可改成员（先恢复）。
- UI：上移/下移按钮 + 键盘可达；失败保持原位 + 刷新当前页。

### 3.5 导航与未保存编辑（不丢字）

- **切 topic / 切 venue / 打开另一篇 note / 返回列表**：先处理当前笔记未保存内容（§2.7 导航辅助：flush → 成功才导航；失败**保持原位**）。
- 浏览器前进/后退：与 URL 同步；返回到同一 note 不重复创建、不丢失已保存内容。
- 深链进入的 note 在列表加载完成后**高亮/定位**（不强制滚动动画）。

### 3.6 引用搜索协议（Task 09 前置；本批不实现 UI）

- 合同已冻结（§0.3）：换 `kind` / `q` / 有效 `venue` → **清 cursor**；`limit` 可变；复用旧游标 400。
- Task 09 实施引用侧栏时直接消费；本批只做「协议已知」记录，不预建组件。

### 3.7 文件清单（Task 08）

- 新增：`src/frontend/pages/L3StudyNotesPage.tsx`、`src/frontend/components/studyNotes/StudyNoteList.tsx`、`StudyTopicPanel.tsx`、`src/frontend/viewModels/studyNoteNavigation.ts`
- 修改：`L3Page.tsx`、`L3PapersPage.tsx`、`l3ShellViewModel.ts`（`L3ShellSection` 增加 `studyNotes`）、`docs/design/l3-space/baseline.md`（N1 锚点登记）
- 测试：`tests/frontend/study-notes-page.test.tsx`、`tests/frontend/study-note-navigation.test.ts`

### 3.8 测试与验收（实施阶段）

- 组件：七题型入口与空态；显式创建唯一路径（F5/返回不创建——断言无 POST）；分页去重；搜索竞态（旧响应丢弃）；筛选清 cursor（断言请求无 cursor）；专题移动调用 `beforeNoteId` 合同；未保存导航保护（flush 失败不导航）；归档切换。
- 真实浏览器 + 隔离 PG（实施阶段）：自由创建 → 编辑 → 保存 → **重开**（F5）一致；深链恢复；**409 恢复流程**（双标签）；返回/前进不重复创建；专题移动后重开顺序一致。

---

## 4. 输入/交错 → 预期状态/请求/数据库结果（验收矩阵）

### 4.1 保存控制器（Task 07）

| # | 输入/交错 | 预期状态 | 预期请求序列 | 预期数据库结果 |
|---|---|---|---|---|
| S1 | 编辑 T1（800ms 内无后续） | dirty→saving→idle | 1×PUT(T1, R1, V1) | version=V1+1、正文=T1 |
| S2 | T1 在途时编辑 T2（未回包） | T2 排队；A 回包后 B sending | PUT(T1,R1,V1) → PUT(T2,R2,V2) | 最终 version=V2+1、正文=T2；**T2 回包前不得显示已保存** |
| S3 | T1 保存网络超时；期间无新编辑 | retrying（1/2/4s） | PUT(T1,R1,V1) 重试 ×≤3（**载荷逐字节相同**） | 一次成功即 version=V1+1；全失败=error（输入保留） |
| S4 | T1 重试期间编辑 T2 | 重试不发 T2 | 重试仍为 (T1,R1,V1)；**T1 确认后发送 T2 必须新 requestId R2、新确认版本 V2**（**2026-09-20 纠偏：删除「或 R1 复用」例外**——只有完全相同的未确认请求重试才复用其 requestId） | T2 最终落库 |
| S5 | 保存遇 409 | conflict（停自动写） | 无后续 PUT | 服务器版本不变；local 输入保留 |
| S6 | conflict 下点「复制本地内容」 | conflict（不变） | 无请求 | 无变化 |
| S7 | conflict 下点「载入服务器版本」 | 恢复请求 GET | 1×GET /:noteId（恢复期间锁编辑） | 无写；本地基线=服务器快照 |
| S8 | S7 恢复 GET 期间产生新输入 | 恢复结果**不覆盖**新输入 | （按实现：作废重取或提示） | 无写 |
| S9 | flush() 调用（T2 在途） | pending | 等待 T2 确认 | flush resolve 回执 version=V3、editSeq=2、lastSavedAt=真实时间 |
| S10 | flush() 等待中保存失败 | reject | — | **不得断言「无写」**（请求可能已提交但响应丢失；**2026-09-20 纠偏**）；断言=不误报确认（不 resolve、不推进 savedSeq）、宿主不导航；实际落库结果以库核为准 |
| S11 | dispose / 换 note / StrictMode 重建后旧回包到达 | 旧代际丢弃 | 无新请求 | **不得断言「无写」**（旧请求可能已提交但响应丢失；**2026-09-20 纠偏**）；断言=旧回包不污染新控制器、不误报确认；实际落库结果以库核为准 |
| S12 | 打开已有笔记（references 3 条，含 1 unavailable）→ 仅改标题 → 保存 | idle→saving→idle | PUT(references=[keep×3]) | **refs 3 条 id/摘录/capturedAt 不变**（unavailable 保留） |
| S13 | 用户手删正文 marker → 触发保存 | 阻止提交 + 提示 | **无 PUT**（本地预检拦截） | 无写 |
| S14 | 打开笔记 GET 返回 vs 期间本地编辑（限可发生路径） | 不覆盖 dirty | — | 无写 |

### 4.2 任务 08（空间/导航/专题）

| # | 输入/交错 | 预期状态 | 预期请求序列 | 预期数据库结果 |
|---|---|---|---|---|
| N1 | 进入 `?section=study-notes&venue=R`（无 noteId） | 空态+入口 | 仅 list GET | **无新 note** |
| N2 | F5 / 浏览器返回 | 同上（恢复视图） | 仅 read GET（list/get） | **无新 note** |
| N3 | 显式「新建笔记」 | 编辑器打开 | 1×POST{requestId,venue} →（FAIL 重试同 requestId） | 1 篇新 note（version=1）；重试不建第二篇 |
| N4 | 搜索框输入 → 停止 300ms | 结果更新 | list(q=..., cursor 无) | 无写 |
| N5 | N4 中再次输入（旧请求未回） | 旧响应丢弃 | 新 list（序号守卫） | 无写 |
| N6 | 切 venue / topicId / unfiled | 列表重置 | list（**无 cursor**） | 无写 |
| N7 | 加载第 2 页 | 追加去重 | list(cursor=C1) | 无写 |
| N8 | 专题内上移成员（跨页） | 需要目标前成员可见 | PUT members{requestId,expectedVersion,beforeNoteId} | 该专题 position 重排；**其他顺序不变** |
| N9 | 编辑中切 topic | 不丢字 | 先 flush（成功才切） | 保存落库后才切换视图 |
| N10 | 编辑中触发导航且 flush 失败 | 保持原位（**不继续导航**） | — | **不得断言「无写」**（**2026-09-20 纠偏**）；断言=视图不动、不误报成功；实际落库结果以库核为准 |
| N11 | 归档笔记 → 恢复 | 状态切换 | PUT（status=archived/active；完整快照） | status 字段变更、version+1 |
| N12 | 移除最后一个 venue | 阻止 / 服务端 422 展示 | PUT 被 422 | 无写；venues 保持 ≥1 |

### 4.3 引用搜索协议（Task 09 消费，本批仅登记）

| # | 输入 | 预期 | 请求 |
|---|---|---|---|
| R1 | kind: source→question | 清 cursor | GET reference-targets(kind=question, 无 cursor) |
| R2 | q 变化（含首尾空白规范化） | 清 cursor | 同上（q 规范） |
| R3 | venue 变化（有效值） | 清 cursor | 同上 |
| R4 | 仅 limit 变化 | cursor 可保留 | 同上（limit 新值） |
| R5 | 复用旧 cursor（异 kind） | 400 → 前端提示刷新 | — |

---

## 5. 实施顺序、验证与停止点

1. **顺序**：§1 client → §2 控制器/hook/editor → §3 页面/列表/专题/导航 → 组件测试 → 真实浏览器 + 隔离 PG 小闭环 → Task 09。
2. 每个任务独立提交（精确文件清单；沿用项目提交流程与门禁；HUSKY=0 隔离沿既有约定）。
3. **组件竞态测试 + 真实浏览器 + 隔离 PG** 是实施阶段验收的必要构成（自由创建→编辑→保存→重开 及 409 恢复两路径必须真浏览器验证）。
4. **停止点**：本轮（2026-09-20）**停在本文档交付**；不得开工任何前端代码、不得声明 N1 已交付。
5. 后置：Task 09（引用侧栏/原位引用）、Task 10（导出；`GET /:noteId/export` 得先由后端交付）、N2（注记/评析/历史/作文引用）。
