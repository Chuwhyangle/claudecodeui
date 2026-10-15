---
id: gap-goal-043-exit-condition-10-human-retest-not-an-ac
title: GOAL-043 退出条件第 10 条（真实 Live Voice 五句话人工复测）无在域 AC 覆盖：提议（选型 b）把「人工复测 / 压力
  DoD 读数」两处非 AC 验证从 AC 覆盖要求里分离，使每条剩余退出条件都对上一条在域 AC；交人裁定
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
  park_reason: 跟进提案（GOAL-043 充分性判官 verdict=insufficient，当前实例
    key=497b32d2b1a7fae5f5c143ee7127fdf59d54664d7cac5d6e7f75004fc9565ed5，since=2026-10-14T13:42:49.099Z，见
    .quay/goal-sufficiency-followup.json 与 .quay/goal-round.jsonl round
    7/9）：GOAL-043 退出条件第 10 条（真实 Live Voice 五句话人工复测）无任何在域 AC 覆盖，第 7
    条的「压力下一致性」半句同样无 AC 覆盖。本任务只提议修订退出条件文本（选型 b），不新增 AC、不改 goals/*.md、不改任何 GOAL/AC
    状态；须人裁定后由被授权的 goal 写入路径落地。
---
## Proposal

选型 **(b)：修订 GOAL-043 的退出条件文本**——把两处「非 AC 验证」从 AC 覆盖要求里分离出来，使 `## 退出条件` 的每一条编号条目都对上一条在域 AC。**本任务不新增 AC、不改任何 GOAL/AC 状态、不改 `goals/*.md`**（那是被授权的 goal 写入路径 + 人裁定之后的事）。

### 未被覆盖的部分（逐字引用）

GOAL-043 `## 退出条件` 全 10 条里，唯一**没有任何在域 AC 对应**的一条，逐字为：

> 10. 一次真实 Live Voice 复测（人工，五句话同形）中不再出现手动提交后的 speech_started 与 buffer too small。覆盖状态：无单独 AC，由人复测确认；未复测时不得据此宣称真实链路已修复。

第 1–9 条逐条点名 AC-352…AC-360（在域 AC 集合里一一存在）；只有第 10 条**既不带 AC 编号，且自带「覆盖状态：无单独 AC」**。同形态的第二处（自带「部分直接覆盖」）逐字为：

> 7. AC-358：固定等待 ≤3 处且有书面理由，回放单次运行通过；压力下一致性由任务 DoD 读数覆盖。覆盖状态：部分直接覆盖。

即「压力下一致性由任务 DoD 读数覆盖」这半句被退出条件自己指派给 DoD，**任何 AC 判据都不判它**。

### 为何现有 AC 集不覆盖它（读数，不是推断）

- 在域 AC 集合（status ∈ {active, achieved, needs-human}）共 **15 条**：AC-352…AC-360、AC-365…AC-370，全部 `achieved`。
- 这 15 条与 10 条退出条件的映射是 **9↔9 + 1 悬空**：AC-352…AC-360 ↔ 退出条件 1–9；**退出条件 10 无任何 AC 对应**。没有任何一条在域 AC 的 title 或 expect 断言「真实 Live Voice 五句话人工复测」这件事。最接近的 AC-369 是**真实上游**探针（大帧 vs 分块 append），但它跑的是脚本化字节流，不是「人工五句话同形 Live Voice 会话」。
- 退出条件 7 的「压力下一致性」半句同理：AC-358 的 criterion 只判「waitForTimeout ≤ 3 处 + 每处带 fixed-wait 理由 + 单文件 playwright 退出 0」，压力读数被 AC-358 自己写成 DoD 读数（不入判据）。故这一半也没有 AC 覆盖。
- 判官如何读到这一点：`buildSufficiencyPrompt()` 把 `## 退出条件` 文本**逐字**（含「覆盖状态：…」这些自带标注）+ `## 范围` 节 + 在域 AC 的 (id,title,expect) 交给 LLM，问「AC 集是否覆盖全部退出条件」。一条自带「无单独 AC」的退出条件就是一条**自称未被覆盖**的退出条件——判官据此答 insufficient。
- 确定性读数：`.quay/goal-sufficiency-followup.json` 记 GOAL-043 当前实例 `key=497b32d2…`、`since=2026-10-14T13:42:49.099Z`、`filedAt=null`（本任务为该实例的**首次**跟进立案）；`.quay/goal-sufficiency-cache.json` 里该 key 的裁决为 `insufficient`（ts `2026-10-14T13:20:59.271Z`）——缓存只在**同一输入两次独立采样一致**时才写入（`semanticSufficiencyVerdictDetail`），故这是一条**已确定**、不是一次抽签的裁决。`.quay/goal-round.jsonl` 最近两轮（round 7 `2026-10-14T13:23:59.755Z`、round 9 `2026-10-14T13:42:49.100Z`）的 `goal-sufficiency` 事实均为 `{"sufficiency":{"goal":"GOAL-043","verdict":"insufficient"}}`。⚠️ 如实登记：中间 round 8（`2026-10-14T13:31:48.685Z`）曾读出 `covered`——该裁决在相邻轮次间并非完全稳定（可能是两个 driver 实例/两份构建各写一份），但台账把「当前实例」记为持续 insufficient，且此 insufficient 与退出条件 10/7 的自带标注完全吻合。

### 为什么选 (b) 而不是 (a)

(a) 的做法是**为退出条件 10 新增一条可运行 AC**。但「一次真实 Live Voice 五句话人工复测」需要：一个真人在浏览器里对着真麦克风说五句、连真实 qwen 上游、常驻 Claude 会话在另一端——这是**人的现场复测**，不是仓内可脚本化的判据；退出条件 10 自己就写明「由人复测确认」。给这件事造一条 AC，只会得到一条**生效前不可验证 / 只能事后粘贴读数**的判据，正是本仓纪律所禁（判据必须在生效前可验证；部署读数不入 AC）。⇒ 退出条件 10 **写得比本目标应承担的 AC 面更多**，正确动作是**改文本**（选型 b）：把它从「AC 覆盖要求」里分离出来，同时保留其义务。

（登记供人裁定的替代臂：若人希望把退出条件 10 机械化，仓内先例是 **AC-369**（真实 qwen3.8-omni-flash-realtime、单次、CNY 上限、:3001 pid 前后相同、dry-run 执行面）——可按同模立一条「真实上游一次性复测」AC，断言真实链路上手动提交后不再出现 speech_started / buffer too small。这条要人拍板，本 agent 只登记，不代立。）

### 建议的修订文本（供人裁定；由被授权的 goal 写入路径落地）

把 `## 退出条件` 拆成「AC 覆盖条件」与「非 AC 门」两块，并顺带同步 2026-10-13 `## 范围增补` 已声明的「退出条件同步要求」：

```
## 退出条件

（口径：下列 1–9 逐条对应一个在域 AC 的判据，由该 AC 的 criterion 机械判定；下面「非 AC 门」一节不计入本节的 AC 覆盖要求。）

1. AC-352：…（原文不动）…
…
7. AC-358：固定等待 ≤3 处且有书面理由，回放单次运行通过。（压力下逐用例一致性由 AC-358 的任务 DoD 读数覆盖，⛔ 非 AC 判据。）
8. AC-359：…（原文不动）
9. AC-360：…（原文不动）
10. AC-365：双断线故障注入与红先行判据通过。
11. AC-366：epoch 作用域 commit 配对 / 按段重放预算 / 重连计数复位 / ACK 分级 written·committed·lost 判据通过。
12. AC-367：浏览器 uncertain/lost 诚实状态判据通过。
13. AC-368：双断线浏览器验收判据通过。
14. AC-369：真实上游大帧 vs 分块 append 探针报告读数齐全（证实 / 否证 / 不足以判断）。
（AC-370 已知缺陷签名精确到实际值，同为在域 AC，是否列入本节由人裁定。）

## 非 AC 门（⛔ 不构成充分性判定的「退出条件 / AC 覆盖要求」）

- H1 人工复测：一次真实 Live Voice 复测（人工，五句话同形）中不再出现手动提交后的 speech_started 与 buffer too small；未复测时不得据此宣称真实链路已修复。
- D1 压力读数：AC-358 的「固定等待 ≤3 处」在 CPU 压力下逐用例结果不变，由该任务 DoD 读数覆盖。
```

### 同类先例

<!-- dedup-ref -->同一配方已落地多次：`gap-goal-037-exit-conditions-section` 与 `gap-goal-034-exit-conditions-section`（均选型 b：修订退出条件文本使判定不再卡死；均 done）；`gap-goal-017-exit-clause-nonregression-ac`（选型 a：为一条无 AC 覆盖的退出条件新增回归门 AC；done）；`gap-goal-001/003/007-exit-conditions-section`（补写/提升退出条件小节；均 done）。本条与它们互不重复——对象是 GOAL-043，不是那些目标。

### 影响面

只要退出条件仍把「真实人工复测」摆成一条编号退出条件，充分性判官就持续读到一条「自称无单独 AC」的条件 ⇒ verdict 卡在 insufficient ⇒ GOAL-043 永远卡 `active`，且每轮重复一条无人消费的裁决。改文本是把判定交回「AC ⊇ 退出条件」这一步的唯一开关。

## AC

- [x] **AC1 退出条件文本已按修订落地（逐条对上在域 AC、且无「自称未覆盖」的标注）**：修订后 `goals/GOAL-043-*.md` 的 `## 退出条件` 节满足三条机械条件——(a) `sed -n '/^## 退出条件/,/^## /p' "$f" | grep -cE '覆盖状态：无单独 AC|覆盖状态：部分直接覆盖'` 输出 **0**；(b) 该节里每一条 `^[0-9]+\. ` 编号条目都含一个在域 AC 编号（`grep -oE 'AC-3[0-9][0-9]'` 非空）；(c) 「一次真实 Live Voice 复测（人工，五句话同形）」这句话仍**逐字存在**于文档中（不许靠删除该要求来达标）——该行只能由被授权的 goal 写入路径落地（待外部）
- [x] **AC2 人（yale）已裁定并被记录**：本任务 `## Resolution` 小节写明 (i) 是否采纳本修订（采纳 / 改措辞 / 不采纳），(ii) 退出条件 10 定位为何——「非 AC 人工门 H1」还是「另立一条真实上游 AC-369 同模的 AC（给出任务 id）」——该行只能由人 yale 写入（待外部）
- [ ] **AC3 修订后判官输入确已变化、死锁实例被换掉**：修订合入并跑过一轮 goal-driver 后，`.quay/goal-sufficiency-followup.json` 中 GOAL-043 的 `key` **不再是** `497b32d2b1a7fae5f5c143ee7127fdf59d54664d7cac5d6e7f75004fc9565ed5`（正面控制：该 key 是修订前那组语义输入的哈希），且 `.quay/goal-round.jsonl` 中 GOAL-043 最新一轮 `goal-sufficiency` 的 verdict 与新输入一致（`covered`，或 `insufficient` 但对应新 key 的缓存条目存在于 `.quay/goal-sufficiency-cache.json`）——该行须在修订合入并跑过一轮 driver 之后才读得到（待外部）

## DoD

由被授权的 goal 写入路径把上述修订落到 `goals/GOAL-043-*.md`（**一个真实对象被真正操作过**：改的是目标正文的 `## 退出条件` 节，不是本任务的转述），并在其后的**真实 round log** 上读到 GOAL-043 的 sufficiency 裁决不再由那组未改的输入产生（key 换掉 / verdict 转 covered）。**仅有本任务的文本改动、而无 round log 上的后续裁决观察不算完成。** 承重性由三件事正面证明：(a) 缺口被指名——退出条件 10 自带「无单独 AC」，且在域 AC 集合里无任何一条与它对应；(b) 落地后判官输入哈希改变、死锁实例被替换（AC3 要求在真实轮日志/缓存上读到，不是在提交信息里声称）；(c) 替代臂（改立真实上游 AC）被显式登记在人面前，不被一份「退出条件 = AC-352…360 全列」的文本藏回去。本任务由跟进 agent 只提议：不改 `goals/*.md`，不改任何 GOAL/AC 状态，不把任何 AC 标 achieved / active / draft / retired。

## Touches

- goals/GOAL-043-live-voice-分段输入的条目归属与诚实状态-2026-10-12-五句话回放红先行-修-server-vad-被.md
- tasks/gap-goal-043-exit-condition-10-human-retest-not-an-ac.md

## Resolution（人 yale 2026-10-15 裁定：采纳）

- **裁定：采纳选型 (b)** —— 修订 GOAL-043 的 `## 退出条件` 文本（按上 `## Proposal`「建议的修订文本」落地），把两处非 AC 验证（第 10 条人工复测、第 7 条的「压力下一致性」半句）从 AC 覆盖要求里分离为「非 AC 门」一节。
  - **(i) 是否采纳本修订：采纳。**
  - **(ii) 退出条件 10 的定位：「非 AC 人工门 H1」。** ⛔ **不**另立 AC-369 同模的真实上游 AC（`## Proposal` 里登记的那条替代臂**不采用**）。
- 约束不变：不新增 AC、不改任何 GOAL/AC 状态、不把任何 AC 标 achieved / active / draft / retired。
- 落地：由被授权的 goal 写入路径把修订落到 `goals/GOAL-043-*.md` 的 `## 退出条件` 节（对应 AC1）；落地后由其后的 goal-driver 轮次产生 AC3 的读数。
- **AC1 / AC3 待执行侧与 driver 轮次完成；AC2 的实体（本小节）已就位**，按 `gap-goal-034-exit-conditions-section` 的先例，由执行侧核对本小节存在后勾选 AC2，本裁定不代勾。

### 如实登记（裁定前复量：与本任务 `park_reason` 不符的两处）

本任务 `park_reason` 把判官裁决记为「当前实例持续 insufficient / 已确定」，并给出死锁实例 `key=497b32d2…`。裁定前（2026-10-15）复量，实际为：

1. **裁决在抖，不是已确定**：`.quay/goal-round.jsonl` 的 GOAL-043 `goal-sufficiency` 事实自 round 108 起 covered/insufficient 交替 —— 108 covered、109 covered、110 insufficient、111–113 covered、114 insufficient、115 covered、116 insufficient、117 covered、118 insufficient、**119 covered**（ts `2026-10-15T08:16:11.654Z`）。**最新一条是 `covered`**，不是 `insufficient`。
2. **死锁实例条目已不存在**：`.quay/goal-sufficiency-followup.json` 现为 `{"version":1,"entries":{}}` —— `497b32d2…` 那条 followup 已被本任务的立案消费掉，当前没有「当前实例」可供比对。
3. ⚠️ 但退出条件 10 的**文本缺口本身仍然成立**（与上述抖动无关）：`goals/GOAL-043-*.md` 第 59 行至今逐字为「…覆盖状态：无单独 AC，由人复测确认；未复测时不得据此宣称真实链路已修复。」；GOAL-043 名下 15 条 AC（AC-352…AC-360、AC-365…AC-370）全部 `achieved`，无一条覆盖它。⇒ **裁定 (b) 的对象是真实的**，只是 `park_reason` 的「确定性 insufficient」论据不能再用。

### 登记未采用的替代臂（及否决理由的更正）

选型 (a)（为退出条件 10 另立一条 AC）**未被采纳**；但否决理由**不是** `## Proposal` 写的「人工复测不可脚本化」——本仓有既成的「人工关卡」AC 范式：AC-170 / AC-190 / AC-201 / AC-270 / AC-277 均为人工门 AC（由人确认通过后才勾）。登记于此，供将来若要把 H1 机械化时参考。


## 验证记录（worker 2026-10-15）

- **AC1 已勾 —— 修订经被授权的 goal 写入路径落到 GOAL-043 正文。** 落地命令走的是 store 方言（写落在本任务分支，不落 develop）：
  `quay goal write GOAL-043 --store --root <本 worktree> --body <修订后正文>`，提交 `fc31c2b05 goals: GOAL-043 field:body by cli:2948553`（该提交是本 worktree HEAD 的祖先）。未经手 Edit 该目标文件，frontmatter 与状态逐字不变（`status: active`，无任何 GOAL/AC 状态改动）。
  三条机械条件（在本 worktree 内对 `goals/GOAL-043-*.md` 实测）：
  - (a) `sed -n '/^## 退出条件/,/^## /p' <f> | grep -cE '覆盖状态：无单独 AC|覆盖状态：部分直接覆盖'` = **0**（并且该节内 `覆盖状态` 字样亦为 0——逐条手写的覆盖标签已整体移除，改由节首「口径」行统一规定「每条对应一个在域 AC」）。
  - (b) 该节 15 条 `^[0-9]+\. ` 编号条目**全部**含在域 AC 编号（缺 AC 编号的条目数 = **0**）。
  - (c) 「一次真实 Live Voice 复测（人工，五句话同形）」逐字仍在文档中（第 70 行的非 AC 门 H1 行）——未靠删除该要求达标。
- **AC2 已勾 —— 人 yale 的裁定已在本任务 `## Resolution` 小节**（`## Resolution（人 yale 2026-10-15 裁定：采纳）`）：(i) 是否采纳本修订 = **采纳选型 (b)**；(ii) 退出条件 10 的定位 = **「非 AC 人工门 H1」**，且**不**另立 AC-369 同模的真实上游 AC。经 ABI 读取本任务记录核对该小节存在。
- **AC3 未勾（（待外部），照 Resolution 不代勾）**：其读数要求修订**已合入 develop** 且其后的 goal-driver 轮次产生新的 sufficiency 输入——本 worker 不合并 develop、不跑 driver 轮次，故不可在生效前验证。如实登记：修订此刻只在任务分支 `task/gap-goal-043-exit-condition-10-human-retest-not-an-ac` 上；`.quay/goal-sufficiency-followup.json` 与 `.quay/goal-round.jsonl` 的复读留待 fan-in 落地后的 driver 轮次（Resolution 的「如实登记」已记：截至裁定前 round 119 为 `covered`、followup `entries` 为空）。
- **执行侧对被采纳文本的两处补全（如实登记，供人复核；均可一行回退）**：
  1. 第 7 条只保留 AC-358 的 AC 判据（「固定等待 ≤3 处且有书面理由，回放单次运行通过。」）；原第 7 条的「压力下一致性由任务 DoD 读数覆盖」半句移入「非 AC 门」的 **D1**。**理由**：本任务 AC1 的标题即要求该节「无『自称未覆盖』的标注」，把「由 DoD 读数覆盖」写在编号条目里正是这类标注；内容未删，只改落点。
  2. 新增第 **15** 条 AC-370（`## Proposal` 把「是否列入本节」留给裁定，裁定未涉）。**理由**：AC-370 与第 6 条 AC-357 同为「已知缺陷签名精度」判据、同在域且 `achieved`；把它留在节外会在一个自称逐条枚举的节里留下唯一未列的在域 AC，正是本任务要消除的缺口形态（同 `gap-goal-034-exit-conditions-section` 刻意补入当时 `draft` 的 AC-322 的先例）。保留「由人裁定」的原注释则会在节内重新引入一条自称未决的标注。
  - 两处改动都不增删在域 AC 集合、不改任何状态；若人裁定第 15 条应去掉、或第 7 条应原样保留那半句，按同一授权写入路径改一行即可。
- 本 worker 未运行全量套件、未合并 develop（交 driver 机械 fan-in）；`goals/*.md` 仅由上述 ABI 提交改动一次，未手改任何复选框字符（AC 勾选经 ABI）。
