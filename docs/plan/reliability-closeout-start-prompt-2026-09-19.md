# 下一轮执行 Prompt：Git 事故收尾与保存可靠性补强

以下内容可直接发送给接续执行者。

---

请接续现有可靠性修复批次，按下面计划实际执行修复和验收，不重新展开产品规划。

**先读取完整执行计划：**
`D:/Temp/Myawesomeapp/vocab-ob'/wt-main/docs/plan/reliability-closeout-execution-plan-2026-09-19.md`

再读阶段复核：
`D:/Temp/Myawesomeapp/vocab-ob'/build-analysis/status-2026-09-19/可靠性批次阶段复核.md`

你的工作区是 `D:/Temp/Myawesomeapp/vocab-ob'/wt-reliability`。观察时分支 reliability-batch HEAD=3c906a3，Task A修复=56fabdd；Task B含未提交文件。共享Git实测为 `D:/Temp/Myawesomeapp/vocab-ob'/wt-main/.git`，主线ccc6fb4。这些只是观察值，执行前重新核对；保留最新Task B工作，不reset、不另起分支重做、不清理其他工作区。

**必须按顺序：**

1. Git事故收尾。接管前确认其他执行者已停止共享Git写入，包括自动fetch/maintenance和可能运行prepare的npm命令。由你一人完成：四工作区文件与暂存状态清点、完整元数据和未提交内容备份/hash校验、隔离经验证的旧MIDX与无pack配对idx、校验有效pack、正常配置下fsck、独立bundle恢复演练。只读旧证据为默认fsck=32、命令级关闭MIDX后=0；如果现场已修复就验证成果，不重复移动。禁止删除pack、gc/prune/repack、reset/clean或重建工作区index。禁止只靠禁用MIDX宣称完成。HUSKY=0仅临时隔离，删除根因未锁定；不声称全部旧reflog/暂存均已找回。

2. 修订作文及题纸controller的订阅合同：最后收到的快照必须包含正确终态和inFlight=false；dispose后无通知；补成功/失败/409/Task A恢复续写及订阅回调重入的先红后绿测试。保存时间使用实际确认时间，不在每个clean通知里生成现在时间。

3. 普通题纸贯通expectedVersion。PATCH和seal必填客户端确认版本，更新domain/schema、service、repo、HTTP、client和OpenAPI；缺版本400、旧版本409、跨owner404、writing仍拒绝通用写面。seal必须使用flush回执的version，不能GET最新版绕过冲突。保存冲突保留本地输入并停自动写；网络重试冻结同一载荷/版本，响应丢失允许保守冲突，不新增幂等数据库模型。草稿导出同样核对flush版本，sealed导出保持可用。

4. 逐题脏键：成功后只清除发送时相同seq的键，在途期间再次编辑的题保留；Q1保存后只改Q2，后续请求不能夹带旧Q1。请求值不可被后续本地改动变异；每批最多200键，按序分批不得提前满足flush。补两标签同题冲突、不同题不覆盖、null清除和201题边界。

执行完整计划中G0→G1→G2→S→V/Q→E。先失败复现再最小修复，采用Node22.22.2/npm10.9.7；先完成Git门禁，再开始Git提交与其他依赖操作。真库与浏览器只用独立验收库和fixture，不向真实dev库seed/cleanup。真实PG两连接必须覆盖“客户端确认之后/服务端读取之前”和“服务端读取之后/最终UPDATE之前”两种竞态；浏览器检查UI与库核，不能只看截图或组件mock。

不开发学习笔记、分页、备份调度、注记评审新功能或完整翻译工作台。本轮先完成以上四项，原Task C入口工作随后再接，并先核对writing-practice-v1已有成果。不要并行修改共享Git或同一控制器。

完成后更新wt-reliability内现有执行台账，给出Git正常fsck/备份恢复证据、先红后绿、API合同、真PG、浏览器、提交及剩余限制。有可用远端时可建/更新draft PR并附着任务；不合并、不部署。缺环境或协调条件时明确是哪一步阻塞，完成可独立做的只读检查，不伪报全绿。
