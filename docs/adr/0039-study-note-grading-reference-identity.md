# ADR-0039: 评卷引用的身份边界（签字 D3-a —— 只引用当前评卷，不加版本列）

- **Status**: Accepted（**D3-a 签字**：2026-09-23 的「暂定 · 未签字」状态由本 ADR 转正）
- **Date**: 2026-09-26
- **Amends**: `docs/plan/study-notes-n2-execution-2026-09-23.md` §5.1 **D3-a**（**仅声明修订，不修改原文**）：暂定裁决 ① 获得签字；并**补上 D3-a 原文未覆盖的 field_hash 输入选择**（决策 3）
- **Narrows**: 同文档 **D3-4**（「引用某个明确的历史稿次或评卷版本时，目标身份必须包含稳定 revision / version」）—— 评卷类目标**只承诺「当前评卷」身份**，「引用某次具体评卷」为**不支持需求**
- **References**: ADR-0035 §1/§3（verdict 真源 = `l3_grading_results`，latest-wins 覆写、无历史版本；幂等 = 同键覆写）、ADR-0034 §2（attempt 是不可变作答事实）、ADR-0037 决策 7（评卷面维持 agent 可写，理由是「可改判的消耗品」）、ADR-0025（单一代码路径）、`docs/adr/study-notes-workspace.md`（笔记工作台 N1 边界）、`docs/plan/study-notes-n2-chain03-execution-2026-09-24.md` §3.2（K6/K7/K8）
- **不涉及**: 同文档 **D1-a**（是否只允许引用 sealed 稿）**仍为未裁决**，只阻塞第 5 条链（作文稿次），本 ADR 不动它

## Context

### 一、N2 引用链的现状（逐条回码核验，2026-09-26）

- `l3_study_note_references`（`src/db/schema.ts:1719`）存 `kind` + 目标 FK + `quote_snapshot` / `display_snapshot` / `field_hash` / `captured_at`。
- **表里没有 `status` 列** ⇒ 引用状态（`current` / `changed` / `unavailable`）是**读时派生**的：重算目标当前文本的哈希，与行内 `field_hash` 比，不同即 `changed`。因此「快照不可变、漂移只告警」是**结构性**的，不靠写路径自律。
- `kind` 枚举 9 值（`schema.ts:1795`）：`source` / `source_quote` / `question` / `stem_quote` / `option_quote` / `assessment` / `note` / `sheet` / `attempt` —— **没有 `grading`**。已落地链：chain01/02（前 7 类）、chain03（`sheet` / `attempt`）。**第 4 条链（grading）待建。**

### 二、为什么 grading 是唯一「身份表达不出来」的目标

| 目标 | 身份 | 会被改吗 | 引用漂移 |
|---|---|---|---|
| `l3_submissions`（sheet） | `{submissionId, revisionNo}`（`submission_revision_no` 落库） | 题单开纸即定格（0046 快照） | 结构上不可漂移 |
| `l3_question_attempts` | `{attemptId}` 单值（K9） | **不可变** | **不可达** —— K12 明写「这是承认的事实而非缺陷」 |
| `l3_grading_results` | `UNIQUE(sheet_id, question_id)`（`schema.ts:1563`） | **可改判**（ADR-0035 决策 3） | **必然可达** |
| `l3_question_assessments` | `UNIQUE(user_id, question_id)` | 可覆写 | 必然可达 |

`l3_grading_results` 的写路径是 `ON CONFLICT (sheet_id, question_id) DO UPDATE`（`l3-grading.repository.ts:55-63`）—— **同键覆写、不留痕、无 version 列**。所以 D3-4 要求的「指名某一次具体评卷」在这张表上**不可表达**。

### 三、关键先例：这套机制**已经上线**了，grading 会是第二个实例

`l3-study-reference.service.ts:168-172` 已为 `assessment`（与 grading **完全同款**的 latest-wins 覆写目标）实现了派生漂移：

```ts
if (target.kind === "assessment") {
  // N2：评析的 hash 输入写死为 content_md（A2）；评析是 latest-wins 覆写，
  // 覆写后当前文本变化 → 已存引用转 changed，旧 content 快照保持不动（D3-2）。
  return kind === "assessment" ? target.content_md : null;
}
```

⇒ 「latest-wins 目标 + 冻结快照 + 派生 changed」**不是待验证的假设，而是承重中的既有实现**。

## Decision

1. **D3-a 转正：只支持「引用当前评卷」；历史评卷版本引用显式不做。** 不新增 `grading_version` 列、不建历史表。理由照录 D3-a：**不为不可表达的需求虚构版本语义**（无版本列时伪造 version 字段等于编造数据）。
2. **身份**：`kind = "grading"`，目标 = `{sheetId, questionId}`，指向**当前那一行**。`sheetId` 必填且必须 `status = 'sealed'`（沿 K1：draft/discarded 一律 404，不是 409 —— draft 不是「冲突」，是不存在的合法目标）。
3. **`field_hash` 输入 = `verdict` + `analysis_md` 的规范化 JSON**（本条是 D3-a 原文**未覆盖**的细节，签字时必须定死）。
   - 照 `assessment` 的 `content_md` 先例：hash 只取**内容字段**。
   - **不能只取 `analysis_md`**：verdict 与 analysis 可分别改判；只 hash 分析则「只改 verdict」不转 `changed` ⇒ 笔记里显示一个**已过期却无告警**的判定。
   - **`graded_by` / `graded_at` 不进 hash**：它们是「谁在何时判的」这一**归属事实**，不是内容；`graded_at` 每次改判都刷新，进 hash 会让纯措辞调整也告警。
4. **快照内容** = `{verdict, analysisMd, gradedBy, gradedAt, questionOrdinal}`。`gradedAt` 是**快照里的历史事实**：UI 只能据此显示「此评卷已被改判」，**不得**用它重算「最近评卷时间」（那属于 grading 读面，不属于引用）。
5. **`changed` 在本链是承重路径，不是理论分支**（与 attempt 相反）。引用卡片必须显示「此评卷已被改判」；把 `changed` 当不可达分支的实现会在第一次改判时静默失效。
6. **K7 的反向断言**：sheet / attempt 引用**不得**携带任何 `l3_grading_results` 字段（快照白名单显式排除）。第 4 条链**不得**搭便车塞进既有 kind。
7. **重开条件（K8 收紧）**：若日后真的要「**读**改判前的评卷」，须**新开 ADR**；届时**优先在读面放宽**（grading 读面加 `?includeHistory`，复用既有行），**不**改表结构去掉 latest-wins。理由见 Tradeoffs ②。
8. **②b（版本列 + 改判改追加）经核算否决**，理由入 Tradeoffs —— **目的是让后来者不必重新推导一遍**。
9. **迁移范围澄清**：D3-a 的「不加版本列」**不等于无迁移**。`kind` 枚举加 `'grading'` + `target_check` / `quote_check` 的对应分支**需要一次迁移**（CHECK 约束变更），且 `authoritativeMigrationCount()` 断言 47 → 48（`tests/scripts/verify-existing-volume-role-upgrade.test.ts:63`）。可与第 4 条链的其余变更合并进同一个 0047。
10. **测试必交矩阵**（缺一不得开放）：① 捕获后改判 ⇒ 引用转 `changed` 且 `display_snapshot` 逐字不变；② 只改 verdict（不改 analysis）⇒ **必须**转 `changed`（决策 3 的回归锁）；③ 重复捕获同一 (sheet, question) 幂等；④ draft / discarded 题纸 ⇒ 404；⑤ sheet / attempt 引用的快照里**不出现**任何 grading 字段（决策 6 的反向断言）；⑥ `graded_at` 变化**不**单独触发 `changed`（决策 3 的另一半）。

## Tradeoffs

① **签 ① vs 走 ②b（版本列 + 改判改追加）** —— ②b 的成本**不在迁移**，而在于：`UNIQUE(sheet_id, question_id)` 现在是「一个 (sheet, question) 只有一行」的**数据库级保证**（`schema.ts:1563`）。改成版本追加后该保证消失，**四个读点都要自己补「取最新版本」谓词**：

| 读点 | 不补的后果 |
|---|---|
| `l3-error-book.repository.ts:213-224` | **最严重**：外层 `WHERE` 与 LATERAL 子查询**都只筛 `verdict IN ('wrong','partial')`**。一道题从 wrong 改判为 correct 后旧 wrong 行仍在表里 ⇒ **永远留在错题库**；`latest_outcome` 只在 wrong/partial 行里取最新，会报「wrong」而实际最新是 correct。P1 刚交付的错题库枢纽会**静默**给出幽灵条目 |
| `l3-sheets.repository.ts:269` 档案 `graded_count` | `count(*)` 随改判次数膨胀 ⇒「已评 3/3」可能只对应 1 道题的判定；ADR-0038 的待评卷清单谓词同源 |
| `l3-grading.repository.ts:28-36` | `ORDER BY question_id, id` + 前端 `map[row.question_id] = row` 靠**迭代顺序最后一条胜出**。今天覆写不改 id 故稳定；追加后每版是随机新 uuid ⇒「最后一条 = 最新」从保证退化为巧合 |
| ADR-0038 的 `gradable_count` | 同 `graded_count` |

即：**用一条数据库级不变量换四处应用级过滤，其中错题库那处出错时不报错。**

② **「引用历史评卷」用 ① 能否覆盖** —— 大部分能：引用行冻结 `display_snapshot` + `field_hash`，改判后转 `changed`，用户既看到「我当时引用的判定」，也被告知「已被改判」。② 独有的只有「**主动去翻**第 2 版」，那是**检索**需求而非**引用**需求 —— 落在读面（`?includeHistory`）比落在表结构上便宜一个数量级。这正是决策 7 的依据。

③ **hash 取 `verdict + analysis_md` 的代价** —— 纯措辞调整也会转 `changed`。可接受：评卷是低频动作，且 `changed` 只提示不阻断（引用照常可读）。反过来「只 hash analysis」的代价是**过期判定无告警**，那是有害的。

④ **②a（加 version 计数但仍覆写）是安慰剂** —— 旧行仍被覆写，能说「第 3 版」但说不出第 2 版写了什么，D3-4 依然不可满足；而它唯一买到的东西（并发改判检测）`graded_at` 已经提供。**明确排除**，免得日后被当成折中方案重提。

⑤ **本链需要一次迁移**（决策 9）—— CHECK 约束变更不可避免；「无迁移」只适用于「不加版本列」那部分。

## Consequences

- **domain**：`l3-grading.ts` 增评卷 field text 纯函数（`verdict + analysis_md` 规范化）；`l3-study-reference.service.ts` 增 `grading` 的目标装载与标题投影。
- **repository**：`l3-study-reference.repository.ts` 增 grading 目标取件（按 `(sheet_id, question_id)` + `status='sealed'`）。
- **迁移 0047**：`l3_study_note_references` 的 `kind_check` / `target_check` / `quote_check` 三处加 `grading` 分支（`submission_id` + `question_id` 必填、其余目标列全空、无 offset/snapshot 列）；`schema.ts` 同步；`db:schema:drift` 预期仅此三处 CHECK；迁移计数 47 → 48。
- **授权**：引用创建/预览面已是 owner-only（`operations.ts:620-621`），本链**不新增面**、不改 minRole。
- **导出**：`references[].kind` 走 v2 扩展联合（P4-4），v1 仍只收 N1 的 kind 并对 `grading` fail-closed 422（同 `note` / `assessment` 现例）。
- **测试**：决策 10 的 6 条矩阵 + 仓储 SQL 谓词断言（service 测试把仓储换成 stub，谓词不会被验）。
- **与 ADR-0035 / 0037 无冲突**：本 ADR 不动评卷表结构与写路径，ADR-0035 决策 1/3 与 ADR-0037 决策 7 的「latest-wins / 可改判的消耗品」论证**原样成立**。
- **后续**：第 4 条链的实施按 `docs/plan/study-notes-n2-*-execution` 的既有纪律走（纯函数先落、边界测试锚定、导出 v1/v2 分别测）。
