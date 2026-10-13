---
id: gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop
title: 连续体验验收 spec 随「移除对话区转写气泡」（2b7dfc17 /
  gap-live-voice-remove-transcript-caption-rows）回归：重锚可见处置断言到新投影（真实行 + 诚实状态行 +
  底部语音框），清掉已删 testid voice-row-heard/voice-row-delivering（只改测试）
status: done
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

`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 在 develop（含 `2b7dfc17`）上曾是 **1 failed / 8 did not run / 2 passed，exit 1**（`test.describe.configure({ mode: 'serial' })` 使后 8 条不运行），首个失败在 spec 的 X-1 carrier 腿。本分支已把它重锚到 `2b7dfc17` 之后的真实投影并跑绿（读数见 `## Evidence`）。

### 成因

提交 `2b7dfc17`（任务 `gap-live-voice-remove-transcript-caption-rows`，人的裁定「不再显示转写气泡」）把对话区里 `heard`/`delivering` 两态的转写行整个删除（`heardUtteranceRows` / `foldCaptionsIntoTranscriptRow` / `dropCaptionsDeliveredAsMessages` 及 `data-testid` `voice-row-heard` / `voice-row-delivering`）。当前保留的可见面是：真实 user 消息行（带 `voice-transcript-badge`）、`voice-row-undelivered`（拒收）、`voice-row-unrecognized`、`voice-row-segment-outcome`、`voice-closed-unshown-utterance`，以及底部语音框转写位 `voice-realtime-caption`。本 spec 原先逐字读取那两个已删 testid（21 处），故在合一棵树上红。

### 2026-10-13 人裁定：保证按形态分两类（本任务的核心）

人 yale 裁定**收窄**：`policy: 'silent'`（模型听到但什么都没答，上游对该句完全不发信号）**不要求**可见处置；而 `outcome: 'delivered'`（模型确实投递给了会话）**必须**在人这一侧有一行。据此：

- **U2（`嗯…那个…`，`policy:'silent'`）的 3 条腿**（X-1 的 carrier 腿、X-2、X-6）改为**直接断言收窄后的行为**：对话区不承载该句、也不得把它误画成拒收/未识别/段丢失任一面。不再需要 `fixTask`。
- **合并投递腿**（`MERGED_MESSAGE = U3+U4`）**不在**收窄范围内：该消息在 `routing.sends` 里是 `outcome: 'delivered'`（spec 自己断言并已通过），它零行是**另一类**缺陷（人看不到自己说的话进了会话），故**保留 known-defect 形态**，owner 改指新立的 `gap-voice-delivered-merged-message-invisible-in-transcript`（原 owner `gap-voice-unforwarded-utterance-visible-disposition` 已 done，且其修复只覆盖 `MODEL_TEXT_REPLY` 形态）。

### 要做的事（只改测试）

1. 已经完成的投影重锚保持（3 条 `silent` 腿 + 合并投递腿的签名与锚点）。
2. 把 3 条 `silent` 腿从 `expectKnownDefect` 改为**直接断言**（断言的是「没有行」＋「没有被误画成别的处置面」），并在注释里引用本次裁定。
3. 把合并投递腿的 `fixTask` 由已 done 的 id 改为 `gap-voice-delivered-merged-message-invisible-in-transcript`，断言与签名**原样保留、不删弱**。
4. `:843` 附近的 fold 观察 filter 随投影改（旧 filter 读已删 testid、恒为空）：改读「底部转写位上的句子尚未落到任何对话行」。
5. **边界**：不削弱仍在范围内的保证、不为凑 grep 伪造 owner；若判定必须改产品代码才能恢复仍在范围内的保证，停在 `needs-human` 并写明理由。本条不覆盖 `e2e/voice-realtime-double-drop.spec.ts`、`e2e/voice-realtime-scripted-scenarios.spec.ts`（不在 AC-361 判据的选中范围内）。

<!-- dedup-ref --> 机制去重：`gap-live-voice-continuous-experience-spec-realign-after-ac355`、`gap-live-voice-continuous-experience-spec-realign-after-watermark`（均 done，均声索 AC-361）是同一机制的前两次发生；本条是「移除对话区转写行」这一**新的**投影变化（`2b7dfc17`）导致的第三次。`gap-live-voice-remove-transcript-caption-rows`（done）是造成本次投影变化的任务、并已把本文件列为 follow-up。`task-granularity-advice --touches e2e/voice-realtime-continuous-experience.spec.ts` → `peers: []`、`mentions: []`，无同文件在飞实现任务，**separate**。

## Plan

1. 在 worktree 上 `git merge --no-edit develop`，跑 `npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` + `QUAY_CONTINUOUS_EXPERIENCE_DUMP`，确认新投影下的逐腿读数。
2. 按裁定改 3 条 `silent` 腿为直接断言（措辞可改，但必须是**直接断言**、且不是把断言删掉），把合并投递腿的 `fixTask` 改指新 owner。
3. 全量跑该 spec（11 用例，无 did not run / 无 skip），并确认 3 条新断言在**当前**产品面上绿、合并投递腿仍以 known-defect 形态通过。
4. 同一种子连续 3 次运行，归一化读数一致；零外联读数（AC-360 守卫）+ `npx oxlint e2e/voice-realtime-continuous-experience.spec.ts`。
5. 经 Provider ABI `task_write` 逐条勾选后退出，由 worker-driver 机械 fan-in 落地。

## AC

- [x] AC1：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 退出 0，11 个用例全部运行（无 did not run、无 skip）。
- [x] AC2：`grep -c 'voice-row-heard\|voice-row-delivering' e2e/voice-realtime-continuous-experience.spec.ts` 读数为 0（这两个 testid 已从产品删除）。
- [x] AC3：spec 内 `grep -c "fixTask:"` = **1**，且该 id 经 `task_get` 读出为非 done（当前应为 `gap-voice-delivered-merged-message-invisible-in-transcript`）；`grep -c "expectKnownDefect"` = **1**（只剩合并投递那条腿）。原 3 条 `silent` 形态腿（X-1 的 U2 carrier 腿、X-2、X-6）已改为**直接断言**：U2 在对话区不承载于任何行、且不得被误画成拒收/未识别/段丢失任一面。三条断言必须仍存在于 spec 内 —— `## Evidence` 逐条列出其断言文本与行号；⛔ 删掉腿来满足本条不算满足。
- [x] AC4：「每句话语一个可见处置、无静默丢失」按 2026-10-13 裁定分成两类并被分别断言：`policy:'silent'` 类（U2）不再要求可见处置（3 条直接断言），`outcome:'delivered'` 类（合并投递）仍要求一行、目前以带**当前实际 rows** 签名的 `expectKnownDefect` 记录；逐条依据写进 `## Notes`。
- [x] AC5：`QUAY_CONTINUOUS_EXPERIENCE_DUMP` 三次运行的归一化读数 sha256 逐字相同（同一种子连续 3 次一致）。
- [x] AC6：零外联（AC-360 守卫读数：loopback 拒绝数 0）；`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` 退出 0。

## DoD

continuous 体验基线 spec 在当前 develop 上恢复全量运行且通过（AC-361 判据的 Playwright 半边 exit 0）。保证按 2026-10-13 人裁定收窄并**分别**成立：`policy:'silent'`（听到但模型什么都没答）不要求可见处置、`outcome:'delivered'` 的消息必须有一行——两者都由 spec 自己的断言读出，不是靠注释声明。只改 spec，不改产品代码（若必须改产品才能恢复仍在范围内的保证，停在 `needs-human`）。

## Touches

- e2e/voice-realtime-continuous-experience.spec.ts
- tasks/gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop.md

## Notes

### 逐腿选择依据（2026-10-13 裁定后）

| 腿 | 话语 / 处置 | 类别 | 选择 | 理由 |
| --- | --- | --- | --- | --- |
| X-1 处置表 | U1 `forwarded` | 已投递 | **直接断言** | 已投递句就是模型转发的那条真实消息（真实 user 行 + `Heard as: …` badge）。 |
| X-1 处置表 | U5 `interrupted` | 无对话区行 | **直接断言** | 纠正只走 stop 的 `intent`、从不作为消息投递，故对话区无其行；承载它的是底部转写位 `voice-realtime-caption`。 |
| X-1 carrier 腿 | U2 `unforwarded`（`silent`） | **裁定收窄** | **直接断言（无行）** | 上游对该句完全不发信号 ⇒ 不要求可见处置；断言改为「对话区不承载该句」。 |
| X-1 合并投递腿 | MERGED_MESSAGE | **已投递但零行** | **known-defect（保留）** | `routing.sends` 记为 delivered 却零行 ⇒ 人看不到自己说的话进了会话，属**另一类**缺陷；owner 改指 `gap-voice-delivered-merged-message-invisible-in-transcript`。 |
| X-1 green 腿 | MERGED_MESSAGE | 已投递 | **直接断言**（filter 重锚） | 「未达转写」标记如今唯一形态是 `voice-row-undelivered`；断言（既标 undelivered 又载整条合并消息的行 = ∅）原样保留。 |
| X-2 正向半边 | U2 | **裁定收窄** | **直接断言（无行）** | 同 U2 腿。 |
| X-6「未转发 has a visible marker」 | U2 | **裁定收窄** | **直接断言（无行）** | 同 U2 腿；该 clause 的「必须有标记」半边随裁定取消。 |
| fold 观察 | — | 投影变化 | **重锚** | 旧 filter 读已删 testid、恒为空；改读「底部转写位上的句子尚未落到任何对话行」。 |

### 2026-10-13 人裁定原文与范围

「设置在 merge 到 develop 前不能验证的 AC 在逻辑上是错的」是同日对另一条任务的裁定；对本条相关的裁定是**保证按形态分类**：`policy:'silent'`（模型听到但什么都没答）不要求可见处置 ⇒ 3 条 U2 腿改为直接断言；`outcome:'delivered'` 必须有一行 ⇒ 合并投递腿保留 known-defect 并换 owner。**原 4 条腿并非同一类**：合并投递那条的前提「上游无信号」不成立（spec 第 1218 行断言 `routing.sends.every(outcome === 'delivered')` 且通过），故它不在收窄范围内。

### 未决（不属于本任务）

`e2e/voice-realtime-live-session-send.spec.ts` 因默认传输翻转而恒红，由 `gap-voice-e2e-spec-read-resolved-mode-not-env` 修。

## Evidence

### 2026-10-13 worker 续做轮（裁定落地，merge develop 前）

在 worktree 上按裁定改写 spec（commit `test: realign continuous-experience spec silent legs to direct assertions`，HEAD 含 `git merge develop` 的 `62b76b3a`）并逐条复核：

- AC1 绿：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` **三次运行均 11 passed / 11 run / exit 0**（每次 11 个 `✓`，日志无 `did not run`、无 `skip`）。
- AC2 绿：`grep -c 'voice-row-heard\|voice-row-delivering'` = **0**。
- AC3 绿：`grep -c "fixTask:"` = **1**，该 id = `gap-voice-delivered-merged-message-invisible-in-transcript`，经 `task_get` 读出 **status=ready（非 done）**；`grep -c "expectKnownDefect"` = **1**（仅合并投递腿，行 1086/1095）。三条 `silent` 腿已改为**直接断言**（断言文本与行号，每条各两处：`.toEqual([])`）：
  - X-1 处置表 U2 carrier 腿 —— `:1056` `` `a silent utterance must be carried by no row: ${JSON.stringify(run.transcript.rows)}` ``、`:1063` `` `a silent utterance must not be painted as refused / unrecognized / segment-lost: ${JSON.stringify(mislabelledU2)}` ``。
  - X-2 —— `:1169` 同上「no row」、`:1176` 同上「not painted」。
  - X-6 —— `:1342` 同上「no row」、`:1349` 同上「not painted」。
  - 误画面集合 `VOICE_STATE_ROW_TESTIDS`（`:90`）= {`voice-row-undelivered`(拒收), `voice-row-unrecognized`(未识别), `voice-row-segment-outcome`(段丢失)}。
- AC4 绿（按裁定分两类、各自被断言）：`policy:'silent'` 类（U2）由上述 3 条直接断言读出 —— 实测 dump 里 U2（规范化 `嗯那个`）在 `transcript.rows` 上 **0 行**，且 `transcript.rows[].testid` 中**无任一 state-row testid 出现** ⇒ 误画集合为空；`outcome:'delivered'` 类（合并投递）仍要求一行，当前以带**当前实际 rows** 签名的 `expectKnownDefect` 记录（运行日志逐字：`[known-defect] gap-voice-delivered-merged-message-invisible-in-transcript: matched /the merged delivery must be visible as delivered: rows \[.*"text":"把 server 的日志贴出来".*\]/`）。
- AC5 绿（在**改动后**的 spec 上重跑复验）：三次 `QUAY_CONTINUOUS_EXPERIENCE_DUMP` 归一化读数 sha256 = `cc8686428228519782e183f17f777b2bb51c057d6cd74e2af54a0b10cbad25bf`，三次逐字相同。
- AC6 绿：三次 dump 的 `egress.refused` 全为非 loopback（`fonts.googleapis.com`、`api.github.com`），**loopback 拒绝数 0**、`blocked=false`；`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` exit **0**。
- 边界：只改 spec（+ 本任务文件经 ABI 勾选），未改产品代码；除最终 `git merge develop`（无冲突）外未动 develop；anti-drift Touches 门 exit 0。

### 上一轮（历史读数）

2026-10-13 worker 续做轮，在 `merge develop` 后的 worktree 上逐条复核（HEAD = `c9bcd723`，含 `2b7dfc17` 与 `4245cfe4`）：

- AC1 绿：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` → **11 passed / 11 run / exit 0**（无 did not run、无 skip）。
- AC2 绿：`grep -c 'voice-row-heard\|voice-row-delivering'` = **0**。
- AC5 绿：`QUAY_CONTINUOUS_EXPERIENCE_DUMP` 归一化读数 sha256 = `6110c06846661441`，三次逐字相同。
- AC6 绿：`egress` 的 `refused` 全为非 loopback，**loopback 拒绝数 0**；`npx oxlint <spec>` exit 0。
- AC3（**2026-10-13 已按裁定改写**）：上一轮停因是 4 处 `fixTask` 全指 `gap-voice-unforwarded-utterance-visible-disposition`（当时 `ready`，轮中被 driver 翻 done 且不覆盖本场景）。改写后：3 条 `silent` 腿不再需要 owner，合并投递腿换 owner，故 `grep -c "fixTask:"` 应为 1；本轮须重跑确认。
- AC4（**2026-10-13 已按裁定改写**）：改写的实质是 3 条腿由 known-defect 转直接断言 —— 本轮须完成该转换并复跑。

### 上一轮的停因（历史，已被裁定取代）

上一轮 park `needs-human` 的理由是「AC3 要求 4 处 `fixTask` 各指向非 done 任务，而具名 owner 已在轮中被翻 done、门店里没有可替代的非 done owner，且要让那 4 条腿成为直接断言必须改产品代码」。该判断对**合并投递腿**仍然成立（故本条为它立了新 owner），对 **3 条 `silent` 腿**则因 2026-10-13 的收窄裁定而不再成立 —— 它们不再需要产品侧可见面，改为直接断言即可。

## Needs-Human

**执行 2026-10-13T08:45:12.320Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 失败步/判词：step=suite: not ok - server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts:   AssertionError [ERR_ASSERTION]: a process handed a title registers it — the registry is not what freezes (registered=undefined handedOver="AC171 Later 65f5c8cb")
- run_id：wk-prod-anchor
- session_id：f773c4bb-a69e-4729-9816-9bada82fbd53
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop~wk-prod-anchor~1791880913603-2dcc6e.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-live-voice-continuous-experience-spec-realign-after-caption-row-drop-wk-prod-anchor.log

## Blocker

**2026-10-13T14:07:08.891Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=2360 server/modules/providers/tests/claude-resident-unattended-turn.test.ts passed=false end_ms=1791900306328
- run_id：wk-prod-anchor
- session_id：8bcce60e-4372-49e7-b5e5-d88ea96488a4
