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
| 作文稿次接口已合并并验收 | 稿次协议（task/sheet/origin/resume）已合并（design `:10`）——**待确认稿次本体表**（D1） |
| 历史引用的内容清理与改判语义 | ❌ 未定（待定项 D3） |

**结论**：启动条件**未完全满足**——D1/D3 未定前不进入实现。

## 2. 接入顺序（沿用 execution-plan `:362`，不打乱）

1. 注记 / 评析摘录
2. 笔记互链
3. 精确 sheet + attempt
4. 对应 grading
5. writingTask + writingSheet + feedback

每一类落地前都要先补齐它的五件套（§3），顺序不可跳跃——后面的目标依赖前面的
「引用型扩展 + 导出版本」决策是否已被验证。

## 3. 每种目标的五件套（必备，缺一不验收）

1. **归属**：owner-only + RLS `*_own_all` + 跨表属主一致性 FK（冻结项 B1）
2. **内容清理**：目标被删时的 blocker 登记，先例 `getSourceDeleteBlockers` / `getQuestionDeleteBlockers`（A3）
3. **引用时快照**：`display_snapshot` 白名单 + `captured_at`，不回套活体文本（C1）
4. **变更提示**：`field_hash` 输入字段集合写死（A2）；`changed` 只提示不改写，`unavailable` 保留占位块
5. **只读导航测试**：从引用跳回目标只读视图（复用 F-1 协议，不自造参数）

## 4. 冻结门禁（写实现前必须逐条签字）

- [ ] 数据模型：`REFERENCE_KINDS` / `ReferenceTarget` 扩展方式已定（A1），无 unknown JSON 后门
- [ ] 权限：新目标表的属主列 + RLS + FK 一致性 + agent 403 不变（B1/B2/B3）
- [ ] 引用版本：每类目标的 `field_hash` 字段集合已写死；改判语义（C3）已定
- [ ] 导出兼容：新引用型对 `payload.references[].kind` / `target` 的影响已定，
      明确 **升 `exportSchemaVersion`** 还是加类型判别（D2）
- [ ] 待定项 D1–D4 全部有答案（见盘点 §8）
- [ ] 遗留观察 F-1（`bodyMd` 命名）已决定随本次一并处理或明确推迟

## 5. 决策表（本批待拍板，未拍板不写实现）

| # | 决策 | 候选 | 影响面 |
|---|---|---|---|
| P1 | 作文稿次本体 | `l3_submissions` / 独立 `l3_writing_sheets` | 目标形状、导出 target、blocker |
| P2 | 笔记互链载体 | 新建链接表 / 扩展 `l3_study_note_references` | 后者动 N1 冻结枚举 |
| P3 | 改判语义 | 新增快照 / 就地更新 + changed | 引用版本、来源清单排序 |
| P4 | 导出版本策略 | 升 v2 / v1 内加判别字段 | 离线档案兼容、`X-Export-Schema-Version` |
| P5 | 内容清理边界 | 硬 blocker / 软提示（unavailable 占位） | 删除链路、ADR `:28/:40` |

## 6. 不在本批

- N3 产品扩展（agent 整理/合并、专题导读、从引用题集发起复练）——另立提案与权限。
- 分页、注记（前端面）、自动整理——沿用既有后置清单。
- 任何 `src/` 实现代码、迁移、依赖变更。
- 不顺手修 F-1/F-2/F-3（已登记至 `study-notes-followups-2026-09-23.md`，按批次处理）。

## 7. 本批交付物与自检

- [x] `study-notes-n2-inventory-2026-09-23.md`（只读盘点 + 四项冻结）
- [x] 本任务书
- [x] `study-notes-followups-2026-09-23.md`（遗留观察登记）
- [ ] §4 门禁逐条签字（**阻塞点**）
- [ ] 不 push、不建 PR、不合并、不部署——待用户授权
