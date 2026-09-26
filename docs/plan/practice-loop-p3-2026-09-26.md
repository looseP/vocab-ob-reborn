# 做题回路 P3 · 题库录入面设计与核验（2026-09-26）
- **分支**：`feat/question-authoring-p3`（worktree `wt-loop`，基线 `main@bc8553b`，即已合并的 PR #139）
- **范围**：P3-1 改题面/改卷（`PATCH`）；P3-2 建卷表单补官方解析与原文证据
- **依据**：P0+P1 卡「四、3 未做」列出的两项 —— 录入面此前 API 与 schema 都接受、**UI 从不收集**，于是应用内建的题永远"无解析可依"
- **不在范围**：P3-3 agent 录题通道（需 `trusted_agent` 三段 token 与安全 ADR，见文末五）

---

## 一、P3-1 改题面 / 改卷（后端，`97b441f`）

| 端点 | 改什么 | 语义 |
|---|---|---|
| `PATCH /api/l3/questions/:id` | 题面**全量替换** | 不是 PATCH-merge：留空即清空 |
| `PATCH /api/l3/papers/:id` | 标题 / 方向 / 元信息 / **题单引用** | 让"从卷里换掉一道题"成为可能（此前只能删卷重建） |

### 护栏（每条都有对应的失败测试）
- **有作答历史 → 409**：题级真源是 `l3_question_attempts`。改题面会让历史作答失去被问的题 —— 答案历史不可改写，请复制为新题。
- **被作文任务引用 → 409**：作文任务已把题面冻在自己的稿子里，改了就是两套文本。
- **被学习笔记引用 → 放行**：`field_hash → changed` 机制正是为此存在（笔记记的是"我读到这句话"，不是"这题长这样"）。
- **仅 `status='active'` 可改**：`pending`/`rejected`/`deleted` 一律 409，不给改。
- **并发复判**：条件 `UPDATE … WHERE status='active'` 落空 = 期间被别人删/驳回 → 复判一次，仍在则 409（带最新 status），已不在则 404。**两处 `find*ById` 必须给不同答案才测得到这条分支**（老写法一进来就 archived，走的是前门）。
- **owner-only**：`agent` 令牌 403。题面是受信面 —— agent 只能写 proposal（ADR-0029）。

### 证据（evidence）语义
- 形状由 HTTP schema 把关（`start`/`end`/`label`，`end > start`）；service 再做一次**同源**防御性归一（trim label、剔非整数/负 start/空区间/重复锚点），让两个调用点不必各自 cast。
- **越界当场 422**，错误信息带正文长度：offset 落在材料正文之外时读侧只会**静默丢弃**该锚点（`buildPassageSpans.validRange`），那等于用户白填一个证据。
- `content_text IS NULL`（材料没正文）时**跳过**越界检查：无从核对，不假装有界。
- 题无 `source_id` 时整体跳过（不查正文）。

### 落库与路由
- `input_hash` 沿用原值 —— PATCH 是修订，不是换身份。
- 改动落在 `status='active'` 的条件 `UPDATE … RETURNING`；`options`/`answer`/`evidence` 由仓储兜成 `[]`/`{}`（jsonb 收 `undefined` 会直接报错）。
- 新增仓储方法的 **SQL 文本与参数序**由仓储级单测锁定：service 测试把仓储换成了 stub、HTTP 测试走内存假件，参数序错位在那里不会报错，只会把 `stem` 写进 `answer` 列。
- PATCH 路由放独立 `papers-update.ts`；`papers.ts` 复杂度冻结 80 行 / 7 路由，**不抬基线**。

---

## 二、P3-2 建卷表单的解析与证据（前端）

- `DraftQuestion` 增 `explanation` / `evidence`，建卷 payload 传递两者；**空值不上报**（不制造"用户标过证据"的错觉，服务端归一为 `[]`）。
- 新增 `QuestionEvidenceEditor`：懒加载原文（复用既有 `GET /api/l3/practice-files/detail`，**零新增端点**）→ 在原文上框选 → 锚点**扩到最小句段**（`enclosingSentenceRange`）→ 落 `{start,end,label}`。
- 选区经 `Range` 的 `data-content-off` 基址 + 局部 offset 映射回 UTF-16 全局 offset；与读侧高亮同一套 `buildPassageSpans` 口径。
- **不让用户手填 offset** —— 手填必错且无从核对。
- `enclosingSentenceRange` 与读侧 `enclosingSentence` **同源**：测试逐条比对"区间切片 === 句子文本"，防止两套分段漂移（漂了就出现"高亮和句子对不上"）。
- 重复标注如实提示，不产生重复锚点；可逐条删除、可清空。
- 顺手修正 `L3QuestionAssessment` 的误导文案：agent 应走**带答案的** grading-context；Markdown 导出不包含答案。

### 一处测试侧教训（写进注释，不删）
造选区的 helper 里 `TreeWalker` 被**复用**：第一次 `nextNode()` 后 walker 已耗尽，第二次查询从**下一个**文本节点开始 —— 于是第二行选区的 `end` 落到了错误节点，报 `setEnd … not of type 'Node'`，而组件被误判为 bug。**每次 locate 新建 walker**。同理，测试夹具的偏移应从 `PASSAGE.indexOf(NL)` 算出，不要写死 `25`（句末标点在 24，25 是换行）。

---

## 三、显式偏差与未做
1. **P3-3 agent 录题通道未做**。开放直写需要 `trusted_agent` 的三段 token（谁能发、谁批准、谁能撤），这是安全 ADR 的题，不该在一张功能卡里顺手决定。**待裁决点已记录**，不静默开放也不假装不存在。
2. **PATCH 是全量替换，不是 merge**：留空即清空。理由：merge 语义要求服务端知道"哪些字段被省略"，而 UI 的省略多半是 bug（表单忘了填）——全量替换让 bug 显形。
3. **`sections` 引用校验只查 active 题的归属**，不查题是否被软删（`findActiveQuestionsByIds` 已含 `status='active'`）。已软删的题 id 会让整次 PATCH 422，而不是静默留在卷里。
4. **`explanation` 一律 trim，空串归 `null`**；沿用既有列，未改 schema，无迁移。

---

## 四、门禁复跑（本机）
| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 绿 |
| `npm run arch:check` | 绿（no dependency violations，447 modules / 1970 dependencies） |
| `npm run complexity:routes` | 绿（route complexity ratchet passed） |
| `npm run api:governance` | 绿 |
| `npm run db:schema:drift` | 绿 |
| `npm run frontend:build` | 绿 |
| `npm run test:unit` | 284 passed / 1 skipped（285 files） |
| ├ 分层覆盖 baseline ratchet | **PASS** |
| ├ 最终目标（lines ≥85% / branches ≥75%） | **PASS** |
| └ 差异覆盖（≥85%，`origin/main…HEAD`） | **100%（203/203 changed executable lines）** |

差异覆盖这一项从 64.04% 拉到 100%，补的全是**有意义的**分支，不是凑行数：
- 仓储三方法的参数序与 `?? []` 右臂（jsonb 收 `undefined` 会炸）；
- 两处并发复判分支（老测试走前门 409，根本没进 `if (!question)`）；
- 缺省可选列的落库值（options/answer/evidence 归零、explanation 归 null、ordinal 沿用原序）；
- 路由 body 解析失败兜底（截断 JSON → 400，不是 500）。

---

## 五、待裁决（下一张卡的输入）
1. **P3-3 的 `trusted_agent` 三段 token** —— 谁签发、谁批准、谁撤销；在 ADR 落定前，agent 只能提 proposal。
2. **evidence 与原文分析条目的边界** —— 官方证据（题面自带，随题走）与 `l3_question_annotations`（owner/agent 的题内注记）是两个实体、两套生命周期，**不要合并**。
3. **判卷触发**：P3 补齐了解析与证据，评卷信箱的输入才算完整；仍需裁决 grading 版本列与触发方式。
