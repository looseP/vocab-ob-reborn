# ADR-0028: 词–L3 引用完整性与删除语义（阻塞式删除 + RESTRICT 兜底，不建 orphan 池）

- **Status**: Accepted
- **Date**: 2026-09-12
- **References**: ADR-0004 §6（红线/哲学）、ADR-0005（L3 边界）、ADR-0020（遗忘=挂起）、ADR-0022（单 owner）、`src/services/word.service.ts:97-102`、`src/repositories/word.repository.ts:589-611`、`src/db/schema.ts:982,1011`
- **上游**: 2026-09-12 后端完备性拷问会话（第二轮 Q11 / 第三轮裁决）

## Context

"H3（L3 引用完整性）" 曾被记为待决的设计题：`P1-5` 的描述是"`l3_sources.word_id` 是 text 软引用，删词后悬挂引用靠应用层清"。**实测校正：`l3_sources` 没有任何 word 引用**。真实的词→L3 引用只有两处：

- `l3_occurrences.word_id`：uuid FK → `words.id`，`ON DELETE cascade`（`src/db/schema.ts:982`）
- `l3_context_links.word_id`：uuid FK → `words.id`，`ON DELETE cascade`（`src/db/schema.ts:1011`）；另有**入站**的 text 引用 `target_type='word' AND target_id = word id`

而**删除侧已经存在一套阻塞式守卫**（`src/repositories/word.repository.ts:589-611`）：`DELETE FROM words` 带三个 `NOT EXISTS`——L3 occurrence / 用户笔记 / 入站词链；service 层的分类注释（`src/services/word.service.ts:97-100`）写明：

> 阻塞（409 + blockers）：绑定 L3 语境 / 用户笔记 / 入站语境链接；
> 随删（FK 级联）：复习进度（无移除出口且本就是待清理的污染）、词单成员、高亮批注。

且硬删**仅限 stub**（`definition_md = ''`）：service 预检 + 守卫 DELETE + DB 触发器三层兜底，`DELETE /api/words/:slug` 是唯一入口（`src/http/routes/words.ts:184-194`）。

⇒ 于是"orphan 池 + reaper"要解决的问题——**词死了但素材还在**——在当前规则下不会发生：**词在素材存在时不能死**。

## Decision

1. **删除语义 = 阻塞式（blocked deletion）**：存在 L3 occurrence、用户笔记或入站词链时**拒绝删除**（409 + blockers 计数），**不提供 force/级联开关**。用户必须先显式清理引用，再删词。
2. **仅 stub 可硬删**（现状保持）：`definition_md = ''` 是删除的前置条件，带内容词条不可删——因此"删掉真词条导致素材失去宿主"这一场景当前不存在。
3. **FK 语义按"素材 vs 用户数据"分两类**（把 service 注释里的分类升为正式清单）：
   - **素材与永久引用 → `ON DELETE RESTRICT`**：`l3_occurrences.word_id`、`l3_context_links.word_id`（本轮由 `cascade` 改为 `restrict`）。任何绕过守卫的删除路径必须**响亮失败**，而不是静默销毁素材。
   - **可随删的用户数据 → `ON DELETE CASCADE`**（不变）：`user_word_progress`、`review_logs`、`word_highlights`、`word_annotations`、`word_tags`、`wordbook_items`、`l2_drill_steps` 等。
4. **不建 orphan 池，不建 reaper**：孤儿是"词已死而素材仍在"的产物；本决策让这种状态不可达，故没有可回收对象。将来若真要批量清理错词，走**显式运维路径**（先清理引用、或先把素材固化为不依赖词的状态），并留审计。
5. **守卫必须集中且可测**：`deleteWordById` 的 `NOT EXISTS` 与 blocker 计数同源；**新增任何词引用类型都必须进守卫**，并以契约测试守护（新增引用却未进 guard 时测试必须失败）。

## Tradeoffs

- **CASCADE vs orphan+reaper vs blocked**：CASCADE 简单但让素材随词湮灭（与"素材即资源"相悖）；orphan+reaper 保素材但引入新机制、新表与"悬挂但可读"的中间态；**blocked 保素材且无需新机制**，代价是把复杂度交给用户（必须先显式清理）。
- **RESTRICT vs 继续 cascade 兜底**：RESTRICT 让"素材不可静默销毁"从**约定**变成**引擎强制**（与仓库既有的"三层兜底"风格一致）；代价是一次迁移，以及与其他 cascade 子表形成刻意的不对称。
- **仅 stub 可删 vs 开放真词条删除**：保持现状即可让本决策自洽；开放真词条删除会立刻重新引入 orphan 问题，需要新 ADR。

## Consequences

- ✅ 素材永不静默湮灭：删词在素材存在时被拒绝，绕过守卫时被 RESTRICT 挡住。
- ✅ 无需新表、新服务、新后台任务；H03 的"orphan 池 + reaper"可整项删除。
- ⚠️ 用户会撞到 409：UI 必须把 blockers（计数 + 类别）呈现为"先清理什么"的可操作清单，否则阻塞会变成困惑。
- ⚠️ 计划中的"存量悬挂扫描"仍需做一次（**作为验证而非修复**）：`l3_context_links.target_id` 是无 FK 的 text 引用，历史删除可能已留下悬挂值；扫描只出报告，不自动清理。
- ⚠️ 多用户重估（ADR-0022 的远期项）时必须重新审视守卫的 per-user 谓词：当前 blocker 只数**本人**的引用（`o.user_id = $2` 等），多用户下"他人引用同一全局词"不会被阻塞。
- ⚠️ RESTRICT 是迁移（ledger 31→32），需 `db:schema:drift` 与 `release:rollback-check` 一同过门禁。
- ⚠️ **未决项（产品，非架构）**：是否开放"删除带内容的真词条"。开放前必须补齐 orphan/blocked 规则——那时本 ADR 需要修订或新增 ADR。
