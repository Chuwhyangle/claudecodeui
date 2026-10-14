---
id: gap-continuous-experience-busy-window-swallows-forward-row
title: 连续体验 e2e 的 X-1 腿红：第一句转发落在忙窗口内（walk+2817ms vs turn-end 3000ms）被当作 busy
  push、永不成行，判据不再确定性绿（只改测试/夹具，保持 X-1 直接断言）
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

**判据现状（本轮直接复量，2026-10-14，仓库当前 HEAD）**：AC-361 的判据命令
`for f in server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts e2e/voice-realtime-continuous-experience.spec.ts; do [ -f "$f" ] || exit 1; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts && npx playwright test e2e/voice-realtime-continuous-experience.spec.ts`
**退 1**。红腿**不在** server 侧文件——`voice-realtime-fake-vad-upstream.test.ts` 单跑 13 pass / 0 fail、退 0；红在 e2e spec 的 X-1 用例（`e2e/voice-realtime-continuous-experience.spec.ts:1013` 起，断言在 1038-1039）：

```
Error: "把 server 的日志贴出来" must be on screen once:
[{"style":"user","text":"seeded turn for continuous experience"},
 {"style":"unattended","text":"常驻会话里正在跑的一轮（先占住执行面）"},
 {"style":"user","text":"我想想然后跑一下测试"},
 {"style":"unattended","text":"常驻会话里正在跑的一轮（先占住执行面）"}]
```

U1（第一句被转发的 utterance，`把 server 的日志贴出来`）**根本没有成行**；合并消息 `我想想然后跑一下测试`（U3+U4）成了行。同一 spec 的其余 10 个用例在 `mode: 'serial'` 下因为这条失败而「did not run」。

**根因（实测读数，非推断）**：
- 同一轮 run artifact 的 `routing.sends` 记：U1 于 walk+**2817 ms** `outcome:"delivered"`；合并消息于 walk+**9380 ms** `outcome:"delivered"`。deck 的 `turn-end` 落在 `TURN_END_AT_MS = 3_000` ms（spec:116）。
- 2817 < 3000 ⇒ **U1 落在忙窗口内**。debug-agent 的 host driver 在忙时把这次 dispatch 判为 busy push（`DEBUG_AGENT_BUSY_INPUT_OPTION`，`server/modules/debug-agent/debug-agent.host-driver.ts:492-509` → `registerPushedCommand`）；provider 的 `acceptPushedCommand` 对这次 push **只写一条 `queued` 的 command-lifecycle frame**（`server/modules/debug-agent/debug-agent.provider.ts:576-582`），**不写 transcript 的用户行**。队列里的命令要变成一行，只能靠 deck 的 `dequeue` 步（`server/modules/debug-agent/debug-agent.engine.ts:610-625`）再加 `openQueuedCommandRound`（`debug-agent.provider.ts:696-698`）——而连续体验的 deck（spec:176-180）**没有 `dequeue` 步**。
- 对照：U3+U4 于 walk+9380 ms 送达（**空闲**）⇒ 走 `CHAT_TURN_OPTION` 的 `appendTypedTurnRow`（`debug-agent.provider.ts:610-616`），成行。
- 直接读夹具自己的 transcript jsonl（`<e2e-tmp>/debug-agent-home/.claude/projects/.../<session>.jsonl`）实测恰是 `[seed, busy, 合并的 U3+U4, busy]`——**U1 不在里面**（journal 说 delivered，transcript 里没有，正是「投递了但看不见」）。

**为什么这条腿时绿时红**：U1 的送达时刻与首个 `turn-end` 只差约 **183 ms**，是与调度器/机器负载赛跑。本轮同一代码同一机器：早先单跑 2 次 11/11 绿，随后一次 verbatim 链 + 连续 5 次单跑**全红**，且每次都是同一条 X-1 报错。spec 自己的文件头（第 25-29 行）已声明「X-1 的『执行面忙闲交替』是 READING 的性质、而不是调度器运气」——现状正好违背该声明，判据因此不可能满足 AC-361(e) 的「同一种子连续 3 次读数一致」。

**修法方向**：
- **首选（测试侧）**：让每一句转发的**可见性不再取决于它与忙窗口的 183 ms 赛跑**——对齐 spec 文件头声明的语义：一次转发的送达应落在**它自己随后会占用**的空闲平面上（这次送达再开一个忙回合，供 dock 读 `busy→idle` 交替），而不是落进一个**已经由别的东西占着**的忙窗口。首选做法是在 spec / e2e harness 侧重排 walk 与时间线的相对时刻（例如让首个 `turn-end` 早于 U1 的送达，或让 `playFakeMic` 晚于首个忙窗口开始），使每个 forwarded 送达都在空闲平面上完成成行；读数里 `busy→idle` 交替仍须可读（X-1 的「执行面忙闲交替」条件不得被抹掉）。
- **备选（仅当重排被证明行不通）**：若设计上确实要求「转发落在别的忙窗口内」，则必须在假体里**建模真实 CLI 在回合边界把排队命令变成一个 user 回合**的行为，使被 push 的命令在 drain 之后落一行——这可能改到 `server/modules/debug-agent/`（属 `server/` 代码，须按 `AGENTS.md` 加载并遵循 `$backend-module-standards`）。
- **不得**：放松 X-1 的可见处置断言、引入 `voiceRealtimeKnownDefect` / `test.fail` / `test.skip` / `expect.soft`、用 deck 的 `row` 步直接写死 U1 文本（那是夹具自造行，属实空绿）、或加一个「等超时再看一眼」的轮询把丢句掩盖成真空绿。X-1 的可见处置腿在 2026-10-13 裁定后已是直接断言（spec 文件头第 50-55 行），本任务不得把它退回 known-defect。

<!-- dedup-ref -->
**与在飞任务的关系（separate）**：`gap-voice-proxy-holds-one-merged-pending-message`（当前 `ready`，`goal_ac: null`）会改「忙时排队 / 空闲时一次投递」的**代理侧**语义，与本任务同一片区域但机制不同（代理持有一条合并消息 vs 连续体验 e2e 夹具的忙窗口吞掉转发行）。本任务只要求在**当前**代码上让 AC-361 判据确定性绿，不依赖也不阻塞该任务。若该任务先落地、忙时投递语义随之改变，本 spec 的可见处置期望需按新投影重新核对（同类重锚已有先例：`gap-live-voice-continuous-experience-spec-realign-*`）。

## AC

- [ ] AC1 AC-361 的判据命令**连续 3 次各自退出 0**，逐次读数（每次的 pass/fail 计数）写入 `## 验证读数`。命令逐字同上（`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 单跑；server 侧文件应保持 13 pass / 0 fail）。
- [ ] AC2 **非真空守卫**：以 `QUAY_CONTINUOUS_EXPERIENCE_DUMP=<file>` 跑一次后，`jq -r '.transcript.rows[] | select(.style=="user" and .testid==null) | .text' <file>` 的输出里 `把 server 的日志贴出来` 与 `我想想然后跑一下测试` **各恰一次**；且该次 `jq -c '.fold' <file>` 显示读取时待落地的话已在屏（腿不是读到一个还没到位的快照而恰好通过）。读数记入 `## 验证读数`。
- [ ] AC3 **直接断言未被削弱**：`grep -nE "voiceRealtimeKnownDefect|test\.fail|test\.skip|expect\.soft" e2e/voice-realtime-continuous-experience.spec.ts` 无输出（退出 1）；且 1038-1039 那条断言仍要求 U1 行恰一次、`style === 'user'`、`testid === null`。
- [ ] AC4 **反向读数（假形态）**：把「让首个转发落进忙窗口」的形态复原（例如回退时序/重排改动，或临时把 U1 的送达推回 `turn-end` 之前且不建模 drain）后单跑该 spec，X-1 那条腿**必须红**；复现的报错原文与恢复后的绿读数都记入 `## 验证读数`（防止用恒真方式过关）。

## DoD

在仓库当前代码上，AC-361 的判据命令可重复地（连续 3 次）全绿：fake mic 固定时间线走当前 continuous 代码路径跑完，X-1 的可见处置表里每个 **forwarded** 的 utterance 都在对话区有一行真实 user 行（U1 与合并的 U3+U4 各恰一次、无「语音专用」标记），沉默 / 打断的处置仍按既有裁定直接断言，执行面 `busy→idle` 交替仍从 dock 读数可读；且没有任何 known-defect / skip / soft 或夹具自造行把这条腿变成真空绿。若最终采用的是假体侧的 drain 建模（改 `server/modules/debug-agent/`），该改动同样满足上述读数。

## Touches

- e2e/voice-realtime-continuous-experience.spec.ts
- e2e/voiceRealtimeFakeMic.ts
- e2e/voiceRealtimeScriptedUpstream.ts
- server/modules/debug-agent/debug-agent.provider.ts
- server/modules/debug-agent/debug-agent.host-driver.ts
- tasks/gap-continuous-experience-busy-window-swallows-forward-row.md
