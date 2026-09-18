# 作文子空间外派启动 Prompt

用途：把下面第一段完整复制到负责实施的新任务。第二段是主理人向单个执行者派W任务的模板。第三段是独立验收任务的完整启动指令。本文件本身不代表已开始开发、已创建PR或已授权合并。

## A. 主理人启动（直接复制）

```text
请执行当前项目“作文子空间 v1”开发，以完成可实际使用的写作—提交—反馈—第二稿—历史回看闭环为目标，不止做静态界面。

工作区根：D:\Temp\Myawesomeapp\vocab-ob'
主代码目录：D:\Temp\Myawesomeapp\vocab-ob'\wt-main

先完整阅读三份权威材料：
1. wt-main/docs/plan/writing-space-design-2026-09-18.md
2. wt-main/docs/plan/writing-space-execution-plan-2026-09-18.md
3. wt-main/docs/plan/writing-space-start-prompt-2026-09-18.md
再读取实际适用的AGENTS.md、docs/plan/README.md、CONTEXT.md、ADR-0023/0029/0030/0034/0035及设计基线。
文档冲突时以本次设计的明确修订为准，但不要把旧ADR中的未实现承诺当实现事实。

本次授权范围：按设计v1实现、必要回归修复、独立测试库迁移与验证、任务级提交、创建draft PR。允许你将计划中的独立W任务派给子代理，最多3个并行实施者；你仍负责接口一致、集成和最终验收。没有自动合并PR、操作生产库、部署或发送外部消息的授权。

第一步执行W0。接入复核main为f03ffe3，PR #121/F-1与0037已合入。现在重查git状态，确认包含该提交。三份writing-space计划目前未提交：先仅点名提交这三份文档，README只暂存自己的精确hunk；不要夹带study-notes、临时脚本。再建隔离worktree并验证三文档存在。0037不可重写；新迁移按最新journal分配。复用F-1，不重做普通档案；统一sheet查询参数，section=writing优先，纯?sheet的writing通过只读scope分流。旧档案明确限file/paper。不要读取或打印.env/token。

按W0—W11依赖推进。先完成ADR、schema和domain/DTO冻结，再并行。schema/journal/operations/生成client及全局注册文件由指定集成者单写；其他任务提交独立实现与注册需求。每个子代理收到：确切任务编号、完整设计引用、输入输出合同、允许改动文件、禁止触碰文件、定向测试命令、验收要求。不得让子代理自选重叠共享文件或自行改scope。

关键架构不可偏离：
- 新增writing task和writing feedback；扩展submission writing scope；提交后正文只在attempts。
- 专用textarea及保存控制器；不能把大型L3ExamPaper复制成作文组件。
- 现有strict sheetAnswerSchema没有text；必须实现专用文本保存契约，不能仅改前端。
- GET全部只读；查看某稿不调用openSheet，不生成draft。新稿只由明确POST创建。
- task→sheet固定锁序；expectedVersion防覆盖；保存仅一请求在途；flush等待确认，失败拒绝；提交和导出不能越过保存失败。
- 提交后不可编辑原稿；新稿显式parent引用。feedback绑定确切sheetId和正文SHA256，offset采用UTF16，quote逐字匹配。
- 不把作文反馈压成correct/partial/wrong，不同时写两种反馈真源。
- 通用sheet/grading/export写面不能成为绕过专用规则的旁路。
- agent只读指定已提交稿context、写该稿feedback，不能读草稿或改正文；身份由服务器决定。
- 中文文案、手机可用、现有token；L3不写FSRS，无离线队列，无新依赖。

第一版只做整篇/段落/自由写作、可靠保存、提交、手动触发本地agent反馈、刷新、第二稿、历史/对照、单稿导出、任务归档恢复。不要加入数字评分、计时模拟、自动agent守护进程、代写、素材推荐、全站搜索或音视频。

每任务执行失败测试→最小实现→定向验证→review→任务提交。遇到修复建议先核实。运行环境使用项目要求的Node/npm，Windows检查内存；低并发运行，不把OOM记成通过。COVERAGE/API_CONTRACT/ROUTE_COMPLEXITY的base必须能覆盖真实PR差异，禁止设HEAD或改基线规避门禁。

验收必须包括真实浏览器+真实HTTP+独立PostgreSQL验收库：
开始写→保存→离开恢复→提交→agent按精确稿评阅→手动刷新见反馈→第二稿→对照→关闭→URL重开第一稿→F5，确认数据库不新建draft且两稿不串反馈。
另测：保存失败/延迟/乱序、双标签页冲突、重复提交、删除正文与feedback并发、25条分页、非属主、agent越权、中文/emoji/IME、390×844手机视图。
LLM调用用确定性的agent HTTP payload做验收即可，但浏览器API与数据库主链不能mock成功。

每个里程碑简报只报告已完成、证据、尚未验证和下一步。若需要修改设计中的实质边界（数据真源、权限、scope、版本语义），列具体冲突与最小建议供决策，不暗改；独立可做部分继续推进。

最终交付：实现commit/draft PR、更新后的任务勾选与执行日志、真实验收报告、截图路径、DB核对结果、门禁命令/exit code、迁移与兼容说明、明确遗留。创建PR后挂到当前Codex任务。没有得到合并/部署授权不要执行。
现在从W0开始。首个里程碑完成W0/W1的基线、ADR、DTO、迁移与真实RLS证据，报告后按已授权依赖继续；不要在schema未冻结时并行派多个写者。若study-notes也在开发，先协调schema、operations和L3Page独占，不把两个子项目合成一轮大迁移。不停留在复述计划。
```

## B. 单任务派工模板

主理人使用时填写方括号内的**派工元数据**；这些槽位仅用于选择任务/checkout，不代表产品规格未决。不得把未填模板直接发给执行者。

```text
你负责作文子空间实施计划的 [W编号与任务标题]。
本轮唯一工作目录：[已建立的隔离worktree绝对路径]。
集成基线：[实际SHA]；已合并前置任务：[编号与提交SHA]。

完整阅读：
docs/plan/writing-space-design-2026-09-18.md
docs/plan/writing-space-execution-plan-2026-09-18.md
先理解全局红线，再逐项执行指定W任务。不要自行扩展到其他W任务。

允许改动：[从指定W任务复制的文件清单]。
禁止触碰：其他执行者文件；schema/journal/operations/全局注册/生成client，除非你的任务明确被指定为这些文件的唯一集成写者。
输入接口：[复制前置任务实际冻结的签名与DTO，不只给一个名词]。
输出接口：[复制本W任务Interfaces]。
验收：[逐项复制本W任务测试与成功条件]。

先写能揭示问题的失败测试，再实现，再跑定向验证；真实DB测试使用独立验收库。不得伪造通过、降低覆盖门禁、修改未授权数据。任何提交只包含你的文件。不要merge/deploy。

若发现接口冲突或需要写其他人独占文件，立即把“冲突位置、原因、最小差异”发给主理人；继续不依赖冲突的工作。不要直接覆盖共享文件。

完成返回：实现范围、commit SHA、变更文件、每条验证命令与exit code、证据位置、未验证项、集成者需要应用的共享注册差异。不要只说完成。
```

## C. 独立验收启动（直接复制）

```text
请作为独立审查者验收作文子空间v1。先阅读docs/plan/writing-space-design-2026-09-18.md与writing-space-execution-plan-2026-09-18.md，再查当前实现。不要依赖实现者的“全绿”总结替代验证。

首先记录当前commit、dirty状态、实际前端/API/独立验收库配置（不输出凭据）；若不是实施方交付commit先注明差异。只读审查业务代码；新增验收测试/报告可以，不主动重写功能。

优先验证六件事：
1. 最后一次输入保存失败或仍在途时，提交/导出是否被可靠阻止。
2. 双设备保存、保存与提交交错是否出现静默覆盖或旧正文被定格。
3. 已提交稿关闭页面再以sheetId重开、F5后，ID/正文/反馈是否保持且没有新draft。
4. 第一稿反馈是否会被第二稿误用，hash/quote/UTF16锚点是否真正校验。
5. agent与generic接口能否绕过draft读禁令、版本校验、写正文限制。
6. 删除正文后，feedback/context/export是否仍泄露正文摘录；并发删除/写反馈也要覆盖。

再验证主线：直接开始、题库进入、段落练习、分页>20、归档恢复、手机/明暗、IME、第二稿与对照、导出可解析且hash可复算。
允许用确定性HTTP请求模拟agent评阅，不需要调用LLM。使用真实浏览器、真实HTTP及独立验收PostgreSQL；不对主链返回fake成功，不操作真实学习数据。

报告按严重度列问题：具体触发步骤、期望/实际、精确代码锚点、截图/日志/DB证据、是否复现。区分静态风险、实测缺陷和产品提议。没有证据的检查列未验证，不写PASS。
结论分别给“保存可靠性、稿次一致性、权限、UI闭环、工程门禁”，不能用一个通过掩盖未验收项。不得合并PR或部署。
```

## 可选派工节奏

- 第一轮仅W0/W1；基线与契约未冻结不派三个代理抢schema。
- 第二轮W2/W3，W1作者担任集成；W3完成后W4/W5可以并行。
- 第三轮W6接口集成后W7/W8界面推进，W9独立导出/清理。
- 最后一轮W10真实验收，再W11全量门禁和draft PR交付。

若只有一个执行者，按同样依赖顺序串行即可；并行是提速选项，不是完成条件。
