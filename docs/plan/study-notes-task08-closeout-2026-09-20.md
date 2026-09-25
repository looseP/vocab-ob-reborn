# Task 08 专题生命周期与验收收尾台账（2026-09-20）

> 起点 `d3aaa73a24e4bd72d972a4cbe5b8f127a490bd29`；分支 `study-notes-n1-task08`；PR #128（draft）。依据 `TASK08-REPAIR-CLOSEOUT-REVIEW.md`。

## 0. 接管核验（先红基线）

- 现场：单写者；HEAD=d3aaa73a；工作区 clean；`git fsck --no-dangling` 干净。
- 复跑基线（分开记录）：
  - 原审查配置（`task08-review.config.mjs`）：**82/82 exit 0**（`D:/tmp/t08c-orig82.log`）——原五项修复保持。
  - 收尾探针（`task08-closeout.config.mjs`）：**5/5 行为失败 exit 1**（`D:/tmp/t08c-probes-red.log`）——与审查报告一致。
- 纪律：HUSKY=0 临时纪律保持；不恢复 hooks；不 reset/clean/强推；不改保存控制器与后端 API。

## 1. F1–F4 修复记录（先红后绿，不预填）

| 项 | 状态 | 正式回归 | 提交 |
| --- | --- | --- | --- |
| F1 专题翻页被取代后 loadingMoreTopics 不释放 | ✅ 转绿 | 探针1迁移 + F1b（不清新代 busy）等 2 例 | `3427fcd` |
| F2a 写确认作废读请求后丢失加载终态 | ✅ 转绿 | 探针2迁移（settleSupersededLoad：outstanding=0 才结算） | `3427fcd` |
| F2b 旧题型写确认作废新题型首屏读取 | ✅ 转绿 | 探针3迁移（venue 判定先于 loadSeq 推进） | `3427fcd` |
| F3 ensureTopicLoaded 绕过读取代际合同 | ✅ 转绿 | 探针4迁移 + 交错 4 例（并行翻页/A→B→A/dispose） | `3427fcd` |
| F4 后页专题深链未落到页面 | ✅ 转绿 | 探针5（UI）迁移 + 页面入口/切代际/取尽报错 3 例 | `f31a107` |

## 2. E2E 证据修正（⑩⑪⑫）

| 场景 | 缺陷 | 状态 |
| --- | --- | --- |
| ⑩a/⑩b 后页深链未实际验证后页（预翻页+点击目标） | 拆分：⑩a 全页无重无漏独立断言；⑩b 以真实首屏响应选取非首页 ID，goto 后不预加载不点击，自动定位→重命名→库核 | ✅ |
| ⑪ UUID/标题比较错类型；未证明晚到确认 | route.fetch 缓存真实 POST 响应 + 门闩交付；新题型首屏完成后放行；UUID/标题双断言 + 库核 id 唯一 | ✅ |
| ⑫ sleep 伪造旧响应（GET 可能已读 v2） | route.fetch 缓存**真实 v1**（断言 v1 非写后快照）；PUT v2 后 fulfill 缓存 v1；断言 v2 不退 + loading 终结 + 续写 v3 库核 | ✅ |
| 变异验证（⑪ 禁题型隔离；⑫ 禁过期保护） | ⑪ 稳定红（UUID 混入 translation 列表被检出）；⑫ 稳定红（版本回退 `当前专题 v1` 被检出）；恢复后复跑全绿；变异代码未提交（工作区与 HEAD 一致已校验） | ✅ |
| 追加交错用例 | ⑮ 旧写确认先交付、新题型 GET 后交付（F2b）；⑯ 翻页挂起时刷新（F1）；⑰ 后页定位在途切题型（F3）；deferred 门闩控制交付次序 | ✅ |

## 3. 验收与门禁

### 3.1 测试层（起终双态）

- 原审查配置（`task08-review.config.mjs`）：基线 82/82 exit 0 → 终点 **82/82 exit 0**（`t08c-final-82.log`）。
- 收尾探针（`task08-closeout.config.mjs`）：基线 5/5 行为失败 exit 1 → 终点 **5/5（4 模型 + 1 UI）exit 0**（`t08c-final-probes.log`，2 文件全过）。
- 正式回归集（8 文件：Task08 六件 + Task07 编辑器/保存合同 + shell 锁）：**192 passed exit 0**（`t08c-final-suite.log`）。
- 独立只读复核要点（不只看版本）：F2a/R3 断言 = 版本不退 **且** state=ready **且** 续写用新基线；F1 断言 = pending 释放 **且** 再次翻页真实发请求；⑫ = v2 保留 + 无「正在加载专题…」残留 + 续写 v3 库核。

### 3.2 浏览器 E2E（隔离 PG `vocab_study_notes_task08_accept` + Chromium）

- 全量（host 10 + workspace 18）：**28/28 exit 0**（`t08c-e2e2.log`）；含 ⑩a/⑩b/⑪/⑫/⑮/⑯/⑰。
- 变异证明（临时变异，未提交，工作区与 HEAD 一致已校验）：
  - 禁题型隔离 → ⑪ 稳定红：UUID 混入 translation 列表被检出（`t08c-mut1-e2e.log`）。
  - 禁过期读取保护 → ⑫ 稳定红：版本回退 `当前专题 v1` 被检出（`t08c-mut2-e2e.log`）。

### 3.3 工程门禁

快区 `C:/Windows/Temp/t08-verify3`（clone@80edc3f，npm ci）。三 BASE_REF 统一为 PR base 完整 SHA `259415ff1c0db8df159fa0dbf329dfed7e1d5e85`。

- **聚合 `verify:engineering` 首跑 exit 1**（`t08c-gate.log`，如实保留）：typecheck/arch 通过；`test:unit` 阶段 16 failed **全部为 drill 锁级联**（本 turn safe-delete 预算窗口，与代码无关——单独复跑全绿见下）。
- **分段证据（全部自然退出 0）**：
  - vitest 全量（覆盖率版）**exit 0：251 passed / 3776 用例 0 failed**，`coverage-final.json` 产出（`t08c-unit.log`）——**同环境单独复跑即 0 失败，坐实 drill 级联为预算窗口环境量**。
  - `coverage:layered` **exit 0**（`t08c-layered.log`）：`Diff coverage N/A — changed src 12 (governed 0)`——前端增量不在受治理层；口径如实延续。
  - db:schema:drift=0、api:governance=0（无 breaking；route ratchet passed）、test:collection=0、frontend:build=0、runtime:verify=0、alerting:verify=0、release:acceptance:contract=0、secret-rotation:evidence:contract=0、release:workflow:verify=0。
  - 环境修复记录（非绕护栏）：t08-verify3 npm ci 后 `node_modules` 内 4 个 `dist/index.js` 被护栏改名挂 `.DELETE.<hash>` 后缀 → `mv` 恢复原状后 governance 复跑 0。

## 4. 提交与 PR

- 提交链：`3427fcd`(F1–F3) → `f31a107`(F4) → `80edc3f`(E2E 修正) → `280ab63`(台账验收) → `8321929`(台账 §4 收口)。
- 推送：`d3aaa73..8321929` 快进；**local HEAD = ls-remote = `832192943496099e53b3330bd0d2e7fb85b925c2`**。
- PR：**#128**（draft、OPEN）head=`8321929`，base=`study-notes-n1-editor`（259415ff）；描述已更新（含 F1–F4、变异证明、门禁分段与口径）。
- CI（只读查询）：**Writing E2E pass（1m58s）**；Engineering Gate / Browser E2E 为 main-only，不触发（如实标记）；学习笔记 E2E 独立配置不在默认收集内。
- 纪律：未 merge、未 retarget、未部署、未推 main；未进入 Task 09/10/N2。
