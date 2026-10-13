---
id: gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop
title: 连续体验验收 spec 随「移除对话区转写气泡」（2b7dfc17 /
  gap-live-voice-remove-transcript-caption-rows）回归：重锚可见处置断言到新投影（真实行 + 诚实状态行 +
  底部语音框），清掉已删 testid voice-row-heard/voice-row-delivering（只改测试）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-361
---
## Proposal

### 现状（本轮直接复跑实测一次）

`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 在当前 develop（HEAD = `4c03f2e9`，含 `2b7dfc17`）上 **1 failed / 8 did not run / 2 passed，exit 1**（`test.describe.configure({ mode: 'serial' })` 使后 8 条不运行）。首个失败在 `e2e/voice-realtime-continuous-experience.spec.ts:994`：

```
Error: "不对，改成跑 lint" must be on screen: [{"style":"user","testid":null,"text":"seeded turn for continuous experience"},{"style":"unattended","testid":null,"text":"常驻会话里正在跑的一轮（先占住执行面）"},{"style":"user","testid":null,"text":"把 server 的日志贴出来"},{"style":"unattended","testid":null,"text":"常驻会话里正在跑的一轮（先占住执行面）"}]
Expected length: 1   Received length: 0   Received array: []
```

判据的 L1 半边是绿的：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts` → 13 pass / 0 fail / exit 0。红只在 Playwright 半边。

### 成因（读提交与代码，实测 rows）

- 提交 `2b7dfc17`（任务 `gap-live-voice-remove-transcript-caption-rows`，2026-10-13 14:21，人的裁定「不再显示转写气泡」）把对话区里 `heard`/`delivering` 两态的转写行整个删除：`heardUtteranceRows` / `foldCaptionsIntoTranscriptRow` / `dropCaptionsDeliveredAsMessages` 及两个 `data-testid`（`voice-row-heard` / `voice-row-delivering`）一并从 `MessageComponent.tsx` / `placeCaptions.ts` / `types.ts` 移除。当前保留的可见面是：真实 user 消息行（带 `voice-transcript-badge`）、`voice-row-undelivered`（拒收）、`voice-row-unrecognized`、`voice-row-segment-outcome`、`voice-closed-unshown-utterance`，以及底部语音框的转写位 `voice-realtime-caption`。
- 本 spec 仍逐字读取那两个已删 testid（`grep -c 'voice-row-heard\|voice-row-delivering' e2e/voice-realtime-continuous-experience.spec.ts` = **21**），因此：
  - X-1 的 `[U1, U5]` carrier 直断言里 **U5**（`不对，改成跑 lint`，detector 处置 `interrupted`）原本靠一行 `voice-row-heard` 承载 —— 该行已不存在 ⇒ `carries(rows, U5)` 为 0 ⇒ :994 红。（U5 的纠正只走 stop 的 `intent`、从不作为消息投递，见本 spec X-5 自己的注释，所以它不会以真实 user 行出现。）
  - U2 的已知缺陷腿与合并投递腿的多处 `expectKnownDefect` **签名**（要求 `voice-row-delivering` / `voice-row-heard` 邻行）也不再匹配；一旦运行到，会以 `unexpected failure signature` 变红。
  - `:843` 的 fold 观察 filter（`row.testid === 'voice-row-delivering'`）永远读空，fold 判定失真。

### 前一次修复为何未持久

上一轮 `gap-live-voice-continuous-experience-spec-realign-after-watermark`（提交 `a43bc1e9`，已 done）声称 11 passed；但 `git merge-base --is-ancestor 2b7dfc17 a43bc1e9` = **NO** —— 它在**不含** `2b7dfc17` 的基上验证，而 fan-in 的 suite **不含 playwright e2e**，所以合入 develop（把 `2b7dfc17` 带进来）之后本 spec 从未被重跑。于是判据（AC-361 的 Playwright 半边）在合一棵树上是红的。`gap-live-voice-remove-transcript-caption-rows` 的完成记录已把 `e2e/voice-realtime-continuous-experience.spec.ts` 逐字列为「范围外文件（另立 follow-up）」——本条就是那条 follow-up。

### 要做的事（只改测试）

把 spec 重新锚到 `2b7dfc17` 之后的真实投影，保持「每句话语一个可见处置、无静默丢失」的验收不削弱：

1. **可见面重锚**：凡靠 `voice-row-heard` / `voice-row-delivering` 承载的腿，改读产品当前实际画出的面 —— 已投递句读真实 user 行（`voice-transcript-badge` 的 `Heard as: …`）；拒收读 `voice-row-undelivered`；未识别读 `voice-row-unrecognized`；段丢失读 `voice-row-segment-outcome`；对话区确实无行的句（如 `interrupted` 的 U5）读底部语音框转写位（`voice-realtime-caption`）—— 若该面也不承载该处置，则按下面第 2 条记为已知缺陷。
2. **逐条二选一**：成立（新投影仍以某个面承载该保证）⇒ 直接断言，写明 testid/状态；不成立（新投影静默吞掉了该处置）⇒ 以 **expectKnownDefect** 记录，签名包含**当前实际的 rows**（变体部分用 `.*`），断言**原样保留、不删弱**，`fixTask` 指向一个 `task_get` 读出**非 done** 的在飞任务。
3. **fixTask 有效性**：spec 内不得再出现任何 done 任务的 id 作为 `fixTask`；每处 `fixTask` 用 `task_get` 读出为 todo / ready / needs-human。当前 `gap-voice-unforwarded-utterance-visible-disposition` 仍是 `ready`（其实现提交 `4245cfe4` 只在任务分支 `task/gap-voice-unforwarded-utterance-visible-disposition`、**不在** HEAD），是「听了、未转发必须有可见处置」的产品侧在飞所有者，可作为 U2 腿的 `fixTask`。
4. **fold 观察**：`:843` 的 filter 随投影改（例如改读底部语音框是否仍含未落地句）。
5. **边界**：若判定必须改产品代码才能恢复某条 AC-361 保证，**停在 needs-human** 并写明理由，不得顺手改产品。本条的 siblings（`e2e/voice-realtime-double-drop.spec.ts`、`e2e/voice-realtime-scripted-scenarios.spec.ts`，同样是 caption-rows 任务的「范围外」文件）不由本条覆盖 —— 它们不属 AC-361 判据命令的选中范围。

<!-- dedup-ref --> 机制去重：`gap-live-voice-continuous-experience-spec-realign-after-ac355`、`gap-live-voice-continuous-experience-spec-realign-after-watermark`（均 done，均声索 AC-361）是同一机制的前两次发生；本条是「移除对话区转写行」这一**新的**投影变化（`2b7dfc17`）导致的第三次，按「done 的 AC 声明不是重复、而是前次修复未持久的证据」立新任务。`gap-live-voice-remove-transcript-caption-rows`（done）是造成本次投影变化的任务、并已把本文件列为 follow-up。`task-granularity-advice --touches e2e/voice-realtime-continuous-experience.spec.ts` → `peers: []`、`mentions: []`，无同文件在飞实现任务，**separate**。

## Plan

1. 本地复现并取全部 rows 读数（`QUAY_CONTINUOUS_EXPERIENCE_DUMP`），逐帧确认新投影里每个口语 run 的可读面。
2. 按上面第一、二条逐腿重锚 / 记录；把选择依据写进 `## Notes`（逐条给出「直接断言 / 已知缺陷记录」与理由）。
3. 同一种子连续 3 次运行，读数一致。
4. 零外联读数（AC-360 守卫）+ `npx oxlint e2e/voice-realtime-continuous-experience.spec.ts`（`npm run lint` 的 glob 不含 `e2e/`）。

## AC

- [x] AC1：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 退出 0，11 个用例全部运行（无 did not run、无 skip）。
- [x] AC2：`grep -c 'voice-row-heard\|voice-row-delivering' e2e/voice-realtime-continuous-experience.spec.ts` 读数为 0（这两个 testid 已从产品删除）。
- [ ] AC3：spec 内每处 `expectKnownDefect` 的 `fixTask` 用 `task_get` 读出为**非 done**（todo / ready / needs-human）；`grep -o "fixTask: '[^']*'" <spec> | sort -u` 的每个 id 都通过该读取，且 spec 内不再出现任何已 done 任务 id 作为 `fixTask`。
- [x] AC4：「每句话语一个可见处置、无静默丢失」仍被断言：U2（unforwarded）腿、X-2、X-6 各自的保证仍在（直接断言或带**当前实际 rows** 签名的已知缺陷二者之一），并在 `## Notes` 逐条写明选择依据。
- [x] AC5：`QUAY_CONTINUOUS_EXPERIENCE_DUMP` 三次运行的归一化读数 sha256 逐字相同（同一种子连续 3 次一致）。
- [x] AC6：零外联（AC-360 守卫读数：loopback 拒绝数 0）；`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` 退出 0。

## DoD

continuous 体验基线 spec 在当前 develop 上恢复全量运行且通过（AC-361 判据的 Playwright 半边 exit 0）；不削弱「每句一个可见处置、无静默丢失」；只改 spec，不改产品代码（若必须改产品才能恢复保证，停在 needs-human）。真实落地不是「测试存在」：spec 读的是产品**当前**画出的面，而非已删的 testid。

## Touches

- e2e/voice-realtime-continuous-experience.spec.ts
- tasks/gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop.md

## Notes

**逐腿选择依据** —— 产品在 `2b7dfc17`（`gap-live-voice-remove-transcript-caption-rows`）之后画出的可见面只有：真实 user 消息行（带 `voice-transcript-badge`，title `Heard as: …`）、`voice-row-undelivered`（拒收）、`voice-row-unrecognized`、`voice-row-segment-outcome`、`voice-closed-unshown-utterance`，以及底部语音框转写位 `voice-realtime-caption`。逐条：

| 腿 | 话语 / 处置 | 新投影里的面 | 选择 | 理由 |
| --- | --- | --- | --- | --- |
| X-1 处置表 | U1 `forwarded` | 真实 user 行（`style:user`、`testid:null`、badge `Heard as: …`） | **直接断言** | 已投递句就是模型转发的那条真实消息；badge 是「这句话是 spoken」的唯一标记。实测 `heard` 标题含 U1。 |
| X-1 处置表 | U5 `interrupted` | 底部语音框 `voice-realtime-caption` | **直接断言** | 纠正只走 stop 的 `intent`、从不作为消息投递（spec X-5 自己的注释），故对话区按设计无其行；唯一承载它的是底部转写位。 |
| X-1 处置表 | U2 `unforwarded` | 对话区无行 | **已知缺陷** | 水位线归属 + caption 行删除后无任何面承载。`fixTask: gap-voice-unforwarded-utterance-visible-disposition`（写出时 ready，本轮已翻 done，见 `## Evidence`）。断言原样保留（恰一行承载 U2），签名锚到唯一存活的 U1 真实行。 |
| X-1 处置表 | 合并投递 `MERGED_MESSAGE` | 对话区无行 | **已知缺陷** | 同上，同一 owner。 |
| X-1 green「delivered 不再显示为 delivering」 | `MERGED_MESSAGE` | `voice-row-undelivered` | **直接断言**（filter 重锚） | 旧 pending testid 已不存在；当前唯一的「未达转写」标记是 `voice-row-undelivered`。断言（既标 undelivered 又载整条合并消息的行 = ∅）原样保留。 |
| X-2 正向半边 | U2 | 对话区无行 | **已知缺陷** | 与 U2 腿同根因、同 owner；签名重锚。 |
| X-6「未转发 has a visible marker」 | U2 | 对话区无行 | **已知缺陷** | 同上，同一 clause 的第三条腿。 |
| fold 观察 | — | 底部语音框 caption vs 对话行 | **重锚** | 旧 filter 读已删 testid、恒为空。改读「底部转写位上的句子尚未落到任何对话行」——新投影下这正是界面未 settle 的那一半。U5 永不落地 ⇒ `fold.resolved:false`、`lastInFlight:[U5]`，是读数而非挂起。 |

**实测读数（`QUAY_CONTINUOUS_EXPERIENCE_DUMP`，2026-10-13）**

- `transcript.rows` = 4 行：seed 用户行、两条 unattended 行、U1 真实 user 行（`heard = "Heard as: 把 server 的日志贴出来 嗯…那个… 我想想"`）。U2/U3/U4/U5 在对话区无行。
- `caption` = `不对，改成跑 lint`（U5）；`fold` = `{resolved:false, waitedMs:~8200, lastInFlight:["不对，改成跑 lint"]}`。
- `status` = `{busy:null, queuedDepth:"0", queuedBytes:"0", text:"Stopped the current turn — 0 still queued", stoppedVisible:true}`；`phase`="listening"；dock 状态集 = {null, in-turn}。

**AC 读数**

- **AC1**：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 连跑三次，均 **11 passed / 11 run / exit 0**（无 did not run、无 skip）；合并 develop 后复跑仍 **11 passed / exit 0**（`/tmp/ce-run-m.log`）。
- **AC2**：`grep -c 'voice-row-heard\|voice-row-delivering' e2e/voice-realtime-continuous-experience.spec.ts` = **0**。
- **AC3**：**未满足（见 `## Evidence`）**。写出本条时 4 处 `fixTask` 均指向 `gap-voice-unforwarded-utterance-visible-disposition`，当时 `task_get` 读出 status=ready；**本轮内该任务已由 driver 翻 `done`**（`2f81aff9`，实现提交 `4245cfe4` 已随 develop 的合并进入本分支），故「spec 内不再出现任何已 done 任务 id 作为 `fixTask`」在当前树上不成立。
- **AC4**：U2（unforwarded）腿、X-2、X-6 三条保证仍在，均以带**当前实际 rows** 签名的 `expectKnownDefect` 记录（签名锚 `"text":"把 server 的日志贴出来"`，即唯一存活行）；逐条依据见上表。合并树上四条腿全部以 `[known-defect] … matched` 通过。
- **AC5**：三次 `QUAY_CONTINUOUS_EXPERIENCE_DUMP` 运行的归一化读数 sha256 **逐字相同**（`6110c06846661441`）；合并 develop 后复跑归一化读数**仍为该值**。归一集＝ detector 读数 / 计数、`transcript.rows`、`caption`、`status`、`phase`、routing（各数组归一为文本/计数，去掉时间戳）、`fold`（去 `waitedMs`）、`pageErrors`、`egress`、dock 状态集、journal mode、帧类型集合。逐次不同的只有 run-scoped 字段（`sessionId`、`probes` / `activityFrames` / `warnings` 的条数、帧到达顺序、`ageMs`、`speechStops` 的时间戳），均不是断言对象。
- **AC6**：零外联——`egress = {logExists:true, blocked:false, dials:1, authorizationSeen:false, refused:5}`，被拒 5 条全为非 loopback（`fonts.googleapis.com` ×1、`api.github.com` ×4），**loopback 拒绝数 0**；`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` → exit 0。
- 只改 `e2e/voice-realtime-continuous-experience.spec.ts`；未改产品代码（U2 腿的产品侧修复本属 `gap-voice-unforwarded-utterance-visible-disposition`，该任务本轮已翻 done 但只覆盖 `MODEL_TEXT_REPLY` 形态；见 `## Evidence`）；未动 develop；未跑 fan-in（按 worker 约定交给 driver）。

## Evidence

本轮（2026-10-13）在**已把 develop 合并进来**的分支树上（HEAD = `196e6d8b`，含 `2b7dfc17` 与 `4245cfe4`）逐条复验。**AC3 未满足**，其余五条逐一读数如下。

### 逐 AC 读数

- **AC1 ✓**：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` → **11 passed / 11 run / exit 0**（无 did not run、无 skip）。合并树复跑记录 `/tmp/ce-run-m.log`。
- **AC2 ✓**：`grep -c 'voice-row-heard\|voice-row-delivering' e2e/voice-realtime-continuous-experience.spec.ts` = **0**。
- **AC3 ✗（本次停因）**：`grep -o "fixTask: '[^']*'" <spec> | sort -u` = {`gap-voice-unforwarded-utterance-visible-disposition`}（4 处），`task_get` 读出 status = **done** ⇒ AC3 的第二半（「spec 内不再出现任何已 done 任务 id 作为 `fixTask`」）不成立。
- **AC4 ✓**：U2（unforwarded）腿、X-2、X-6 三条保证仍在，均以带**当前实际 rows** 签名的 `expectKnownDefect` 记录；合并树上四条腿全部以 `[known-defect] … matched` 通过（`/tmp/ce-run-m.log` 的四行），签名仍锚在唯一存活行 `"text":"把 server 的日志贴出来"`。
- **AC5 ✓**：`QUAY_CONTINUOUS_EXPERIENCE_DUMP` 归一化读数 sha256 —— 合并树运行 = `6110c06846661441`，与合并前三次逐字相同（`/tmp/ce-normalize.mjs`）。
- **AC6 ✓**：零外联读数 `refused` 全为非 loopback（`fonts.googleapis.com` ×1、`api.github.com` ×4），**loopback 拒绝数 0**；`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` → exit 0。

### AC3 为何是执行侧不可满足的

AC3 要求 4 处 `fixTask` 各指向一个 `task_get` 读出**非 done** 的在飞任务。写出本条时 `gap-voice-unforwarded-utterance-visible-disposition` 仍 `ready`（其实现 `4245cfe4` 当时只在任务分支）；**本轮内它被 driver 机械翻 `done`（`2f81aff9`）并随 develop 合入本分支**。此刻：

1. **具名 owner 已 done**：`task_get gap-voice-unforwarded-utterance-visible-disposition` → status=**done**。
2. **门店里没有可替代的非 done owner**：`task_list status=todo` → 0；`status=needs-human` → 0；`status=ready` → 2（本条，及无关的 `gap-voice-server-vad-three-arm-replay-on-third-test-corpus`）。
3. **已落地的修复只覆盖另一种形态**：`4245cfe4` 的处置在 `voice-realtime-ws-proxy.service.ts` 的 `error.code === 'MODEL_TEXT_REPLY'` 分支发出 `heard_not_forwarded` 帧；其自带夹具（`server/modules/voice-realtime/tests/voice-realtime-unforwarded-disposition.test.ts`）驱动的正是**一次 `response.text.done`**。而本 spec 的 U2 形态是 `policy: 'silent'`（spec L142）——上游对该句**什么都不发** ⇒ 永不触发 `MODEL_TEXT_REPLY` ⇒ 那个 `heard_not_forwarded` 帧在 continuous 体验场景里**从不出现**（合并树 dump 中 `not forwarded` / `Heard —` / `voice-realtime-unforwarded` 命中 0 次）。
4. **四条腿要的面与已落地修复的面不是同一种**：U2/X-2/X-6 断言的是**对话区一行**（`carries(rows, U2)` / `rows.some(row => row.testid !== null …)`），合并投递腿断言的是**一行承载整条合并消息**；而已落地的处置是**底部状态格的一行提示**（`voice-realtime-unforwarded`，且被 `stoppedLabel` / `refusedLabel` / `busyLabel` 压过），**不是对话区行**。要让这四条腿成为直接断言，必须改产品代码（给 `silent` 形态与合并投递补一个可见面）——**这正是本任务 Plan 第 5 条说的边界**。
5. 顺带读数：合并投递至今在对话区**零行**（合并树 dump 的 `transcript.rows` = seed + 2 条 unattended + U1 真实行），且归一化读数 sha256 与合并前一致 ⇒ `4245cfe4` 对本场景**没有改变任何读数**。

### 给裁决人的两条路（择一）

- **(A) 另立产品侧 task 覆盖 `silent` 形态与合并投递**，作为这四条腿的新 `fixTask`；本分支 `e9c66834` 的重锚已就绪，随后只需改 4 处 `fixTask` 一行即可再晋升。
- **(B) 裁定这四条腿的期望本身该改**（`silent` 形态上游无信号、产品侧没有 closure 事件，可能本就不该要求一个可见处置）——这是产品/判据决定，需人写明后由后续任务改断言。

裁决前本任务**不改产品、不伪造 owner**：为凑 AC3 的 grep 而临时新立一个任务属于把检查点做绿，会让 AC-361 的验收失去证据力。

## Blocker

**2026-10-13T06:59:42.098Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 5/6，剩余未勾 1）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：2c222a61-73f7-4462-8e28-b37237697388
