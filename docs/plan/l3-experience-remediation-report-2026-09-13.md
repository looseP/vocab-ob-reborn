# L3 体验层补救：最终报告（2026-09-13）

执行窗口：2026-09-12 晚 ～ 2026-09-13 00:40。依据：`docs/plan/l3-experience-layer-direct-brief-2026-09-12.md`（下称 direct brief）与 `l3-experience-layer-deep-brief-2026-09-12.md` 的 D0–D4 路线。工作树：`wt-main`（本地 main，未推送）。

---

## 1. 完成度矩阵

| 阶段 | 内容 | 状态 | 交付 |
|---|---|---|---|
| D0 基线 | 设计基线文字稿（无视觉稿，自述性质） | ✅ 完成 | `34140c4` + `wt-main/docs/design/l3-space/baseline.md` |
| D1 走查 | 12 页 + 阅读视图逐页截图对照（47 张） | ✅ 完成 | `docs/plan/l3-visual-audit-report-2026-09-12.md` |
| D2-B1 素材宇宙首页 | 替换占位页：生长计数/最近导入/最近圈记/入口四区块 + 四态 | ✅ 完成 | `399750b`（后端）+ `893ea87`（前端） |
| D2-B2 生长感 | 累计圈记趋势图（14 天 SVG 面积图，选一形态做深） | ✅ 完成 | `4664327` |
| D2-B3 阅读/圈记对齐 | FR-2/FR-3 核查 + 2 个 P0 修复 | ✅ 完成 | `a7890bf` |
| D2-B4 视觉收敛 | 全站 accent token 补定义 + 工具页共享样式层（50 类） | ✅ 完成（范围见 §5） | 含于 `a7890bf` + `96a96a1` |
| D3/D4 流程加固 | 任务模板 UI 卡验收条款（基线引用 + 前后截图，缺一不收口） | ✅ 完成 | `l3-upgrade-task-breakdown-2026-09-11.md` §0 第 12/13 条 |
| 最终报告 | 本文档 | ✅ 完成 | 本文档 |

**整体判定：direct brief 的 D0–D4 主线全部落地；遗留为范围内明确收缩的次级项（§5），无虚报。**

## 2. 提交清单（base `d3ae06b` → HEAD `96a96a1`，6 commits / 29 文件 / +2288-32）

```
96a96a1 feat(frontend): define the shared tool-page style layer the L3 pages already reference
a7890bf fix(frontend): make capture highlights visible and keep badge labels out of selection offsets
4664327 feat(frontend): grow the material universe with a cumulative capture trend
893ea87 feat(frontend): turn the L3 home into the accumulating material universe
399750b feat(l3): add the read-only space summary for the material universe
34140c4 docs(design): distill the L3 space experience baseline from the text brief
```

新增后端面（完整 SOP）：`GET /api/l3/space-summary?days=n`（1–90 夹取）——schema → service contract(.strict) → 薄路由 `src/http/routes/l3/summary.ts` → `operations.ts` 登记 → openapi/client 再生 → http/service/repository 三层测试 → 授权注册表 F1 分类 → 路由复杂度棘轮条目。

## 3. 门禁证据（全部【本地跑】，未上 CI）

| 门禁 | 结果 | 证据要点 |
|---|---|---|
| `tsc --noEmit`（主 + frontend） | ✅ 0 错误 | 每阶段提交前复跑 |
| 全量单测（含 coverage） | ✅ 182 文件 passed / 1 skipped，0 失败 | `D:/tmp/l3-vitest-cov6.txt`；B1 时点曾全量 2563 测试全绿 |
| `coverage:layered`（`COVERAGE_BASE_REF=d3ae06b`） | ✅ PASS | diff 100%（100/100 可执行行）；governed 8 / 非 governance 层 11（纯前端无义务）；基线棘轮 PASS |
| `arch:check`（depcruise） | ✅ 零违规 | `D:/tmp/l3-arch.txt` |
| `api:governance` 六步（`API_CONTRACT_BASE_REF=d3ae06b`） | ✅ 全绿 | openapi / client:check / contract / breaking / breaking:contract / complexity:routes |
| 变异检验 | ✅ 会红 | B1：clamp/`??` 回退各破坏一处 → 2 红；B3：还原 `isInjectedText` 短路 → 2 红 |
| 运行时验证 | ✅ | compose web 镜像三轮重建，真实实例截图取证（47 张） |

取证纪律遵守：base 一律显式传 `d3ae06b`（未指向 HEAD）；棘轮 bootstrap 限额与 `measureRouteComplexity` 同口径实测。

## 4. 走查发现 → 修复对照

| 级别 | 发现 | 处置 |
|---|---|---|
| P0-1 | `--color-accent-soft`/`--color-accent-contrast` 全站使用但未定义 → 圈记高亮、深链闪高亮完全不可见 | ✅ 明暗双主题补定义（`a7890bf`）；运行时取证 `rgba(15,111,98,0.14)` 生效 |
| P0-2 | `computeGlobalOffsets` 把句尾标号按钮文本计入累计长度 → 选 "enduring" 存成 "nduring"（锚点错位 + stub 误判） | ✅ `isInjectedText` 排除 `data-context-badge` 子树（`a7890bf`）；实测捕获条正确显示 "enduring" |
| P1 | 暗色侧栏 active 亮青底+白字不可读 | ✅ 随 accent-contrast 暗色取值 `#10201c` 修复 |
| P1 | 工具页（导入/手动/提议/推荐/图/空间）约 50 个自定义类未定义 → 布局散架 | ✅ 共享样式层 422 行（`96a96a1`）；截图对照：导入页从挤压成团 → 规整卡片表单 |
| P1 | 空间首页占位页（Cache reason 工程术语暴露） | ✅ B1 素材宇宙替换 |
| P2 | 标号浮置、图页手动触发加载、推荐页原始 JSON 字段暴露、工具页英文工程文案 | ⚠️ 部分遗留（§5） |

FR-2/FR-3 核查结论：`buildRanges` 严格取 `contexts[].position` 锚点偏移并集、不做词形扩展（Q7 语义符合）；搭配圈记（记录搭配分支）、stub 建词提示、词详情回流（WordL3Contexts「在素材空间查看」）均在且经测试覆盖，未发现与已定决策冲突。

## 5. 范围收缩与偏离记录

1. **B4 只做样式层收敛，不做信息重设计**：推荐页的 `id/run/reason/evidence/payload` 原始字段倾泻、图页「手动 Load」交互、工具页英文文案（Raw Import / Proposal Review 等）——属信息架构/文案层，超出「密度/层级/空态/状态色/动效收敛」的 B4 口径，列为遗留。
2. **B2 选型**：三形态（趋势/密度/时间轴）中只做「累计圈记趋势」一个深形态，符合 brief「不做三个半成品」。
3. **书架 b/c 差异**：direct brief 与 deep brief 对书架区块的转述存在差异，基线 §自查表已记录口径取舍（以 direct brief 为准）。
4. **accent token 的全站性**：`--color-accent-soft` 被非 L3 页（Review/WordL2Composer）引用，补定义属全站修复，与 2026-09-08 `--color-surface` 先例同口径——已在代码注释锚点说明。
5. **环境事件**：会话中途遭遇安全删除守卫（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）拦截 vitest 覆盖率清理与测试锁 unlink——已确认与代码无关（豁免后 182 文件全绿），报告不计为回归。

## 6. 截图索引（`deliverables/software-company/l3-visual-audit-2026-09-12/screenshots/`，47 张）

- 走查基线（before）：`00-`～`25-`（28 张，含暗色/移动/深链/选区浮层）
- B1 after：`b1-after-01~03`（明/移动/暗）+ `b1-state-{empty,loading,full,error}`
- B3 after：`b3-after-01~04`（高亮可见/深链闪高亮/偏移捕获/暗色）
- B4 after：`b4-after-01~07`（导入/提议/推荐/手动/图/词空间/语境）

## 7. 残留 gap 与后续建议

1. **信息层**：推荐页字段倾泻、图页空态交互、工具页中文化——建议立一张 D5 信息设计卡（走查报告 P2 清单可直接引用）。
2. **流程**：UI 卡验收条款（§0 第 12/13 条）已在模板落地，但本报告多项门禁仅【本地跑】——推送前需 CI 复核（`Browser E2E` + `Engineering Gate`）。
3. **数据积累**：空库状态下的空态设计已验证，但「生长感」在真实多周数据下的观感待数据量上来后复走查。
4. 本机 `main` 领先 `d3ae06b` 6 个提交未推送；推送前先 fetch 确认远端无并发推进。
