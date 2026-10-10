---
id: gap-goal-034-exit-conditions-section
title: GOAL-034 缺 `## 退出条件` 节：提议补写退出条件小节（标题四句与 `## 目标` 六条映射到在域
  AC-318…AC-322），使充分性判定不再被机械短路
status: needs-human
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

选型 (b)：修订 GOAL-034 的**退出条件文本**——在 `goals/GOAL-034-live-voice-…md` 正文补写一个 `## 退出条件` 小节。**不新增 AC，不改任何 GOAL/AC 状态。**

**未被覆盖的部分（逐字引用）**：该目标正文**完全没有**退出条件——`grep -n '退出条件' goals/GOAL-034-live-voice-*.md` 为 **0 命中**，连行内句也没有（与 GOAL-001 / GOAL-003 不同：那两者至少把退出条件写成了一行散文，可直接「提升为小节」）。退出条件只能落在目标标题上，逐字为：

> Live Voice 分段中继：CloudCLI 端切分语音、带可读会话上下文、空闲换会话——每句成本与连接时长无关

该标题的四个分句与在域 AC 一一对应：

- 「CloudCLI 端切分语音」→ **AC-319**（浏览器端 SegmentVAD relay 档、只上送语音段、服务端按段提交、旧连续协议兼容）
- 「带可读会话上下文」→ **AC-320**（与前端折叠同源取用户可读行、按字符预算从最新往回组装、提示词与模板热读取）
- 「空闲换会话」→ **AC-321**（预热待命会话、空闲无感切换、读入不随响应序号增长）
- 「每句成本与连接时长无关」→ **AC-318**（P0 实测成本与结论、60 句读入斜率、不限时长）与 **AC-322**（P4 成本回放线与账单对账）

目标正文 `## 目标` 的六条同样逐条落地：1 成本与连接时长无关 → AC-318/321/322；2 只把语音发给上游 → AC-319；3 带会话上下文 → AC-320；4 长连接可持续 → AC-321；5 可观测、可调参、可对账 → AC-320（热读取）/ AC-322（对账）；6 语义端点 → AC-318（S4 探针）。`## 分期与 AC` 表把 P0–P4 显式挂到 AC-318…AC-322。

**为何现有 AC 集被判 `insufficient`（是机制，不是内容）**：充分性的机械层要求目标正文含**非空的 `## 退出条件` 小节**。插件 `plugin/scripts/goal-driver.ts` 的 `exitConditionsText()`（经 `extractSections(body, "退出条件")`，逐字标题、不允许后缀）与 `hasExitConditions()` 取出该节文本，而入口 `goalSufficiencyVerdict()` 的第一条即：

```
if (!hasExitConditions(String(goal.body ?? ""))) return "insufficient";
```

它在语义判定入口（返回 `not-evaluated`、随后才咨询 LLM 判官）**之前**就短路返回。GOAL-034 正文的六个 `## ` 标题是 背景 / 目标 / 非目标 / 分期与 AC / 成本与证据 / 协调，**没有「退出条件」**，故 `hasExitConditions` 为 false，verdict 恒为 `insufficient`，**语义 judge 从未被咨询**。证据：`.quay/goal-round.jsonl` 最近五轮（round 2890–2894，ts 2026-10-10T01:44:30Z–02:09:04Z）GOAL-034 的 `goal-sufficiency` verdict 恒为 `insufficient`，reason 恒为 `sufficiency=insufficient（在域 AC 4 条）`——reason 中不含任何语义 judge 产物，与上述机械短路一致。同轮 `goal-ring` 的 `staleness.notEvaluated=["GOAL-034"]`。`.quay/goal-sufficiency-followup.json` 记 `GOAL-034.since=2026-10-10T02:09:04.137Z`、`filedAt=null`（本任务为该目标的**首次**跟进立案）。

**内容上并无缺口**：AC-318（P0 真实上游验证：S1–S6 六项探针 + Σ spendCny ≤ ¥0.05 + 与 SPEC「P0 结论」逐条对账 + 未 supported 项写降级路径）、AC-319（只发语音 / 不吃字 CER ≤ +1.0% / 合并 / 幂等 / 旧协议兼容 + 各自取假形态必红）、AC-320（规则同源 / 字符预算硬上限 / 如实标注 / 热修改 / 在线校准 + 取假形态必红）、AC-321（读入不增长 / 换会话安全 / 失败降级 / 不限时长 / 与重连复用 + 取假形态必红）逐条覆盖标题四句与 `## 目标` 六条。**缺的只是「把退出条件写成一个机械层能解析出来的非空小节」这一结构**，所以本提案不新增 AC。

**同类先例（同一配方，已两次落地）**：`gap-goal-001-exit-conditions-section`（status=done）把 GOAL-001 的行内退出条件句提升为 `## 退出条件` 小节，下一轮 round log 中该目标 verdict 由机械 `insufficient` 变为语义 judge 的 `covered`；`gap-goal-003-exit-conditions-section`（status=done）对 GOAL-003 做了同样的事，round 753 起 verdict 由机械形态变为语义 `covered`。

**与先例的差异（如实登记）**：GOAL-001/003 有行内退出条件句可「提升」；GOAL-034 **连行内句都没有**，故本提案是**补写**而非「提升」，建议文本由标题四句 + `## 目标` 六条**生成**，不抄自任何既有句。

**影响面**：只要退出条件仍缺失，verdict 恒为机械 `insufficient`，该目标永远卡在 `active`，且每个 round 都会重复一条无人消费的 verdict。补写退出条件是把判定交回语义 judge 的唯一开关。

<!-- dedup-ref -->相关但不同：`gap-voice-segmented-relay-*`、`gap-voice-realtime-context-pack-and-hot-settings`、`gap-voice-realtime-test-files-restore-quay-test-script-pins` 等是 GOAL-034 的**实现**任务，机制是改代码；本任务的机制是**修订目标退出条件文本**，产出只是一处文档小节，与它们不重复、不互为前置（granularity 工具对本文 Touches 报 `peers[]` / `mentions[]` 均为空）。`gap-goal-001-exit-conditions-section` / `gap-goal-003-exit-conditions-section` 是同一配方的**先例**（均已 done），非本次的重复。

**建议的修订文本**（在 `goals/GOAL-034-live-voice-…md` 正文末尾新增下列小节；房屋风格同 GOAL-002 / GOAL-016：小节标题 + 逐条 AC 编号 + 该条的实质判据）：

## 退出条件

- AC-318 P0 真实上游验证：手动音频提交、空闲上游会话切换、可读上下文注入已先于语义端点/历史控制/缓存验证；`RESULT.json` 的 S1–S6 各有 verdict/evidence/spendCny/notes，优先级顺序可审计，Σ spendCny ≤ ¥0.05，结论与 `docs/proposals/voice-realtime-segmented-relay-SPEC.md`「P0 结论」逐条对应；未 supported 的项写明降级路径。
- AC-319 P1 切分与协议：浏览器端只上送语音段（上游收到音频 ≤ 25 秒）、不吃字（CER 增量 ≤ +1.0%）、合并正确、重放幂等，旧连续 `audio` 帧协议行为不变。
- AC-320 P2 上下文包与热修改：上下文包与前端的用户可读行折叠规则同源、按字符预算从最新往回组装、如实标注；提示词与模板每次新连接热读取，改文件无需重启；估计与实测 token 差超 20% 记告警。
- AC-321 P3 上游会话池：预热待命会话、空闲时无感切换（额外延迟 ≤ 300 ms），每次响应读入不随响应序号增长，60 分钟回放不因时长或总额终止。
- AC-322 P4 灰度与对账：分段模式用开关灰度、缺省仍连续；成本回放测试线与一次真实运行账单逐位对账。
- 或由人裁定放宽 / 取消其中任一条。

（AC-322 现为 `draft`，不在首轮「在域 AC 4 条」之列；把它一并写进退出条件是刻意为之——退出条件描述**目标收敛后的形态**，P4 是该目标 `## 分期与 AC` 表里的一期，漏掉它会重造同一条死锁。）

## AC
- [ ] `grep -c '^## 退出条件' goals/GOAL-034-live-voice-*.md` 输出 1，且该小节去空白后字符数 ≥ 40 —— 该行只能由被授权的 goal 写入路径落地（待外部）
- [ ] 人（yale）已在本任务下裁定是否采纳本修订（采纳 / 改措辞 / 不采纳并另立 AC），裁定写进本任务 Resolution 小节 —— 该行只能由人 yale 写入（待外部）
- [ ] 修订后下一轮 `.quay/goal-round.jsonl` 中 GOAL-034 最新 `goal-sufficiency` verdict 的 reason 不再是纯机械短路形态（不再是 `sufficiency=insufficient（在域 AC N 条）` 这一类），而是语义 judge 给出的 covered / insufficient 结论 —— 该行须在修订合入并跑过一轮 driver 之后才读得到（待外部）

## DoD
人工授权后，由**被授权的 goal 写入路径**（而非本 agent）真实修改 `goals/GOAL-034-live-voice-…md`：新增 `## 退出条件` 小节；并在其后的**真实 round log** 中观察到 GOAL-034 的 sufficiency verdict 不再恒为机械 `insufficient`（语义 judge 被实际咨询并给出结论）。仅有文本改动而无后续 verdict 观察不算完成。本任务由跟进 agent 只提议：不改 `goals/*.md`，不改任何 GOAL/AC 状态。

## Touches
- goals/GOAL-034-live-voice-分段中继-cloudcli-端切分语音-带可读会话上下文-空闲换会话-每句成本与连接时长无关.md
- tasks/gap-goal-034-exit-conditions-section.md
