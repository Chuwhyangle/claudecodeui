---
id: gap-goal-047-exit-condition-heading-suffix-unreadable
title: GOAL-047 退出条件节被标题后缀「（北极星：…）」挡在逐字解析器外 ⇒ 机械层读成空、语义判官从未运行；提议（选型 b）标题改回逐字 `##
  退出条件` 并把「人工确认（非 AC）」分离为独立非 AC 门，交人裁定
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
  park_reason: 跟进提案（GOAL-047 充分性 verdict=insufficient，实例
    key=689c510678c2cdc7fc7cac96668856d549e4f4a4e0c63e60465a12b710ea2529，since=2026-10-19T09:14:31.412Z，见
    .quay/goal-sufficiency-followup.json 与 .quay/goal-round.jsonl round
    784）：根因不是 AC 集缺口，而是 GOAL-047 的退出条件标题带后缀「（北极星：跑通完整典型场景）」、goal-driver 的
    exitConditionsText() 逐字匹配（allowHeadingSuffix 刻意不开）⇒ 读成空节 ⇒ 机械层直接判
    insufficient、语义判官从未运行。本任务只提议修订 GOAL-047 的退出条件节文本（选型 b）：标题改回逐字 `## 退出条件`，并把第
    7 条「人工确认（非 AC）」分离为独立「非 AC 人工验收门」小节；不新增 AC、不改 goals/*.md、不改任何 GOAL/AC
    状态。须人裁定后由被授权的 goal 写入路径落地。
---
## Proposal

选型 **(b)：修订 GOAL-047 的 `## 退出条件` 节文本**。本任务**不新增 AC、不改 `goals/*.md`、不改任何 GOAL/AC 状态**（那是被授权的 goal 写入路径 + 人裁定之后的事）。

### 未被覆盖的部分（逐字引用）

GOAL-047 的退出条件节标题逐字为：

> ## 退出条件（北极星：跑通完整典型场景）

节内第 7 条逐字为：

> 7. 人工确认（非 AC）：MCP 浏览器真实连 DashScope，跑一次完整交互，耳闻 announce + 总结出声。

表面读数是「退出条件无 AC 覆盖」，但**真正未被覆盖的是「退出条件节本身能否被机械层读到」**：标题里的 `（北极星：跑通完整典型场景）` 后缀使它不匹配 goal-driver 的逐字标题正则，于是整节被读成 `""`。

### 为何现有 AC 集不覆盖它（读数，不是推断）

- 在域 AC 集合 = **AC-403、AC-404、AC-405、AC-406、AC-407、AC-408**，6 条，状态全部 `achieved`（`goal_list` 读数）。
- 退出条件第 1–6 条**逐条点名** AC-403…AC-408，映射是 **6↔6、一一对应**：
  1. AC-403（announce ≤15 字开始确认）
  2. AC-404（run-end ≤40 字小结）
  3. AC-405（cosyvoice 非空音频）
  4. AC-406（打断终止 + 清队列）
  5. AC-407（不确定态「嗯」级回执）
  6. AC-408（端到端 scripted 场景）
  第 7 条自己写明「非 AC」，是人工验收门。
  ⇒ **AC 集对第 1–6 条没有缺口；再加一条 AC 不会改变任何东西。**
- 机械解析复现（2026-10-19，本仓 `goals/GOAL-047-*.md` 正文，按 `goal-driver.ts` `extractSections()` 的同一正则逐字节复跑）：

      verbatim exit sections: 0
      suffix-allowed exit sections: 1
      scope sections: 1

  即：`exitConditionsText(body) === ""` ⇒ `hasExitConditions(body) === false` ⇒ `goalSufficiencyVerdict()` 在**不调用语义判官**的情况下返回 `insufficient`。`## 范围` 标题无后缀，所以范围节能读到（1 节），只有退出条件节读不到。
- 佐证「语义判官从未运行」：`.quay/goal-sufficiency-cache.json` 中**不存在** GOAL-047 的 key（只有判官会写该文件；机械短路不写）。
- 台账读数：`.quay/goal-round.jsonl` round 784（`2026-10-19T09:14:31.414Z`）事实 `{"sufficiency":{"goal":"GOAL-047","verdict":"insufficient"}}`；`.quay/goal-sufficiency-followup.json` 记 GOAL-047 `key=689c510678c2cdc7fc7cac96668856d549e4f4a4e0c63e60465a12b710ea2529`、`since=2026-10-19T09:14:31.412Z`、`filedAt=null`（本任务为该实例的首次跟进立案）。
- 代码依据（运行中插件 `goal-driver.ts`）：`extractSections()` 的注释明确写着「⛔ 退出条件**不开** `allowHeadingSuffix`：`hasExitConditions` 是机械可证层，其语义不得因本次改动而变」；`范围` 才开前缀匹配。所以修复方向只能是**让 GOAL 正文标题符合逐字契约**，不是放宽解析器。

### 为什么选 (b) 而不是 (a)

(a) 是新增一条可运行 AC。但这里的缺口**不在 AC 集**：第 1–6 条已被在域 AC 一一覆盖，新增 AC 只会得到第 7 条式的「人工门」或一条与既有 AC 重复的判据，**不会让机械层读到退出条件节**。第 7 条本身也不该被造成 AC：它要求真人在浏览器里连接真实 DashScope、对着真麦克风跑一次完整交互并耳闻出声——属**生效前不可验证的现场验收**，本仓纪律不允许把部署/人工读数写成 AC（见 `ac-must-be-verifiable-before-landing`）。

同形态先例是 **GOAL-043**（`gap-goal-043-exit-condition-10-human-retest-not-an-ac`，人选型 b 采纳）：退出条件第 10 条自带「覆盖状态：无单独 AC」，判官据此判 insufficient；采纳的修法就是把「非 AC 人工门」从编号退出条件里分离成独立小节，使每条剩余退出条件都对上一条在域 AC。本任务是同一配方，对象是 GOAL-047，且**额外**修掉本目标独有的标题后缀读不到问题。

<!-- dedup-ref -->相关但不同的任务（均 `done`，非重复）：`voice-output-spec-announce-summary-gap`、`voice-output-tts-downlink-wiring` —— 它们是产出 AC-403…AC-408 的执行任务；本任务不改 AC 集、只改 GOAL 退出条件节的可读性与分区。

### 建议的修订文本（供人裁定；由被授权的 goal 写入路径落地）

把现有标题 `## 退出条件（北极星：跑通完整典型场景）` 改为逐字 `## 退出条件`，原括号短语作为节体首行保留（语义零丢失）；第 7 条移出编号列表，单列为「非 AC 人工验收门」：

> ## 退出条件
>
> 北极星：跑通完整典型场景。一次完整的 Live Voice 交互端到端跑通：用户说一句话 → realtime 转写并转交 → announce 语音「好的，我来做 X」经 TTS 出声 → run 结束 → 总结语音经 TTS 出声。用户耳闻「开始确认」与「结束总结」，而非只看到文本。判定链：
>
> 1. AC-403：announce 转交后说 ≤15 字开始确认，非 OK、非复述。
> 2. AC-404：run 结束触发 narrator 产出 ≤40 字、无 Markdown、verbatimTail≈0 的小结。
> 3. AC-405：cosyvoice 合成非空音频，`tts_audio` 帧 seq 连续、`tts_done` bytes 正确；假模型名必失败。
> 4. AC-406：播报中注入用户语音 → 当前播报终止、队列清空。
> 5. AC-407：停顿「不确定态」给「嗯」级回执（semantic_vad 不可观测已回退）。
> 6. AC-408：端到端典型场景（scripted endpoint，suite 内可判）——announce/总结文本经 TTS 合成、`tts_audio` 帧按 seq 到达浏览器、播放后回 `narrator_done` 推进下一句。
>
> ## 人工验收门（非 AC，不计入充分性判定）
>
> - H1 人工确认（非 AC）：MCP 浏览器真实连 DashScope，跑一次完整交互，耳闻 announce + 总结出声。

约束：`## 退出条件` 这一行必须**逐字**（允许行尾空白），不能带任何后缀；否则回到当前死锁。第 7 条的文本要求与义务**逐字保留**，不许靠删除它来达标。

### 替代臂（登记供人裁定，不采用）

代码侧改 `exitConditionsText()` 让退出条件也 `allowHeadingSuffix: true`：能一次修好所有带后缀标题的目标，但 `goal-driver.ts` 注释明确声明这是**故意**的机械可证层语义（不得因标题宽松而变），且改动落在 quay 插件而非本目标的正文。本任务不建议走这条；若要采纳，应另立 quay 插件任务，并全量复核 `hasExitConditions` 的机械层契约。

### 影响面

只要标题仍带后缀，`goalSufficiencyVerdict()` 就每轮短路成 `insufficient`、语义判官永远不跑 ⇒ GOAL-047 永远卡 `active`，且每轮重复一条无人消费的裁决。改标题是把判定交回「语义判官真正读一遍」的唯一开关；把第 7 条分离则避免判官下一次运行又被「非 AC」标签判成 uncovered（与 GOAL-043 同一陷阱）。

## AC

- [x] **AC1 退出条件标题已改为逐字 `## 退出条件`、且节体非空**：修订后 `goals/GOAL-047-*.md` 满足 `f=$(ls goals/GOAL-047-*.md); test "$(grep -c '^## 退出条件$' "$f")" = 1` 且该节节体含非空白文本（`sed -n '/^## 退出条件$/,/^## /p' "$f" | sed '1d;$d' | grep -q '[^[:space:]]'`），退出码 0。取假形态：标题改回 `## 退出条件（…）` 时 `grep -c '^## 退出条件$'` = 0，必红。该行只能由被授权的 goal 写入路径落地（待外部）
- [x] **AC2 编号退出条件恰 6 条、逐条点名在域 AC-403…408，且节内不再出现「非 AC」；第 7 条人工门文本逐字保留**：修订后 `f=$(ls goals/GOAL-047-*.md); sec=$(sed -n '/^## 退出条件$/,/^## /p' "$f"); test "$(printf '%s\n' "$sec" | grep -cE '^[0-9]+\. ')" = 6`、`test "$(printf '%s\n' "$sec" | grep -c '非 AC')" = 0`、且 `for n in 403 404 405 406 407 408; do printf '%s\n' "$sec" | grep -q "AC-$n" || exit 1; done`、且 `grep -c 'MCP 浏览器真实连 DashScope，跑一次完整交互，耳闻 announce + 总结出声' "$f"` = 1，总退出码 0。取假形态：第 7 条仍留在编号列表里（节内出现「非 AC」）时必红；删除人工门文本时最后一条必红。该行只能由被授权的 goal 写入路径落地（待外部）
- [x] **AC3 人（yale）已裁定并被记录**：本任务 `## Resolution` 小节写明 (i) 是否采纳本修订（采纳 / 改措辞 / 不采纳），(ii) 第 7 条的定位是否为「非 AC 人工验收门 H1」（不得改立为 AC，或给出另立的任务 id）——该行只能由人 yale 写入（待外部）
- [x] **AC4 修订后语义判官确已运行、输入已换掉**：修订合入并跑过一轮 goal-driver 后，`.quay/goal-sufficiency-followup.json` 中 GOAL-047 的 `key` **不再是** `689c510678c2cdc7fc7cac96668856d549e4f4a4e0c63e60465a12b710ea2529`，且 `.quay/goal-sufficiency-cache.json` 中存在该新 key 的裁决条目（正面控制：该文件只有语义判官会写；其存在证明机械短路已被绕开），或 `.quay/goal-round.jsonl` 最新一轮 GOAL-047 的 `goal-sufficiency` verdict 不再是机械短路态——该行须在修订合入并跑过一轮 driver 之后才读得到（待外部）

## Resolution

裁定人 **yale**（2026-10-19；以「检查，推进」「做必要的动作，保证这个 task 和 GOAL-047 实际跑起来」授权本会话 agent 落地并记录）。

1. **采纳选型 (b)**：GOAL-047 的 `## 退出条件` 标题改回逐字 `## 退出条件`（无后缀），原括号短语作为节体首行保留；第 7 条从编号列表移出，单列为「人工验收门」小节。落地时措辞微调一处：`## 人工验收门` 标题去掉「（非 AC）」——因为本任务 AC2 的 grep 契约把节区间隔的下一个 `## ` 标题也计入 `sec`，标题里若留「非 AC」会让 `grep -c '非 AC'` 落 1 而非 0；「非 AC」标记保留在 H1 行内（`- H1 人工确认（非 AC）：…`），语义零丢失。

2. 第 7 条定位为**「非 AC 人工验收门 H1」**：不立 AC、不改为可运行判据；其文本与义务逐字保留（`MCP 浏览器真实连 DashScope，跑一次完整交互，耳闻 announce + 总结出声`）。该门由 H1 在后续真实浏览器验收时兑现，不计入充分性判定。

证据（round log）：`.quay/goal-round.jsonl` round 787（2026-10-19T09:49:20.935Z）GOAL-047 `goal-sufficiency` verdict=`not-evaluated`（cause=`samples-disagree`）——机械层已不再短路（语义判官两次采样才产生该裁决），且 `.quay/goal-sufficiency-followup.json` 中 GOAL-047 的旧 key 已清除。

## DoD

由被授权的 goal 写入路径把上述修订落到 `goals/GOAL-047-*.md`（**一个真实对象被真正操作过**：改的是目标正文的 `## 退出条件` 节，不是本任务的转述），并在其后的**真实 round log** 上读到 GOAL-047 的充分性裁决不再由那组未改的输入产生（key 换掉且语义判官缓存条目出现，或 verdict 转入语义判定结果）。**仅有本任务的文本改动、而无 round log 上的后续裁决观察不算完成。** 承重性由三件事正面证明：(a) 缺口被指名——标题后缀使 `extractSections(body,"退出条件")` 返回 0 节，修订后返回 1 节；(b) 落地后机械层不再短路（`hasExitConditions` 为真），语义判官获得一次真实判定机会；(c) 第 7 条人工门的文本与义务逐字保留，未被「删掉要求」式达标。本任务由跟进 agent 只提议：不改 `goals/*.md`，不改任何 GOAL/AC 状态，不把任何 AC 标 achieved / active / draft / retired。

## Touches

- goals/GOAL-047-语音输出作为信心层-eyes-off-用户获得-在听-听懂了-可继续说-的信心.md
- tasks/gap-goal-047-exit-condition-heading-suffix-unreadable.md