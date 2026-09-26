# N2 任务书（历史学习引用）· 2026-09-23

> 分支：`study-notes-n2-inventory` @ `04abb4f5`。
> 前置：`study-notes-n2-inventory-2026-09-23.md`（只读盘点与四项冻结要求）。
> **本批次只做盘点和任务书**；第 4 节门禁未通过前不写实现代码。
> 上游：`study-notes-execution-plan-2026-09-18.md:358-362`、`study-notes-design-2026-09-18.md:23`。

---

## 1. 启动条件核对（本轮已做的部分）

| 条件 | 状态 |
|---|---|
| N1 全批完成并入 main | ✅ Task 11（PR #133）已合并，main = `04abb4f5`，主线 CI 双绿 |
| F-1 按 sheetId 只读回看稳定 | 已有 `/l3?sheet=<id>`、`?paper=<id>`、`replaySheetId`（design `:9`）——**待本批实测复核** |
| 作文稿次接口已合并并验收 | ✅ 稿次本体裁决为 `l3_submissions`（见 §5.1 D1）；`revision_no` / `draft_version` / sealed 语义均在库 |
| 历史引用的内容清理与改判语义 | ✅ 已裁决（见 §5.1 D3） |

**结论**：启动条件**已满足**，进入第一条垂直链（§2 第 1 项）。未决的 D1-a / D3-a（§5.1 尾部）只影响
第 4/5 类目标（grading、作文），不阻塞第 1 条链开工。

## 2. 接入顺序（沿用 execution-plan `:362`，不打乱）

1. 注记 / 评析摘录
2. 笔记互链
3. 精确 sheet + attempt
4. 对应 grading ✅（2026-09-26，PR #142 / 迁移 0047）
5. writingTask + writingSheet + feedback ✅ **已解锁（2026-09-26，ADR-0040 签字 D1-a：只允许 sealed）** —— 新增 kind 只有 `writing_task` / `writing_feedback`，writingSheet 复用 `sheet`

每一类落地前都要先补齐它的五件套（§3），顺序不可跳跃——后面的目标依赖前面的
「引用型扩展 + 导出版本」决策是否已被验证。

## 3. 每种目标的五件套（必备，缺一不验收）

1. **归属**：owner-only + RLS `*_own_all` + 跨表属主一致性 FK（冻结项 B1）
2. **内容清理**：目标被删时的 blocker 登记，先例 `getSourceDeleteBlockers` / `getQuestionDeleteBlockers`（A3）
3. **引用时快照**：`display_snapshot` 白名单 + `captured_at`，不回套活体文本（C1）
4. **变更提示**：`field_hash` 输入字段集合写死（A2）；`changed` 只提示不改写，`unavailable` 保留占位块
5. **只读导航测试**：从引用跳回目标只读视图（复用 F-1 协议，不自造参数）

## 4. 冻结门禁（写实现前必须逐条签字）

- [x] 数据模型：`REFERENCE_KINDS` / `ReferenceTarget` 扩展方式已定（A1），无 unknown JSON 后门
      —— 沿用列式 target + CHECK 收口；新目标加列、扩 CHECK，不引入自由 JSON
- [x] 权限：新目标沿用 owner-only + `*_own_all` RLS + 跨表属主复合 FK + agent 403 不变（B1/B2/B3）
- [x] 引用版本：每类目标的 `field_hash` 字段集合在实现期写死（A2）；改判语义已定（C3 = D3）
- [x] 导出兼容：**显式升 `exportSchemaVersion = 2`**，v1 冻结（D2 = P4）
- [~] 待定项 D1–D4：D1 / D3 已裁决；**D2（笔记互链载体）、D4（attempt 只读回看验收）仍未裁决**
- [x] 遗留观察 F-1（`bodyMd` 命名）：随 P4-3 在 v2 中更名为 `renderedBodyMarkdown`（v1 不动）

> **本门禁对第 1 条链（注记 / 评析摘录）已逐条签字**；第 2–5 条链开工前须重新签字。

## 5. 决策表（本批待拍板，未拍板不写实现）

| # | 决策 | 裁决 | 影响面 |
|---|---|---|---|
| P1 | 作文稿次本体 | ✅ **`l3_submissions`**（= D1） | 目标形状、导出 target、blocker |
| P2 | 笔记互链载体 | ⏳ 未裁决（第 2 条链前必须定） | 后者动 N1 冻结枚举 |
| P3 | 改判语义 | ✅ **当前可更新 + 引用快照不可变**（= D3） | 引用版本、来源清单排序 |
| P4 | 导出版本策略 | ✅ **显式升 `exportSchemaVersion = 2`** | 离线档案兼容、`X-Export-Schema-Version` |
| P5 | 内容清理边界 | ⏳ 未裁决（第 1 条链沿用既有 blocker 先例） | 删除链路、ADR `:28/:40` |

### 5.1 本轮裁决（D1 / D3 / P4）

#### D1 — 作文稿次本体继续使用 `l3_submissions`

写作服务、仓储、RLS、并发保存（`draft_version` CAS）与 `revision_no` 都已以 `l3_submissions` 为事实
来源；该表另有 `l3_submissions_id_user_id_unique(id, user_id)`，正好支撑「跨表属主一致性复合外键」
（与 `note_owner_fk` / `source_owner_fk` 同款写法）。新建平行稿件表会立刻产生第二个真源。

- **D1-1** 「作文稿次」的稳定身份 = `{ submissionId, revisionNo }`；writing 场景 `revisionNo` **必填非空**。
- **D1-2** 非 writing 题纸（file / paper）sealed 后不可变，`{ submissionId }` 即为稳定身份，不带 `revisionNo`。
- **D1-3** `draft_version` **不作为引用身份的一部分**——它是 CAS 并发版本，语义是「每保存一次自增」，
  把它当版本号会把乐观锁误读成版本。
- **D1-4** 不新增 `l3_writing_sheets` 一类平行表。**仅当现有字段无法表达某个明确需求时才新增迁移**，
  且必须先在任务书登记「无法表达的具体字段」。
- **D1-5** 目标身份不得退化为「只引用题目 ID」——同一题目下有多稿次，那是歧义引用。

**D1-a（未裁决 · 保持待定）**：只引用 sealed 稿，还是 draft 也可引用（被引用的 draft 之后定格会让引用转 `changed`）？

- 2026-09-23 状态：**未裁决**。倾向只允许 sealed（draft 未定格，引用等于把不稳定来源写进长期笔记），
  但这是产品行为取舍，**需你点头**。
- **未裁决前的硬约束**：第 5 条链（作文稿次）不得开工；草稿态的引用语义**一律不实现**——
  不得先按「draft 可引用」写实现、等日后收紧（收紧等于改已落库引用的语义）。
- 只阻塞第 5 条链（作文），不阻塞第 1 条。

#### D3 — 当前评卷可更新，笔记引用快照不可变

- **D3-1** `l3_grading_results`（`UNIQUE(sheet_id, question_id)`，latest-wins 覆写 + `graded_at` 刷新）
  与 `l3_question_assessments`（`UNIQUE(user_id, question_id)`，覆写 `content_md` / `updated_at`）
  **沿用现有合同更新当前结果**，不为引用引入写路径版本化。
- **D3-2** 已写入笔记的引用**不可变**：保留当时的 `displaySnapshot`、`capturedAt`、`fieldHash`；
  当前目标变化后引用状态转 `changed`，**不覆盖旧摘录**。
- **D3-3** 引用写路径上**不得**存在「按目标当前值回写快照」的分支（最易腐化点，由测试锚定）。
- **D3-4** 引用某个**明确的历史稿次或评卷版本**时，目标身份必须包含稳定 revision / version。

**D3-a（暂定姿态 · 待签字）**：`l3_grading_results` 现模型**没有历史版本**（同键覆写、无 version 列），
所以「引用某个历史评卷版本」在现有表结构下**不可表达**。

- 2026-09-23 **暂定裁决**：走 ① —— N2 **只支持「引用当前评卷」**，历史评卷版本引用**显式不做**。
  不新增 `grading_version` 列或历史表；**不为不可表达的需求虚构版本语义**（无版本列时伪造
  version 字段等于编造数据）。
- 由此对 D3-4 的收窄：**评卷类目标只承诺「当前评卷」身份**；「引用某次具体评卷」属未支持需求，
  若日后需要，须先补版本列并购入新迁移，再开第 4 条链。
- 状态：~~**暂定（未签字）**~~ → **已签字（2026-09-26）**，见 **ADR-0039**：① 获准，
  D3-4 据此收窄为「评卷类目标只承诺当前评卷身份」；第 4 条链（grading）**解锁**。
  ADR-0039 另补了本条未覆盖的细节：`field_hash` 输入 = `verdict + analysis_md`
  （`graded_by` / `graded_at` 不进 hash、只存快照）。②（版本列 + 改判改追加）经核算**否决**，
  理由（`UNIQUE` 是数据库级「只取最新」保证，追加后四个读点要各自补谓词，其中错题库会
  **静默**留下 wrong 幽灵条目）记在 ADR-0039 Tradeoffs ①，避免日后重推。
  本条只阻塞第 4 条链（grading），不阻塞第 1 条 —— 后者已由本签字解除。

#### P4 — N2 导出升为 `exportSchemaVersion = 2`

不把新 kind 与 target 形状塞进 v1——那会把「同一字段两种语义」的兼容债留给所有离线档案。

- **P4-1** v1 **永久**保持 N1 现有字段与语义：只收 bug，不再增字段。
- **P4-2** v2 为**显式**协议：由**显式版本参数或明确的 v2 导出入口**选择，**不按笔记内容自动切换**。
  同一请求不得因笔记内容不同而返回不同 schema。
- **P4-3** v2 将 `bodyMd` 更名为 **`renderedBodyMarkdown`**，明确它是 marker 替换后的正文
  （顺带闭合遗留观察 F-1）。
- **P4-4** `references[].kind` 与 `target` 使用**带判别字段的扩展联合类型**。
- **P4-5** v1 / v2 **分别**测试：双段 hash、引用快照、无标准答案字段、旧客户端兼容性；
  `X-Export-Schema-Version` 随所选版本输出。

## 6. 验收矩阵（三条裁决的可验证条目）

写实现者按下表逐条打勾，**任一格未过则该条裁决不算落地**。

| 裁决 | # | 验收条目 | 验证方式 |
|---|---|---|---|
| D1 | V-1 | 稿次引用 target 形为 `{ submissionId, revisionNo }`，writing 目标 `revisionNo` 非空 | 域层类型 + DB check 双锚 |
| D1 | V-2 | 未新增 `l3_writing_sheets` 一类平行表 | 迁移 diff 复核 + `db:schema:drift` |
| D1 | V-3 | 稿次引用 FK 为 `(submission_id, user_id)` 复合属主外键，删除行为与既有球体 FK 一致 | 迁移 SQL 复核 |
| D1 | V-4 | 目标身份不含 `draft_version`，不存在「只引用 questionId」的歧义形态 | 类型 + 用例 |
| D3 | V-5 | 目标更新后引用的 `displaySnapshot` / `capturedAt` / `fieldHash` **逐字节不变** | 变更前后快照比对用例 |
| D3 | V-6 | 目标更新后引用状态转 `changed`，正文摘录块未被回写 | 服务层 + http 用例 |
| D3 | V-7 | 引用写路径无任何「按当前目标重算快照」的分支 | 代码复核 + 变异测试 |
| D3 | V-8 | 评析 / 评卷仍按现有合同更新当前结果（行为未被 N2 改变） | 既有单测不回归 |
| P4 | V-9 | v1 导出字段与语义与 N1 完全一致，既有 v1 用例全绿且不新增字段 | 冻结用例 + 契约 diff |
| P4 | V-10 | 同一笔记显式请求 v1 → v1、请求 v2 → v2；**不存在**由内容决定的隐式切换 | 参数化用例（正反两组） |
| P4 | V-11 | v2 payload 使用 `renderedBodyMarkdown`，且**不再**出现 `bodyMd` | payload key 断言 |
| P4 | V-12 | v2 `references[].kind` / `target` 为带判别字段的联合类型 | 类型 + 运行时解析用例 |
| P4 | V-13 | v1 / v2 双段 hash 与 `X-Export-Sha256` / `X-Export-Schema-Version` 分别正确 | http 用例 |
| P4 | V-14 | v2 快照同样不含标准答案 / 解析 / evidence 面 | 白名单断言 |
| P4 | V-15 | 旧客户端按 v1 解析不受 v2 影响（**升级不改 v1 通道**） | v1 契约回归 |

## 7. 不在本批

- N3 产品扩展（agent 整理/合并、专题导读、从引用题集发起复练）——另立提案与权限。
- 分页、注记（前端面）、自动整理——沿用既有后置清单。
- P2 / P5 未裁决前不动第 2–5 条链的任何 `src/` 与迁移。
- D1-a / D3-a 未**签字**前，不写 grading 与作文目标（第 4/5 条链）；第 1 条链已交付且不受两者阻塞。
  - D3-a 已有**暂定**姿态（只引用当前评卷，历史版本显式不做），但暂定≠签字，第 4 条链仍不开。

## 8. 本批交付物与自检

- [x] `study-notes-n2-inventory-2026-09-23.md`（只读盘点 + 四项冻结）
- [x] 本任务书（含 §5.1 裁决、§6 验收矩阵）
- [x] `study-notes-followups-2026-09-23.md`（遗留观察登记）
- [x] D1 / D3 / P4 已裁决（用户，2026-09-23）
- [ ] D1-a 裁决（**未裁决**；未裁决前第 5 条链不实现草稿态引用语义）
- [ ] D3-a **签字**（暂定：只引用当前评卷；暂定态不足以开第 4 条链）
- [ ] 第 1 条垂直链走完 §6 的 V-1…V-15 中适用项
- [ ] 不 push、不建 PR、不合并、不部署——待用户授权

## 9. 第一条链实现纪要（2026-09-23）

分支 `study-notes-n2-chain01`（draft PR #134，取 CI 证据用，未合并）。

- **迁移拆两段**（0040 / 0041）：单文件 `0040` 在真实 PostgreSQL 上红——drizzle 把复合外键
  排在它所依赖的 UNIQUE 之前，同批执行撞 `no unique constraint matching given keys`，
  Writing E2E 因此失败。0040 只加 `l3_question_assessments(id,user_id)` 唯一键，
  0041 再加 `assessment_id`、复合 RESTRICT 外键与三个 CHECK。
  真实库复制（`vocab_n2_chain01_verify`）应用 40+41 **7/7 约束验收 PASS**；
  权威迁移计数 41 → 42。
- **前端两处 switch 补 assessment 穷尽分支**：`StudyReferencePicker.targetIdentityKey`
  与两处 `previewSummary/referenceSummary`，否则 `tsc -p tsconfig.frontend.json` 红
  （Browser E2E）。identity 键取 `assessment:<assessmentId>`，不按题兜底合并。
- **diff coverage 69.2% → 97.56%**（受治理层 domain/service/repository/http）：
  补仓储层评析 4 例、服务装配层 3 例、导出 v2 投影 2 例（v2 对 N1 五种引用型同样带
  `kind` 判别；`schemaVersion=3` 走 422）。
  剩余 7 行未覆盖 = v1 投影里评析分支的 **fail-closed throw**，
  `assertV1Kinds` 先拒，该分支按设计不可达，属纵深防御。
- **仍未裁决**：D1-a（草稿稿次可引用性）、D3-a **签字**（暂定只引用当前评卷）。
  两者签字前不开第 4/5 条链；本链结论不因两者改变。
- **openapi-breaking 门禁裁决（用户 2026-09-23，选项 A）**：N2 给 `target` / `displaySnapshot`
  的 `oneOf` 联合纯新增 `assessment` 变体（base 5 → 6，`removed: []` 已核验），原比较器把
  「组合键自身变化」一律判 UNKNOWN，而 `applyBreakingApproval` 明令 UNKNOWN 不可豁免 → EG 硬红。
  扩展 `scripts/verify-openapi-breaking.ts`（**只放宽判定精度，不放宽语义**）：
  - 纯新增变体：request = 放宽（非 breaking）；response = **breaking**（旧客户端可能不认，可豁免）；
  - 变体数相同：逐位递归（覆盖「变体内嵌联合纯新增」——PUT 请求体 capture 变体内 target 多出评析变体）；
  - 变体数变少 / 同时动其它组合条件键（not/if/…）/ 非联合键 → **仍 fail-closed UNKNOWN**。
  补 5 条工具用例（含反向：删变体、变体数变少、条件键并存均仍 UNKNOWN）。
  按三元组**重锚** `docs/api/openapi-breaking-approval.json`：`baseSha256`=openapi@04abb4f5、
  `currentSha256`=openapi@HEAD、`issues`=实测 8 条 response 联合新增（无 UNKNOWN 残留）。
  影响面：本批 8 条均为**响应面新增变体**，v1 客户端按既有 5 型解析不受影响（v1 通道不产出评析引用）。

## 10. PR #134 审查与 P1 修复纪要（2026-09-23，审查后整改）

**审查**（只读，报告在仓库外 `D:/tmp/n2-review-134/REVIEW-PR134-2026-09-23.md`）：
head `be97f11` 无漂移、CI 三项全绿、迁移真库 13/13 + 顺序 A/B、comparator 四组变异全红、
 approval 三元组独立核对一致 —— 但 **Verdict = BLOCKED: P0/P1 found**（P1 两条）。用户裁决：
**两条 P1 均并入本链修复**，不合并到 main，修完重跑单测与三项 CI 再定。

### P1-1：`resolve()` 装载键与取值键不同源（评析引用恒 `unavailable`）

- 缺陷：`src/services/l3-study-reference.service.ts` 的 `resolve()` 仍按「非 source 即 question」
  拼装载入参，而取值用 `targetKeyOf(referenceRowToTarget(row))`（评析 → `assessment:<id>`）。
  仓储按传入 kind 分组（`loadTargets:307-313`）→ 忠实装载下必然取不到 →
  笔记详情/反向引用（`l3-study-notes.service.ts:851`）与导出（`l3-study-note-export.service.ts:667`）
  把评析引用状态标成 `unavailable`，导出正文还会渲染「目标已不可用」占位。
- 修复：装载入参改为 `rows.flatMap((row) => targetRefsOf(referenceRowToTarget(row)))`——
  与 `capture()/preview()/lockTargets` 同口径（评析同时装载所属题与评析自身）。
- **根因防线**：`tests/services/l3-study-reference.test.ts` 的替身原先**无条件**按
  `<kind>:<id>` 建键，掩盖了「装载请求本身就没带正确 kind」。改为**忠实装载**（只返回被请求的
  target），并新增防复发用例：断言装载请求**含** `{ kind: "assessment", id }`、且状态为 `current`。
  纪律：装载替身必须忠实，不得无条件造键。

### P1-2：前端未随 P4 显式选版（含评析引用的笔记 UI 导出 422）

- 缺陷：`studyNotesClient.exportNote` 只发 `expectedVersion`，服务端缺省按 v1 冻结面，
  `assertV1Kinds` 对评析引用 422 → 该笔记从界面**完全导不出**。
- 修复（**不改服务端合同**：版本仍由调用方显式选择，服务端不替调用方升级，也不做 v2→v1 静默降级）：
  - `studyNotesClient.exportNote(noteId, expectedVersion, { schemaVersion?, signal? })`：
    第三参改为 options（原 signal 无调用者），`schemaVersion` 缺省**不发送**该 query；
  - `flushThenExportNote` input 增 `schemaVersion?`，**原样透传**（不猜、不兜底）；
  - `useStudyNoteEditor.exportNote` 用新增的 `exportSchemaVersionForReferences()` 判定：
    出现任何 N1 五种之外（白名单取反）的引用型 → `2`，否则 `1`（读 `referencesMetaRef`，
    不用快照态，避免 `useCallback([])` 里的 stale）。
- 新增用例：分流器透传 3 例（含「v2 失败不退回 v1，只请求一次」）、客户端 query 2 例、
  版本判定 3 例（纯 N1 → 1 / 含评析 → 2 / 空集合 → 1）。

### 未受影响

迁移（0040/0041）、`docs/api/openapi.json`、breaking approval 三元组均未改动，无需重锚。
受治理层仅 `src/services/l3-study-reference.service.ts` 一处逻辑变更（diff coverage 由 CI 复核）。
