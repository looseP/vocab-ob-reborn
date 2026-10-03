# Cambridge 虚假署名审计清单（22 条）

**审计日期**：2026-10-03
**审计人**：ZCode（自动化审计 + 人工核对抓取结论）
**结论**：22 条 `examples[0].source` 声称来自 Cambridge Dictionary，但正文均为**自撰教学例句**，
Cambridge 页面不含这些句子。这是**虚假署名**（既误导学习者，也是对他方来源的错误归属）。

---

## 1. 问题定性

库内这 22 条的 `examples[0]` 形状：

| 字段 | 值 |
| --- | --- |
| `source` | `Cambridge Dictionary · <lemma>` |
| `source_type` | `reference` |
| `url` | `https://dictionary.cambridge.org/dictionary/english/<entry>` |
| `text` | **自撰教学句**（非 Cambridge 例句） |

三条独立证据链：

1. **逐条抓取核对**（本次，见 §2）：抓取的 Cambridge 页面**不含**库内句子。
2. **产线自留的声明**：这 22 条的 `verified.assertions_avoided` 里写着
   「句层为 Cambridge Dictionary 示例句（试点），生产前建议替换为语料库真实句并网页核验」
   —— 即产线自己也知道这是试点、待替换。
3. **同批数据的对照组**：同库里另有 216 条词用 `构造参考 · <lemma>` 如实标注自撰句，
   说明"如实标注"在本仓已有既定表述，这 22 条是**例外**（漏标）。

## 2. 抽样抓取证据（6 条，2026-10-03）

抓取方式：`curl -sL -A "<browser UA>" https://dictionary.cambridge.org/dictionary/english/<entry>`，
提取 `<span class="eg">` 例句，并全文检索库内句子是否出现（HTML 剥标签后大小写不敏感匹配）。

### 2.1 `accuse`

- **库内句子**：`The opposition party accused the minister of hiding the full cost of the project from parliament.`
- **该句是否在页面上**：**否**
- **Cambridge 实际例句**（抓取所得，节选）：
  - `"It wasn't my fault." "Don't worry, I'm not accusing you."`
  - `He's been accused of robbery/murder.`
  - `Are you accusing me of lying?`
  - `The surgeon was accused of negligence.`
  - `The government stands accused of eroding freedom of speech.`
  - `He was accused of failing to pay his taxes.`
  - `She accused me of lying.`

### 2.2 `biophilia`

- **库内句子**：`Urban planners increasingly cite biophilia when arguing for more green space in cities.`
- **该句是否在页面上**：**否**
- **Cambridge 实际例句**（抓取所得）：
  - `biophilia, the inborn affinity human beings have for other forms of life`（词典释义内嵌例句）

### 2.3 `characterise`

- **库内句子**：`Critics characterise the film as a careful study of isolation rather than a thriller.`
- **该句是否在页面上**：**否**
- **Cambridge 实际例句**（抓取所得）：
  - `Bright colours and bold strokes characterize his early paintings.`
  - `In her essay, she characterizes the whole era as a period of radical change.`
  - `The current system is characterized by obsolete technology.`
  - `She characterized the novel as wordy in places but very funny.`

### 2.4 `accessibility`

- **库内句子**：`The new library was praised for its accessibility to readers with visual impairments.`
- **该句是否在页面上**：**否**
- **Cambridge 实际例句**（抓取所得）：
  - `Two new roads are being built to increase accessibility to the town centre.`
  - `The accessibility of online information is an important consideration.`
  - `The theater offers full wheelchair accessibility.`
  - `We carried out a full audit of the office building's accessibility.`

### 2.5 `adequate`

- **库内句子**：`The report concluded that current funding was not adequate to maintain the service through winter.`
- **该句是否在页面上**：**否**
- **Cambridge 实际例句**（抓取所得）：
  - `It's not a big salary but it's adequate for our needs.`
  - `The council's provision for the elderly is barely adequate (= is not enough)`
  - `Have we got adequate food for 20 guests?`
  - `I didn't have adequate time to prepare.`

### 2.6 `ambiguous`

- **库内句子**：`Many companies are appealing against the ruling, because the wording is ambiguous.`
- **该句是否在页面上**：**否**
- **Cambridge 实际例句**（抓取所得）：
  - `His reply to my question was somewhat ambiguous.`
  - `The wording of the agreement is ambiguous.`
  - `The government has been ambiguous on this issue.`
  - `The movie's ending is ambiguous.`

> 抽样 6/22 全部为「否」。未逐条抓取剩余 16 条的原因见 §4「范围说明」。

## 3. 修正方案（本次执行）

| 字段 | 改前 | 改后 |
| --- | --- | --- |
| `source` | `Cambridge Dictionary · <lemma>` | `构造参考 · <lemma>` |
| `url` | `https://dictionary.cambridge.org/...` | `null`（置空） |
| `source_type` | `reference` | **不动** |
| `note` | 原值 | 追加「自撰教学例句，非词典原文」 |

**为什么 `url` 置空而不是改标**：Cambridge 词条页**不是这句的出处**。保留链接会继续
暗示"句子来自这里"。任务说明给了两个选项（置空 / 改标为「词条参考页（非例句出处）」），
本次取**置空** —— 最不容易被后续读者误读；若将来需要"该词在 Cambridge 有词条"这一事实，
它属于独立的「词典参考」字段，不该塞在例句的 `url` 里。

**为什么 `source_type` 不动**：全库 `source_type` 只有
`press` / `reference` / `institution` / `academic` / `quote` / `media` 六类，**没有「自撰」这一类**。
新增 `constructed` 取值是独立的结构性问题（也是"UI 无法可靠区分来源"的根因），
涉及卡面设计与迁移，**不在本次范围**。本次只改 `source` / `url` / 备注三个字段。

**为什么 `note` 要写这句**：防止后续批处理再次把这批句子当成"词典原文/真实语料"。
`note` 是人工可读的显式声明，比 `source_type` 更直接。

## 4. 范围说明（刻意保守）

- **只改这 22 条**：判据是 `examples[0].source ILIKE '%Cambridge%'`（实测 22 条，无其它命中）。
- **不动 `verified.checked` / `assertions_avoided`**：那是产线自检记录，属于历史事实，
  改了反而破坏审计链。
- **不动主句之外的字段**：`translation` / `exam` 三层 / `anchor` / `modified` 原样保留
  —— 本次纠正的是**来源标注**，不是句子本身（句子作为教学句仍然可用）。
- **未逐条抓取剩余 16 条**：判据同源（同一批试点产出、同一模板 `Cambridge Dictionary · <lemma>`、
  同一 `verified.assertions_avoided` 声明），且 6 条抽样的命中率为 0/6。逐条抓取 22 个页面
  对本修正的结论没有增量信息；抽样的作用是**验证判据可靠**，不是穷举。
- **「待网页核验」尾巴**：另有 81 条 `real_usage` 的 `source` 带「待网页核验」字样，
  与本次问题无关，**不清理**（独立事项）。

## 5. 22 条明细（改前快照）

| # | slug | 改前 source | 改前 url | 库内正文 |
| --- | --- | --- | --- | --- |
| 1 | accessibility | Cambridge Dictionary · accessibility | dictionary.cambridge.org/dictionary/english/accessibility | The new library was praised for its accessibility to readers with visual impairments. |
| 2 | accord | Cambridge Dictionary · in accord with someone/something | dictionary.cambridge.org/dictionary/english/in-accord-with | These findings are in accord with data on healthy adults previously reported in similar studies. |
| 3 | accuse | Cambridge Dictionary · accuse | dictionary.cambridge.org/dictionary/english/accuse | The opposition party accused the minister of hiding the full cost of the project from parliament. |
| 4 | adequate | Cambridge Dictionary · adequate | dictionary.cambridge.org/dictionary/english/adequate | The report concluded that current funding was not adequate to maintain the service through winter. |
| 5 | ambiguous | Cambridge Dictionary · ambiguous (Business English) | dictionary.cambridge.org/dictionary/english/ambiguous | Many companies are appealing against the ruling, because the wording is ambiguous. |
| 6 | archaeological | Cambridge Dictionary · archaeological | dictionary.cambridge.org/dictionary/english/archaeological | Archaeological evidence from the cave suggests humans lived there more than forty thousand years ago. |
| 7 | archaeologist | Cambridge Dictionary · archaeologist | dictionary.cambridge.org/dictionary/english/archaeologist | The archaeologist spent three field seasons mapping the ruined settlement on the ridge. |
| 8 | assassinate | Cambridge Dictionary · assassinate | dictionary.cambridge.org/dictionary/english/assassinate | In the novel, a rival faction plots to assassinate the elected governor before the treaty is signed. |
| 9 | assertion | Cambridge Dictionary · assertion | dictionary.cambridge.org/dictionary/english/assertion | Her central assertion was that the policy had widened inequality rather than reduced it. |
| 10 | assume | Cambridge Dictionary · assume | dictionary.cambridge.org/dictionary/english/assume | We should not assume that lower prices always mean lower quality. |
| 11 | biophilia | Cambridge Dictionary · biophilia | dictionary.cambridge.org/dictionary/english/biophilia | Urban planners increasingly cite biophilia when arguing for more green space in cities. |
| 12 | catalogue | Cambridge Dictionary · catalogue | dictionary.cambridge.org/dictionary/english/catalogue | The museum has begun to catalogue its stored paintings so researchers can find them online. |
| 13 | characterise | Cambridge Dictionary · characterise | dictionary.cambridge.org/dictionary/english/characterise | Critics characterise the film as a careful study of isolation rather than a thriller. |
| 14 | civilisation | Cambridge Dictionary · civilisation | dictionary.cambridge.org/dictionary/english/civilisation | Trade and writing are often seen as the two marks that define an early civilisation. |
| 15 | congratulate | Cambridge Dictionary · congratulate | dictionary.cambridge.org/dictionary/english/congratulate | The coach congratulated the team on reaching the final in its first season. |
| 16 | emphasise | Cambridge Dictionary · emphasise | dictionary.cambridge.org/dictionary/english/emphasise | The guidelines emphasise that rest is as important as training for young athletes. |
| 17 | endeavour | Cambridge Dictionary · endeavour | dictionary.cambridge.org/dictionary/english/endeavour | Every endeavour to reduce waste in the office began with a simple sorting rule. |
| 18 | fertilise | Cambridge Dictionary · fertilise | dictionary.cambridge.org/dictionary/english/fertilise | Farmers fertilise the field in spring so the crop grows well before the dry month. |
| 19 | figure | Cambridge Dictionary · figure | dictionary.cambridge.org/dictionary/english/figure | She became a leading figure in the movement to protect coastal wetlands. |
| 20 | futurologist | Cambridge Dictionary · futurologist | dictionary.cambridge.org/dictionary/english/futurologist | The futurologist warned that automation would reshape work faster than schools could adapt. |
| 21 | geneticist | Cambridge Dictionary · geneticist | dictionary.cambridge.org/dictionary/english/geneticist | The geneticist explained how a single change in DNA can alter a whole metabolic pathway. |
| 22 | geocentric | Cambridge Dictionary · geocentric | dictionary.cambridge.org/dictionary/english/geocentric | Medieval maps often reflected a geocentric view in which Earth sat at the centre of all things. |

**改前快照来源**（可复验）：

```sql
SELECT w.slug, w.lemma, w.examples->0->>'source', w.examples->0->>'url',
       w.examples->0->>'source_type', w.examples->0->>'text'
FROM words w
WHERE w.examples->0->>'source' ILIKE '%Cambridge%'
ORDER BY w.slug;
```

## 6. 可用的替代真实语料（供后续任务参考，本次不执行）

这 22 条里有 **11 条**在 `F:\dev\vocab-ob\_returns\eu10_pilot\real_candidates.json`
（117 条 Tatoeba 真实句）中本来就有可用的真实句子，例如：

| slug | 可替代的真实句 | 来源 |
| --- | --- | --- |
| accuse | `They wrongly accused me.` | Tatoeba #13855315（CC BY 2.0 FR） |
| adequate | `The connection must be adequate.` | Tatoeba #11166602（CC BY 2.0 FR） |
| archaeologist | `Mary is an archaeologist.` | Tatoeba #12417106（CC BY 2.0 FR） |
| assassinate | `Tom assassinated the king.` | Tatoeba #12643261（CC BY 2.0 FR） |
| catalogue | `This catalogue is obsolete.` | Tatoeba #11218457（CC BY 2.0 FR） |
| characterise | `His painting is characterised by the use of complex textures.` | Tatoeba #12912983（CC BY 2.0 FR） |

**本次不做替换**：任务 3 的验收是"如实标注"，不是"换句子"。替换主句会牵动
`exam` 三层切分（基于原句构造）与 `content_hash` 的 L2 层，属独立改造。

## 7. 免责

本清单是**数据事实与来源归属的核对**，不是法律意见。具体法律判断（包括对第三方
来源的归属是否需要额外许可）请法务确认。
