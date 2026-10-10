---
id: gap-goal-033-ac317-runnable-criterion
title: GOAL-033 充分性恒定 insufficient：退出条件点名的 AC-317 因判据 `-t caption` 命中零测试被判
  vacuous、拒绝激活而不在域（唯一在域 AC-316 逐字排除该要求）；提议把 AC-317 的 criterion 换成可运行判据，交人裁定
status: needs-human
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
  park_reason: 跟进提案（GOAL-033 充分性判官 verdict 恒为 insufficient，见
    .quay/goal-sufficiency-followup.json
    since=2026-10-09T08:33:57.306Z，filedAt=null）：退出条件第 2 条点名的 AC-317 挂在 draft、其
    criterion `-t caption` 命中零测试被 fidelity judge 判 vacuous、拒绝激活 ⇒ 不在域（在域 =
    active|achieved）；唯一在域 AC-316 逐字排除 ASR caption 展示。本任务只提议把 AC-317 的 criterion
    换成可运行判据，须人裁定后由被授权的 goal 写入路径落地。本 agent 不改 goals/*.md、不改任何 GOAL/AC 状态。
goal_ac: AC-317
---
## Proposal

**未被覆盖的部分（逐字引用 —— GOAL-033 `## 退出条件` 的第 2 条，也是当前唯一的欠覆盖条件）：**

> AC-317：见其自身判据（提交时另行定义，依赖 AC-316 落地）。

它承载的是 `## 范围` 第 2 条（也是目标标题「Live Voice UI/UX 改造」里独立成立的一半），逐字：

> **AC-317**（已过设计讨论，暂未实现，依赖 AC-316）：实时 ASR interim/final 文本以用户消息形式展示在 transcript 里，正确处理去重与顺序，且结构上与模型推理输入（`session_send` 的 message 参数）保持独立，不得混用。

**为何现有在域 AC 集不覆盖它（机械读数，不是推断）：**

1. **在域 = `status ∈ {active, achieved}`**（`inScopeAcsOf`；判据测试 `test/goal-driver-s01.test.mjs:29` 逐字「在域 = active|achieved；draft/superseded/retired 不在域」）。GOAL-033 的在域集 = **{AC-316} 一条**：`.quay/goal-round.jsonl` 最新 GOAL-033 轮次（round 2263，2026-10-09T09:15:08Z）记 `achievedFailing.inScope: ["AC-316"]`，`goal-sufficiency` fact 的 reason 逐字为 `sufficiency=insufficient（在域 AC 1 条）`。
2. **AC-316 逐字排除这条要求**：其 `origin:` 记「……不包含实时 ASR 文本转写以用户消息形式显示（interim/final、去重、顺序）——那部分需要新的后端协议事件映射与 transcript 渲染改动，复杂度与风险都单独成立，见 AC-317」。所以 AC-316 全绿也覆盖不到 AC-317 的要求。
3. **唯一承载该要求的 AC-317 是 `status: draft` ⇒ 不在域**，而它本该进域：轮次 triage 逐字建议 `{"ac":"AC-317","decision":"activate","reason":"结构完备（goal 锚合法 + criterion 非空 + 无 posture）——这条 AC 作为判据已就绪"}`。但**激活被机械拒绝**。AC-317 现 `criterion` 逐字为

   ```
   npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts -t caption
   ```

   而 `grep -c caption` 对 `server/modules/voice-realtime/tests/*.ts` **每个文件均为 0** —— `-t caption` 名称过滤命中零测试，node:test 跑 0 条、退出 0，于是 goal-store 的 fidelity judge 判其 **vacuous**。round 2262 的 flip 逐字：

   ```
   {"id":"AC-317","to":"active","ok":false,"reason":"write exit 2: goal-store: activated AC-317 — criterion ran in 1836ms (pass)\ngoal-store: write failed: cannot activate AC-317: criterion vacuous (fidelity judge: vacuous) — pass --force to override"}
   ```

   （round 2261/2263 是更早的同一激活尝试，失败在 spawn 超时；round 2262 是判据跑到、被判 vacuous 的一次。）⇒ **AC-317 永远进不了在域集，该退出条件永远没有在域 AC 承载，充分性判决因此恒定 `insufficient`。缺口是判据空转，不是缺一个 AC 号。**

**本提案（选 (a)：给退出条件点名的 AC-317 一个可运行判据，交人裁定）。**

退出条件自己写明 AC-317 的判据「提交时另行定义」——缺的正是这份判据。把 AC-317 的 `criterion`/`expect` 换成下面这份：

**为何不新立 AC 号：** AC-317 这个号已存在，且退步条件与 `## 范围` 都点名它；另立新号会让 AC-317 留成「被退出条件引用却永远 draft」的僵尸（仍不在域），还要再改 GOAL 正文把引用改指新号，churn 更大而覆盖不变。这点与 GOAL-017 的先例不同——那里 AC-218 是被**改用**（同号换了退出条件），旧号不再承载该要求，故必须新号；这里号是对的，只是判据是桩。

criterion（逐字替换 AC-317 的 criterion 字段）：

```
for f in server/modules/voice-realtime/tests/voice-realtime-caption.test.ts e2e/voice-realtime-asr-caption.spec.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-caption.test.ts && npx playwright test e2e/voice-realtime-asr-caption.spec.ts
```

expect（逐字替换 AC-317 的 expect 字段）：判据文件先做存在性门（缺则 exit 1，红先行），再跑两段命令，均 exit 0；覆盖 `## 范围` 第 2 条的四小句：

1. **后端映射**（`server/.../voice-realtime-caption.test.ts`，离线、无麦克风、无网络）：bridge 不再把 `conversation.item.input_audio_transcription.delta`/`.completed` 抛成 `UNKNOWN_EVENT` —— `delta` 走 `onCaption({ itemId: item_id, text: stash, final: false })`（累计文本在 `stash`、`text` 恒空——真实抓包 `experiments/voice-realtime-ambiguity/real-trace/qwen38-omni-realtime-trace.json` 实测含 `.delta` 14 次、`.completed` 1 次），`completed` 走 `onCaption({ ..., text: transcript, final: true })`；字段不合规的 caption 被丢弃、不升级到 error 通道。
2. **代理 outbound 新帧**（同文件）：新增 `{ type: 'caption', itemId, text, final }`，与既有 `state`/`sent`/`error` 并列；**结构不变量**：任一 caption 的 `text` 不得出现在任何 `session_send` 调用的 `message` 参数里（与模型推理输入结构上互不相通）。
3. **前端渲染**（`e2e/voice-realtime-asr-caption.spec.ts`）：caption 渲染为一条「临时态→最终态」的用户消息气泡；按 `item_id` 去重（同一 `item_id` 的后继 delta **替换**而非追加，重复 `delta` 不产生重复气泡）、按到达顺序排列。
4. **PC/移动两个视口**都看得到这条消息的渲染。

取假形态（逐条变异 → 判据必须红，落点须为被点名那一条）：(a) 把 bridge 改回对这两类事件抛 `UNKNOWN_EVENT` ⇒ 第 1 段红；(b) `delta` 读 `message.text`（空）而非 `message.stash` ⇒ 临时态气泡为空 ⇒ 第 1 段红；(c) 把某条 caption 的文本塞进 `session_send` 的 `message` 参数 ⇒ 第 2 段不变量红；(d) 同 `item_id` 的 delta 追加而非替换 ⇒ 重复气泡 ⇒ 第 3 段 e2e 红。

运行预算（如实登记，供人裁定）：本仓验收门默认 `60000ms`（goal-driver `DEFAULT_ACCEPTANCE_TIMEOUT_MS = 6e4`；AC-317 记录上声明 `timeoutMs` 可覆盖，既有机制）。第 1 段离线、秒级；第 2 段 Playwright 需占预算——若两段合计越过 60s 门，须在 AC-317 记录上声明 `timeoutMs`，或把第 3/4 句（视口渲染）拆成独立 AC。此处不预设，交裁定。

**旁证（本轮勘察）：** `server/modules/voice-realtime/voice-realtime-bridge.service.ts` 工作树里已有 **62 行未提交插入**（`git diff --stat` 记 `62 insertions(+), 1 deletion(-)`），实现了 `handleCaption` 与两条 `dispatch` 分支（`git blame -L 258,293` 这些行显示未提交），即 AC-317 的后端半边已有一份草稿——缺的是判据文件与前端一段，而非从零开始。

**为何这样覆盖了退出条件：** 给 AC-317 一个存在性门 + 真实断言的可运行判据后，goal-store 的 fidelity judge 不再判其 vacuous ⇒ 它被激活、`status` 转 active ⇒ 进入在域集（`在域 AC 1 条` → ≥2 条）⇒ 充分性判官在 in-scope AC 列表里看到承载该退出条件的 AC ⇒ 判决不再是恒定 `insufficient`。判据红先行（文件不存在即红），符合 activation 对「未落地的 AC」的期望。

**本任务不改 `goals/*.md`、不改任何 GOAL/AC 状态**：AC-317 记录的更新由**被授权的 goal 写入路径**执行，本 agent 只提案。

<!-- dedup-ref -->
**机制去重读数（本轮立案实测）：** `task_list --search GOAL-033` 与 `grep -rln 'GOAL-033\|AC-317' tasks/*.md` 命中 3 条 —— `gap-live-voice-exclusive-mode-fixed-bar`（AC-316，done）、`gap-ac315-upload-criterion-repoint-under-voice-bar`、`gap-live-voice-realtime-asr-caption-transcript`（todo，`goal_ac: AC-317`）。最后一条是 AC-317 的**实现占位**任务，其自身正文明写「待 AC-317 从 draft 激活为 active 并细化判据后再推进实现」「依 AC-317 自身 criterion 激活时最终确定」——它**不**提议任何 AC/退出条件改动，且它自己正被本提案要关掉的缺口阻塞。⇒ 无在飞认领者提议本 goal 的 AC/退出条件改动，本条不是重复；与本占位任务**保持分立**（本条的交付物是 AC 记录的判据，交人裁定；占位任务的交付物是实现，必须等本条的判据先落地才能开工）。

## AC

- [ ] AC1 **人（yale）已裁定并被记录**：本任务 `## Resolution` 写明 (i) 采纳 / 不采纳「把 AC-317 的 criterion 换成 Proposal 里的可运行判据」；(ii) 若采纳，AC-317 记录由谁、于何时落地（`status` 是否随之从 draft 转 active）；(iii) 运行预算如何处理（声明 `timeoutMs` / 拆分视口 AC / 削减第 3-4 句）。三者缺一即不满足。（待外部 —— 只能由人写入）
- [ ] AC2 **AC-317 记录已更新且判据可跑**：`goals/AC-317-实时-asr-interim-final-transcript-作为用户消息展示-不混入模型推理输入-依赖-ac-316.md` 由**被授权的 goal 写入路径**更新，`criterion` 逐字为 Proposal 里的链式命令；在实现落地后的树上直跑该命令退出 0，并逐条记录实测读数（每段最后一行 + 退出码 + 实测耗时，须在门内）；同时记录 goal-store 激活 AC-317 时**不再**报 `criterion vacuous`（fidelity judge 接受）。（待外部 —— 只能由 goal 写入路径落地）
- [ ] AC3 **判据非恒真**：按 expect 的四条取假形态逐条变异并实测，每条变异后判据命令必须退出非 0 且失败落在被点名的那一段；记录变异 diff、逐字失败行、恢复命令与恢复后重新绿。四条假形态全绿（未红）即不满足。（待外部 —— 须 AC2 落地后）
- [ ] AC4 **充分性判决不再恒为 insufficient**：AC-317 转 active 后的**真实 round log** 里，GOAL-033 的 `goal-sufficiency` reason 须由 `在域 AC 1 条` 变为 `在域 AC ≥2 条`，verdict 不再是来自那条 1 条在域集的 `insufficient`；命令打印 `.quay/goal-round.jsonl` 里 GOAL-033 的 `goal-sufficiency` 序列最后两条与 `achievedFailing.inScope`。（待外部 —— 只能由 goal-driver 后续轮次产生）

## DoD

人工裁定采纳后，由**被授权的 goal 写入路径**（而非本 agent）**真实更新** `goals/AC-317-*.md` 的 `criterion`/`expect` 为 Proposal 逐字内容，并使该记录从 draft 转为可激活（activated / active）；随后在**真实 round log** 中观察到 GOAL-033 的 `goal-sufficiency` reason 由 `在域 AC 1 条` 升为 `≥2 条`，且 verdict 不再来自 1 条在域集的 `insufficient`。**仅有 AC 记录被编辑而无后续 verdict 观察不算完成。**

承重性由三件事正面证明：

(a) **缺口被指名、可复算** —— 在域集 {AC-316} vs 退出条件点名 {AC-316, AC-317}；`grep -c caption` 对每个 voice-realtime 测试文件为 0，故 `-t caption` 命中零测试；round 2262 的 flip 逐字给出 `criterion vacuous`；
(b) **机制已被观测过** —— triage 逐字建议 activate AC-317，但激活被 fidelity judge 持续拒绝（rounds 2261/2262/2263 三次尝试同为一条激活）；
(c) **判据真的会红** —— AC3 的四条假形态各自把被点名的那一段打红（不是「文件不存在」式的空洞红）。

另需如实登记：本任务**不**让任何 AC 转绿、**不**改任何 GOAL/AC 状态、**不**改 `goals/*.md`。它由跟进 agent 只提议：把 AC-317 的判据从空转桩换成可运行判据，交人裁定。

## Touches

- goals/AC-317-实时-asr-interim-final-transcript-作为用户消息展示-不混入模型推理输入-依赖-ac-316.md（待外部 —— 只能由被授权的 goal 写入路径更新）
- tasks/gap-goal-033-ac317-runnable-criterion.md (self)


## Re-verification 2026-10-10（重派前复核）：Proposal 的现状描述已过期，**不采纳执行**

按记忆 [[proposal-现状-claims-must-be-reverified-before-writing-the-deliverable]] 的要求，在写任何 goals/*.md 之前先复核 Proposal 的现状断言，发现它描述的缺口已于 2026-10-09 自行闭合：

- AC-317 现 `status: achieved`（statusLog：draft→active 2026-10-09T10:36:35.596Z；active→achieved 10:44:58.174Z by goal-driver，reason `I2: criterion pass`），因此在域（在域 = active|achieved）。
- AC-317 现 criterion 是 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts && npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`，两个判据文件都存在；Proposal 引用的那个 `-t caption` 判据已不是现行值。
- GOAL-033 的 goal-sufficiency verdict 最近两拍为 `covered`（此前为 insufficient）——缺口不再存在。

⛔ 若照 Proposal 执行，会把一个**已 achieved、判据文件存在**的 AC 换成指向两个**不存在**文件（`server/modules/voice-realtime/tests/voice-realtime-caption.test.ts`、`e2e/voice-realtime-asr-caption.spec.ts`）的判据：存在性门令判据直接红，反而会把 AC-317 打回红。

结论：本任务不应执行；重派已撤销，置回 needs-human，待人裁定是否按「需求已被更早的实现满足」收尾。