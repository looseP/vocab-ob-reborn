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
| F1 专题翻页被取代后 loadingMoreTopics 不释放 | __待补__ | 探针1迁移 | — |
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

__待补__

## 4. 提交与 PR

__待补__
